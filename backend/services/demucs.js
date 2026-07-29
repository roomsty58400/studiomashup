import { spawn } from "child_process";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import os from "os";
import { runGpuExclusive } from "./gpuQueue.js";
import { PersistentWorker, registerWorker } from "./workerPool.js";
import { createPythonResolver, validateImport } from "./pythonResolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Interpréteur Python utilisé pour Demucs — configurable via DEMUCS_PYTHON
// (même principe que DEREVERB_PYTHON dans services/dereverb.js, qui pointe
// déjà vers un venv dédié C:\audio-separator-env\Scripts\python.exe).
// Par défaut "python" (celui du PATH système) — si CE python n'a pas torch
// installé avec le support CUDA (souvent le cas : torch CPU-only par défaut
// via pip install torch, le build CUDA nécessite l'index PyTorch dédié),
// Demucs tournera en CPU même si la carte graphique fonctionne par ailleurs
// (ex: NVENC utilisable par ffmpeg) — c'est 2 piles logicielles indépendantes.
// Si un autre environnement Python a torch+CUDA (par ex. le même venv que
// DEREVERB_PYTHON, ou un autre dédié), pointer DEMUCS_PYTHON vers lui dans
// backend/.env permet à Demucs d'utiliser le GPU.
//
// ── Résolution automatique (audit perf juillet 2026) ─────────────────────
// Même bug que documenté et corrigé dans analyzer.js (resolvePythonCmd) :
// "python" sur le PATH dépend de LA FENÊTRE qui a lancé "npm run dev", pas
// d'une propriété globale de la machine. Constaté en pratique : le worker
// Demucs persistant (services/workers/demucs_worker.py) échouait
// SYSTÉMATIQUEMENT au démarrage avec "ModuleNotFoundError: No module named
// 'demucs.api'", alors qu'un `pip show demucs` dans un terminal fraîchement
// ouvert confirmait demucs 4.1.0 correctement installé AVEC demucs.api
// disponible (`from demucs.api import Separator` fonctionne). Seule
// explication cohérente : le process Node (qui hérite du PATH de SA fenêtre
// de lancement) et un terminal ouvert à la main ne résolvent pas le même
// exécutable "python" — exactement le même phénomène que celui déjà
// diagnostiqué pour Librosa/numba côté analyzer.js, jamais corrigé ici.
// Conséquence concrète : le worker persistant ne démarrait JAMAIS, et TOUTE
// séparation payait le rechargement complet du modèle depuis le disque à
// chaque appel (le coût que le worker est censé éliminer).
//
// On teste donc plusieurs candidats (même liste que resolvePythonCmd) et on
// retient le PREMIER qui a RÉELLEMENT torch + demucs.api importables — pas
// seulement "--version" comme dans analyzer.js, puisque le problème ici est
// spécifiquement l'environnement des paquets installés, pas la simple
// présence de l'interpréteur. Résultat mis en cache (comme resolvePythonCmd),
// sauf si DEMUCS_PYTHON est explicitement fourni (override manuel prioritaire,
// jamais réévalué). Mécanisme générique factorisé dans services/pythonResolver.js
// (audit perf juillet 2026 — auparavant dupliqué avec analyzer.js).
const resolveDemucsPython = createPythonResolver({
  candidates: ["python", "py -3.12", "py -3.11", "py -3", "python3"],
  envOverride: "DEMUCS_PYTHON",
  validate: validateImport("from demucs.api import Separator; import torch", 15000),
  label: "[demucs]",
});

