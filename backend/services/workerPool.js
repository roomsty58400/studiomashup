import { spawn } from "child_process";

// ── Worker Python persistant (audit perf juillet 2026 : "vraie architecture
// optimisée pour le calcul") ──────────────────────────────────────────────
// Constat : services/demucs.js, analyzer.js et dereverb.js lancent tous un
// PROCESS PYTHON NEUF à chaque appel (spawn). Chaque nouveau process paie :
//   - le démarrage de l'interpréteur Python lui-même,
//   - l'import de torch (souvent 1-3s à lui seul) et/ou librosa,
//   - pour Demucs/dé-reverb : le RECHARGEMENT du modèle depuis le disque vers
//     la RAM/VRAM (htdemucs_ft = 4 modèles bagués, donc 4x ce coût),
//   - pour Librosa : la recompilation JIT (numba) de beat_track à froid —
//     numba met en cache les fonctions compilées PAR PROCESS, donc ce coût
//     revient intégralement à chaque nouveau process, jamais amorti.
// Un worker PERSISTANT (ce module) ne paie tout ça QU'UNE FOIS au démarrage,
// puis traite tous les jobs suivants avec le modèle déjà chaud en mémoire —
// gain net à chaque appel après le premier, potentiellement plusieurs
// secondes voire dizaines de secondes par appel selon la machine.
//
// Protocole : JSON délimité par des sauts de ligne sur stdin/stdout (simple,
// sans dépendance, robuste aux gros payloads car un seul objet par ligne).
// Le worker Python émet {"type":"ready",...} une fois ses imports/modèle
// chargés, puis {"id":N,"ok":true/false,"result"/"error":...} pour chaque
// job reçu (même id que la requête).
//
// SÉCURITÉ / repli : si le worker ne démarre pas (dépendance Python absente,
// API demucs différente selon la version installée, etc.), `call()` rejette
// et c'est à l'APPELANT (demucs.js/analyzer.js/dereverb.js) de retomber sur
// l'ancien mode "un process par appel", déjà éprouvé — jamais l'inverse. Ce
// module ne fait donc AUCUNE hypothèse forte sur la fiabilité du worker : au
// moindre pépin (échec démarrage, crash en cours de route, timeout), il
// abandonne proprement plutôt que de laisser l'appelant dans un état incertain.
export class PersistentWorker {
  // "env" (optionnel) : variables d'environnement additionnelles à fusionner
  // avec process.env pour CE worker uniquement — ajouté pour l'analyseur
  // BPM/clé (backend/pyworkers/analyzer_worker.py), qui a besoin de
  // NUMBA_DISABLE_JIT=1 UNIQUEMENT quand la commande Python résolue est la
  // 3.14 "à problèmes" (cf. analyzer.js/resolvePythonCmd) — Demucs n'a
  // jamais eu besoin de ce réglage, d'où l'absence historique de cette
  // option. undefined par défaut = comportement inchangé (héritage pur de
  // process.env).
  constructor(pythonBin, args, { name = "worker", readyTimeoutMs = 60000, env = undefined } = {}) {
    this.pythonBin = pythonBin;
    this.args = args;
    this.name = name;
    this.readyTimeoutMs = readyTimeoutMs;
    this.env = env;
    this.proc = null;
    this.readyPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = "";
    // Passe à true dès qu'UN échec de démarrage a été constaté — évite de
    // retenter en boucle un worker qui ne fonctionnera manifestement jamais
    // dans cet environnement (ex: package Python absent) : chaque appel
    // suivant échoue alors instantanément (repli immédiat côté appelant) au
    // lieu de retenter un spawn + timeout complet à chaque fois.
    this.permanentlyUnavailable = false;
  }

  _start() {
    if (this.proc || this.permanentlyUnavailable) return;
    this.stdoutBuffer = "";
    let proc;
    try {
      proc = spawn(this.pythonBin, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env ? { ...process.env, ...this.env } : process.env,
      });
    } catch (e) {
      this.permanentlyUnavailable = true;
      this.readyPromise = Promise.reject(e);
      this.readyPromise.catch(() => {});
      return;
    }
    this.proc = proc;

    proc.stderr.on("data", (d) => process.stderr.write(`[worker:${this.name}] ${d}`));

    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`worker "${this.name}" : timeout de démarrage (${this.readyTimeoutMs}ms)`));
      }, this.readyTimeoutMs);

      const onReadyData = (chunk) => {
        this.stdoutBuffer += chunk.toString();
        let idx;
        while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.stdoutBuffer.slice(0, idx);
          this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "ready") {
            clearTimeout(timer);
            proc.stdout.off("data", onReadyData);
            proc.stdout.on("data", (c) => this._handleData(c));
            resolve(msg);
            return;
          }
          if (msg.type === "fatal") {
            clearTimeout(timer);
            reject(new Error(`worker "${this.name}" : ${msg.error || "échec initialisation"}`));
            return;
          }
        }
      };
      proc.stdout.on("data", onReadyData);
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`worker "${this.name}" : process terminé prématurément (code ${code})`));
      });
    }).catch((e) => {
      // Marque le worker comme définitivement indisponible pour CE process
      // Node — un worker qui échoue à démarrer une fois (dépendance absente,
      // incompatibilité) échouera de la même façon à chaque tentative.
      this.permanentlyUnavailable = true;
      throw e;
    });
    this.readyPromise.catch(() => {}); // évite une "unhandledRejection" si jamais appelée avant call()

    proc.on("exit", () => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`worker "${this.name}" : process terminé en cours de traitement`));
      }
      this.pending.clear();
      this.proc = null;
    });
  }

  _handleData(chunk) {
    this.stdoutBuffer += chunk.toString();
    let idx;
    while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error || `worker "${this.name}" : erreur inconnue`));
    }
  }

  // Envoie un job et attend sa réponse. Rejette (sans jamais planter le
  // process appelant) si le worker est indisponible, plante, ou dépasse
  // `timeoutMs` — charge à l'appelant de retomber sur son ancien mode.
  async call(payload, timeoutMs = 1800000) {
    if (this.permanentlyUnavailable) {
      throw new Error(`worker "${this.name}" indisponible (échec de démarrage précédent)`);
    }
    this._start();
    await this.readyPromise;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker "${this.name}" : timeout d'appel (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    });
  }

  // Arrêt propre — appelé depuis server.js à la fermeture du backend (même
  // logique que cleanupAndExit pour les fichiers média).
  shutdown() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }
}

// Registre des workers actifs, pour un arrêt groupé propre depuis server.js.
const activeWorkers = new Set();
export const registerWorker = (worker) => { activeWorkers.add(worker); return worker; };
export const shutdownAllWorkers = () => { for (const w of activeWorkers) w.shutdown(); };
