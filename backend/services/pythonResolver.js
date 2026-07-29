import { spawn, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ── Résolveur de commande Python — factorisé (audit perf juillet 2026) ──────
// Deux implémentations quasi identiques existaient jusqu'ici en parallèle
// (analyzer.js::resolvePythonCmd, demucs.js::resolveDemucsPython), nées du
// même constat documenté aux deux endroits : "python" sur le PATH dépend de
// LA FENÊTRE qui a lancé "npm run dev", pas d'une propriété globale de la
// machine — le PATH effectif varie selon la fenêtre/l'ordre d'installation.
// Symptôme observé aux 2 endroits : une commande qui fonctionne dans un
// terminal ouvert à la main échoue silencieusement depuis le process serveur
// (import manquant, dépendance absente) sans qu'aucun message ne l'explique.
//
// Ce module centralise le mécanisme (essayer plusieurs candidats dans l'ordre,
// retenir + mettre en cache le premier valide, ne jamais lever) — chaque
// appelant choisit sa propre liste de candidats et sa propre méthode de
// validation, qui peuvent différer légitimement :
//  - analyzer.js n'a besoin de vérifier que la PRÉSENCE d'un interpréteur
//    (--version suffit, cf. validateVersion) ;
//  - demucs.js doit vérifier qu'un PAQUET précis est réellement importable
//    dans cet interpréteur (cf. validateImport — le bug corrigé "demucs.api
//    manquant" ne se serait jamais vu avec un simple --version, l'interpréteur
//    étant parfaitement valide, seul le paquet posait problème).

/**
 * Fabrique un résolveur : `resolvePython()` teste `candidates` dans l'ordre
 * (via `validate`) et retient le premier qui passe, résultat mis en cache
 * pour tous les appels suivants. Ne lève jamais — en dernier recours, retombe
 * sur le premier candidat (produira une erreur claire à l'usage plutôt qu'un
 * échec silencieux ici).
 *
 * @param {string[]} candidates - commandes à essayer dans l'ordre, ex. ["py -3.12", "python"]
 * @param {(bin: string, extraArgs: string[]) => Promise<boolean>} validate - teste un candidat, ne doit jamais rejeter
 * @param {string} [envOverride] - nom d'une variable d'env qui, si définie, court-circuite toute détection (jamais réévaluée, jamais validée — override manuel assumé)
 * @param {string} [label] - préfixe des logs, ex. "[analyzer]"
 */
export function createPythonResolver({ candidates, validate, envOverride, label = "[python]" }) {
  let resolved = null;
  return async function resolvePython() {
    if (envOverride && process.env[envOverride]) return process.env[envOverride];
    if (resolved !== null) return resolved;

    for (const cmd of candidates) {
      const [bin, ...extraArgs] = cmd.split(" ");
      const ok = await validate(bin, extraArgs).catch(() => false);
      if (ok) {
        resolved = cmd;
        console.log(`${label} commande Python détectée et retenue : "${cmd}"`);
        return resolved;
      }
    }
    console.error(`${label} ❌ Aucune commande Python valide trouvée parmi : ${candidates.join(", ")}.`);
    resolved = candidates[0] || "python"; // repli — produira une erreur claire à l'exécution
    return resolved;
  };
}

// ── Validateur "léger" ── la commande répond simplement à --version. Suffit
// quand le problème est la PRÉSENCE de l'interpréteur sur le PATH (cf.
// analyzer.js : "python"/"py -3" existent mais pointent vers une version de
// Python trop récente pour numba — le choix se fait alors sur LA VERSION,
// pas sur des paquets manquants).
export const validateVersion = (timeoutMs = 5000) => (bin, extraArgs) =>
  execAsync(`${[bin, ...extraArgs].join(" ")} --version`, { timeout: timeoutMs }).then(() => true, () => false);

// ── Validateur "strict" ── exécute un snippet Python (ex. un import) et
// vérifie le code de sortie. Nécessaire quand l'interpréteur lui-même est
// valide mais qu'un PAQUET précis peut manquer dans CET environnement (cf.
// demucs.js : "python" existe et fonctionne, mais l'environnement résolu par
// le process Node peut différer de celui vu dans un terminal ouvert à la
// main, où le paquet est pourtant bien installé).
export const validateImport = (pythonCode, timeoutMs = 15000) => (bin, extraArgs) => new Promise((resolve) => {
  let proc;
  try {
    proc = spawn(bin, [...extraArgs, "-c", pythonCode]);
  } catch {
    return resolve(false);
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    proc.kill();
    resolve(false);
  }, timeoutMs);
  proc.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(code === 0);
  });
  proc.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(false);
  });
});