// ── Modes de séparation sélectionnables (2 / 4 stems) ───────────────────────
// Demande explicite (juillet 2026) : proposer un bouton de choix entre
// plusieurs modes plutôt qu'un modèle fixe :
//  - "2" (voix + instrumental complet) : le mashup classique, le plus rapide.
//  - "4" (voix/batterie/basse/autres)  : mode "standard", qualité éprouvée
//    (audit rave.dj) — modèle "htdemucs_ft", bag de 4 modèles fine-tunés.
// Un mode "6" (+ guitare/piano, modèle "htdemucs_6s" single model) a existé
// mais a été RETIRÉ (retour utilisateur, juillet 2026) : ce modèle est
// documenté par les auteurs de Demucs eux-mêmes comme moins abouti (plus de
// bruit/bleed, y compris sur voix/batterie/basse qui restent propres en mode
// 4) — un compromis qui n'en valait pas la peine dans l'app.
// Chaque mode a son propre modèle (configurable indépendamment via les
// variables d'env ci-dessous) — le mode "2" et le mode "4" partagent le même
// modèle par défaut ("htdemucs_ft" = la meilleure qualité connue pour ces
// stems), seul le drapeau --two-stems change ce qui est écrit sur le disque.
export const MODEL_2STEMS = process.env.DEMUCS_MODEL_2 || "htdemucs_ft";
export const MODEL_4STEMS = process.env.DEMUCS_MODEL_4 || "htdemucs_ft";

// Noms de pistes attendus en sortie de séparateStemsFull pour chaque mode —
// utilisé à la fois ici (vérification worker/disque) et dans
// routes/analyze.js (stemsUsable, qui exige TOUTES ces pistes sur le disque).
export const STEM_MODE_NAMES = {
  4: ["vocals", "drums", "bass", "other"],
};

const modelForFullMode = () => MODEL_4STEMS;

// ── Worker Demucs persistant (audit perf juillet 2026) ──────────────────────
// "Vraie architecture optimisée pour le calcul" : au lieu de relancer un
// process Python neuf (import torch + rechargement du modèle depuis le
// disque) à CHAQUE séparation, un unique process persistant garde le modèle
// chargé en RAM/VRAM en permanence (cf. services/workerPool.js et
// services/workers/demucs_worker.py).
//
// RÉACTIVÉ PAR DÉFAUT (opt-out via DEMUCS_WORKER=0 dans backend/.env si
// besoin) : ce worker avait été désactivé par précaution après un retour
// utilisateur "le mashup final superpose le même flac pour les 2 pistes" —
// mais une investigation complète (plusieurs sessions, relecture ligne par
// ligne de mixFullRave/mixFullRaveDuo, audit du cache disque, des chemins de
// stems, et finalement de la lecture côté navigateur) a fini par identifier
// 2 causes réelles, TOUTES DEUX SANS RAPPORT avec ce worker : 1) des
// téléchargements yt-dlp parallèles qui se marchaient dessus (déjà corrigé,
// cf. le revert séquentiel A→B plus bas dans routes/mashup.js), et 2) le
// lecteur YouTube du Deck resté audible pendant la lecture du mashup final
// (corrigé côté Mixer.jsx, onPauseDecks). Le worker lui-même n'a jamais
// démontré de résultat faux. Le garder désactivé ne faisait que payer, à
// CHAQUE séparation, le rechargement complet du modèle "htdemucs_ft" (bag de
// 4 modèles fine-tunés) depuis le disque vers le GPU — potentiellement
// plusieurs dizaines de secondes à chaque fois — pour rien : avec le worker,
// ce chargement n'a lieu qu'UNE SEULE FOIS au démarrage du serveur, et
// chaque séparation suivante ne paie plus que le temps de calcul réel du
// modèle. tryWorkerSeparate garde son repli automatique vers l'ancien mode
// "un process par appel" en cas d'échec du worker (démarrage ou erreur),
// donc aucune régression de fiabilité si l'environnement Python ne convient
// pas (dépendance manquante, etc.).
const WORKER_ENABLED = process.env.DEMUCS_WORKER !== "0";
let _demucsWorker = null;
const getDemucsWorker = async () => {
  if (_demucsWorker) return _demucsWorker;
  const pythonCmd = await resolveDemucsPython();
  const [bin, ...extraArgs] = pythonCmd.split(" ");
  const scriptPath = join(__dirname, "workers", "demucs_worker.py");
  _demucsWorker = registerWorker(new PersistentWorker(bin, [...extraArgs, scriptPath], {
    name: "demucs", readyTimeoutMs: 90000, // le 1er chargement du modèle peut prendre du temps
  }));
  return _demucsWorker;
};

// Tente la séparation via le worker persistant. Renvoie null (jamais ne
// lève) si le worker est indisponible ou échoue — l'appelant retombe alors
// sur runWithGpuFallback ci-dessous, sans que le job échoue pour autant.
//
// "model" est maintenant transmis À CHAQUE appel (au lieu d'un modèle fixe
// chargé une fois pour toute la durée du process) — nécessaire depuis
// l'ajout du sélecteur 2/4 stems, qui peut demander un modèle différent
// d'un morceau à l'autre. Le worker Python (demucs_worker.py) recharge son
// modèle UNIQUEMENT quand il diffère du dernier chargé, donc changer de mode
// ne paie le rechargement (plusieurs secondes/dizaines de secondes) que
// lors d'un vrai changement, pas à chaque appel.
const tryWorkerSeparate = async (wavPath, outputDir, { fullStems, model }) => {
  if (!WORKER_ENABLED) return null;
  // Chrono explicite (audit perf juillet 2026, shifts=0 + fp16 + worker
  // persistant) — permet de COMPARER concrètement le temps de séparation
  // d'un appel à l'autre dans les logs serveur, sans outil externe. Le tout
  // 1er appel après démarrage inclut le chargement du modèle (normal, plus
  // long) ; les appels suivants dans le même mode montrent le vrai gain.
  const t0 = Date.now();
  try {
    const worker = await getDemucsWorker();
    const result = await runGpuExclusive(() => worker.call({ wavPath, outputDir, fullStems, model }));
    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[demucs] ⏱ séparation via worker persistant (modèle "${model}") — ${fullStems ? "stems complets" : "2 stems"} — ${elapsedS}s`);
    return result;
  } catch (e) {
    console.warn(`[demucs] worker persistant indisponible, repli sur le mode process-par-appel : ${e.message}`);
    return null;
  }
};

// Détection rapide et explicite du GPU (CUDA) via torch, AVANT de lancer
// Demucs — plutôt que de lancer tout le traitement en "cuda" et catcher
// l'échec après coup.
//
// Timeout relevé 8s → 25s (audit perf juillet 2026, log constaté en pratique :
// "GPU CUDA détecté" sur un appel puis "aucun GPU détecté" sur l'appel
// suivant, avec repli CPU nettement plus lent — parfois suivi d'un crash
// Demucs) : ce check spawn un process Python TOUT NEUF à chaque appel, qui
// doit réimporter torch et initialiser un contexte CUDA à froid — sous
// contention CPU (ex: le repli CPU d'un appel précédent tournant encore sur
// 6 coeurs, cf. cpuJobs() plus bas, ou l'analyzer worker Librosa actif en
// parallèle), cet import peut légitimement dépasser 8s sans que le GPU soit
// réellement absent. Un faux négatif ici coûte bien plus cher (minutes en
// CPU au lieu de secondes en GPU) que les quelques secondes de marge
// supplémentaires accordées par ce timeout plus généreux.
const detectCuda = async () => {
  const pythonCmd = await resolveDemucsPython();
  const [bin, ...extraArgs] = pythonCmd.split(" ");
  return new Promise((resolve) => {
    const proc = spawn(bin, [...extraArgs, "-c", "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)"]);
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, 25000);
    proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    proc.on("error", () => { clearTimeout(timer); resolve(false); });
  });
};

// Nombre de jobs parallèles pour Demucs en CPU (-j) : répartit le calcul sur
// plusieurs coeurs, gain de vitesse important sur les machines multi-coeurs.
// On laisse toujours 1 coeur de marge pour le serveur Node / le système, et
// on plafonne à 6 (gains marginaux au-delà, pour ce type de traitement).
// N.B. : on reste sur le modèle par défaut "htdemucs" — les variantes "_q"
// (quantizées, ex. mdx_extra_q) nécessitent le package optionnel "diffq",
// absent par défaut, ce qui fait échouer Demucs à 100% si on s'en sert sans
// l'installer explicitement.
const cpuJobs = () => Math.max(1, Math.min(os.cpus().length - 1, 6));

// Lance une seule passe de Demucs avec le device demandé ("cuda" ou "cpu").
//
// "full" (4 stems vocals/drums/bass/other) vs "--two-stems=vocals" (2 stems) :
// IMPORTANT pour la VRAM (RTX 2060, 6 Go) — Demucs calcule TOUJOURS les 4
// sources en interne, que la sortie soit "deux stems" ou complète ;
// "--two-stems" ne fait que recombiner drums+bass+other en un seul fichier
// "no_vocals" APRÈS le calcul. La consommation GPU est donc IDENTIQUE dans
// les deux cas — passer en 4 stems n'augmente pas le risque d'OOM, ça change
// juste ce qui est écrit sur le disque à la fin.
const runDemucs = async (wavPath, outputDir, device, { fullStems = false, model } = {}) => {
  const pythonCmd = await resolveDemucsPython();
  const [bin, ...extraArgs] = pythonCmd.split(" ");
  // Utiliser flac qui n'a pas besoin de torchcodec
  const args = [
    ...extraArgs,
    "-m", "demucs",
    "-n", model,
    ...(fullStems ? [] : ["--two-stems=vocals"]),
    "--flac",
    "-d", device,
  ];

  if (device === "cpu") {
    args.push("-j", String(cpuJobs()));
  }

  args.push("-o", outputDir, wavPath);

  return new Promise((resolve, reject) => {
  const proc = spawn(bin, args);
  let stderr = "";

  proc.stdout.on("data", d => process.stdout.write(d));
  proc.stderr.on("data", d => {
    process.stderr.write(d);
    stderr += d.toString();
  });

  // 30min (au lieu de 15) : "htdemucs_ft" (4 modèles bagués) prend ~4x plus
  // de temps que le "htdemucs" simple, surtout sensible en repli CPU.
  const timer = setTimeout(() => {
    proc.kill();
    reject(new Error("Demucs timeout (30min)"));
  }, 1800000);

  proc.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return reject(new Error(`Demucs failed (code ${code}): ${stderr.slice(-300)}`));
    resolve();
  });

  proc.on("error", (err) => {
    clearTimeout(timer);
    reject(new Error(`Demucs spawn error: ${err.message}`));
  });
  });
};

// Détecte le GPU une bonne fois avant de lancer le traitement (plutôt que de
// tenter "cuda" à l'aveugle et catcher l'échec après coup) et, en repli CPU,
// parallélise le calcul sur plusieurs coeurs (-j) — sans dépendance externe
// supplémentaire — pour réduire le temps de séparation voix/instru.
//
// Repli GPU → CPU automatique en cas d'échec (OOM VRAM compris, puisque
// n'importe quelle erreur du process Python — y compris un
// "CUDA out of memory" de PyTorch — déclenche le catch) : sur une RTX 2060
// (6 Go), un morceau anormalement long/dense qui dépasserait la VRAM
// disponible retombe simplement sur le CPU plutôt que de planter le job.
const runWithGpuFallback = async (wavPath, outputDir, opts) => {
  const t0 = Date.now();
  const hasCuda = await detectCuda();
  if (hasCuda) {
    console.log("[demucs] GPU CUDA détecté — séparation en GPU");
    try {
      await runDemucs(wavPath, outputDir, "cuda", opts);
      console.log(`[demucs] ⏱ séparation process-par-appel (GPU) — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    } catch (e) {
      console.warn("[demucs] échec en GPU (OOM VRAM ou autre), repli sur le CPU :", e.message?.split("\n")[0]);
    }
  } else {
    console.log(`[demucs] aucun GPU détecté — séparation en CPU (${cpuJobs()} coeurs en parallèle)`);
  }
  await runDemucs(wavPath, outputDir, "cpu", opts);
  console.log(`[demucs] ⏱ séparation process-par-appel (CPU) — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};

// Demucs écrit toujours dans un sous-dossier nommé d'après le modèle utilisé
// (ex: outputDir/htdemucs_ft/<basename>/) — doit donc suivre le modèle
// RÉELLEMENT utilisé pour cet appel (passé en paramètre depuis l'ajout du
// sélecteur 2/4 stems, chaque mode pouvant utiliser un modèle différent),
// sinon les fichiers de sortie deviennent introuvables.
const stemsOutputDir = (wavPath, outputDir, model) => {
  const baseName = wavPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  return join(outputDir, model, baseName);
};

const findExisting = (stemsDir, name) => {
  for (const ext of [".flac", ".mp3", ".wav"]) {
    const p = join(stemsDir, `${name}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
};

// ── 2 stems (voix / instrumental) — mode "2" du sélecteur, utilisé par
// ClipEditor et les Decks A/B pour le mashup classique. ─────────────────────
export const separateStems = async (wavPath, outputDir, model = MODEL_2STEMS) => {
  mkdirSync(outputDir, { recursive: true });

  // Chemin rapide : worker persistant (modèle déjà chargé, cf. plus haut).
  const viaWorker = await tryWorkerSeparate(wavPath, outputDir, { fullStems: false, model });
  if (viaWorker) return { vocals: viaWorker.vocals, instrumental: viaWorker.no_vocals };

  // Repli : ancien mode "un process par appel" (runGpuExclusive sérialise
  // UNIQUEMENT cet appel GPU par rapport aux autres appels Demucs/dé-reverb
  // en cours ailleurs — cf. services/gpuQueue.js — le reste de l'appelant
  // n'est pas concerné par cette file et peut tourner en parallèle).
  await runGpuExclusive(() => runWithGpuFallback(wavPath, outputDir, { fullStems: false, model }));

  const stemsDir = stemsOutputDir(wavPath, outputDir, model);
  const vocals = findExisting(stemsDir, "vocals");
  const instrumental = findExisting(stemsDir, "no_vocals");

  if (!vocals || !instrumental) {
    throw new Error(`Stems introuvables dans ${stemsDir}`);
  }

  console.log(`✅ Stems: ${vocals}`);
  return { vocals, instrumental };
};

// ── Stems complets — modes "4" (voix/batterie/basse/autres) et "6" (+
// guitare/piano) du sélecteur, utilisés par le moteur d'analyse/scoring
// (routes/analyze.js) pour reconstruire un instrumental "à la carte" (ex:
// batterie+basse du morceau B, harmonies du morceau A) plutôt que de ne
// jamais pouvoir toucher qu'à voix/instru en bloc.
// "mode" : toujours 4 depuis le retrait du mode 6 stems (juillet 2026) —
// paramètre conservé pour compatibilité d'appel, mais normalisé ici quoi
// qu'il arrive. Détermine le modèle Demucs utilisé (cf. modelForFullMode) et
// les pistes attendues en sortie (cf. STEM_MODE_NAMES).
export const separateStemsFull = async (wavPath, outputDir, mode = 4) => {
  mkdirSync(outputDir, { recursive: true });
  const numMode = 4;
  const model = modelForFullMode(numMode);
  const names = STEM_MODE_NAMES[numMode];

  // Chemin rapide : worker persistant.
  const viaWorker = await tryWorkerSeparate(wavPath, outputDir, { fullStems: true, model });
  if (viaWorker && names.every(n => viaWorker[n])) {
    const result = {};
    for (const n of names) result[n] = viaWorker[n];
    return result;
  }

  // Repli : ancien mode "un process par appel" — cf. commentaire dans
  // separateStems ci-dessus (même file GPU partagée).
  await runGpuExclusive(() => runWithGpuFallback(wavPath, outputDir, { fullStems: true, model }));

  const stemsDir = stemsOutputDir(wavPath, outputDir, model);
  const result = {};
  for (const n of names) result[n] = findExisting(stemsDir, n);

  if (names.some(n => !result[n])) {
    throw new Error(`Stems (${numMode} pistes, modèle "${model}") introuvables dans ${stemsDir}`);
  }

  console.log(`✅ Stems complets (${numMode} pistes, "${model}"): ${stemsDir}`);
  return result;
};
