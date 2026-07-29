import { spawn, execSync } from "child_process";
import { mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runGpuExclusive } from "./gpuQueue.js";
import { PersistentWorker, registerWorker } from "./workerPool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Suppression d'écho/réverb sur une piste vocale isolée (sortie de Demucs)
// via un modèle IA dédié (UVR DeEcho-DeReverb) — bien plus efficace qu'un
// simple filtre ffmpeg pour "sécher" une voix (utile avant un voice swap,
// ex. Kits.ai, qui donne de meilleurs résultats sur une voix sans traîne de
// réverb). Fourni par le package Python "audio-separator"
// (pip install "audio-separator[gpu]" ou "[cpu]") — le modèle (~100 Mo) est
// téléchargé automatiquement par le package au premier lancement.
const MODEL = "UVR-DeEcho-DeReverb.pth";

// "audio-separator" a une dépendance (diffq-fixed) sans wheel précompilé
// pour les versions de Python trop récentes (ex. 3.14) — installé à la place
// dans un environnement virtuel Python 3.12 dédié. Configurable via
// DEREVERB_PYTHON (backend/.env) si jamais ce chemin change.
const PYTHON_BIN = process.env.DEREVERB_PYTHON || "C:\\audio-separator-env\\Scripts\\python.exe";

// ── Détection CUDA pour audio-separator (audit juillet 2026) ────────────────
// Constat : contrairement à services/demucs.js (qui détecte explicitement le
// GPU et journalise le chemin emprunté), cet appel ne passait AUCUN indicateur
// de device à audio-separator — le package tourne alors sur son défaut, qui
// est le CPU (le flag CLI "--use_cuda" a pour valeur par défaut False dans ce
// package), et ce SANS AUCUNE trace dans les logs permettant de le remarquer.
// Le dé-reverb (modèle UVR-DeEcho-DeReverb, un réseau de neurones comme
// Demucs) tourne donc potentiellement en CPU sur une machine qui a pourtant un
// GPU CUDA disponible et utilisé par ailleurs (Demucs, NVENC) — nettement plus
// lent qu'un passage GPU, pour un modèle qui tourne au moins une fois par
// piste dans la chaîne "FULL RAVE".
// Testé une seule fois (résultat mis en cache, même principe que hasRubberband
// dans ffmpeg.js et detectCuda dans demucs.js) sur LE PYTHON_BIN de CE venv
// dédié (C:\audio-separator-env) — le fait que Demucs voie un GPU CUDA ne
// garantit pas que CE venv-ci ait torch+CUDA installés (2 environnements
// Python indépendants, cf. commentaire sur DEMUCS_PYTHON dans demucs.js).
// Timeout relevé 8s → 25s (même correctif et même raisonnement que
// detectCuda dans services/demucs.js, audit perf juillet 2026) : un process
// Python neuf qui réimporte torch + initialise CUDA à froid peut dépasser 8s
// sous contention CPU, ce qui faisait basculer ce check en CPU (repli
// silencieux, cf. commentaire ci-dessus "SANS AUCUNE trace dans les logs")
// alors que le GPU était en réalité disponible.
let _hasCudaDereverb = null;
const detectCudaDereverb = () => {
  if (_hasCudaDereverb !== null) return _hasCudaDereverb;
  try {
    execSync(`"${PYTHON_BIN}" -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)"`, { timeout: 25000, stdio: "ignore" });
    _hasCudaDereverb = true;
  } catch {
    _hasCudaDereverb = false;
  }
  console.log(`[dereverb] CUDA (venv ${PYTHON_BIN}): ${_hasCudaDereverb ? "✅ disponible — activation --use_cuda" : "❌ indisponible — repli CPU"}`);
  return _hasCudaDereverb;
};

// Dossier de cache du modèle, explicite plutôt que de laisser audio-separator
// utiliser son défaut ("/tmp/audio-separator-models/", une notation Unix qui
// peut mal se résoudre sous Windows — chemin ambigu/non garanti accessible
// en écriture). En le fixant nous-mêmes, le modèle (~100 Mo) n'est téléchargé
// qu'une seule fois et reste réutilisable entre tous les jobs.
const MODEL_DIR = join(__dirname, "../data/audio-separator-models");
mkdirSync(MODEL_DIR, { recursive: true });

// La convention de nommage UVR pour ce modèle distingue généralement
// "no echo" (voix sèche, ce qu'on veut garder) de "echo" (le résidu retiré).
const isCleanFile = (name) => /no[\s_-]?echo|no[\s_-]?reverb|dry/i.test(name);
const isWetFile = (name) => /echo|reverb/i.test(name) && !isCleanFile(name);

// Identifie le fichier "sans écho" dans un dossier de sortie déjà rempli —
// factorisé (audit perf juillet 2026) : cette logique était dupliquée telle
// quelle entre le mode CLI et le nouveau mode worker persistant ci-dessous,
// les deux produisant le même genre de sortie (2 fichiers, "clean"/"wet")
// dans le même dossier.
const pickCleanFile = (outputDir, sourceLabel) => {
  const files = readdirSync(outputDir);
  if (files.length === 0) {
    throw new Error(`${sourceLabel} n'a produit aucun fichier dans ${outputDir}`);
  }
  let clean = files.find(isCleanFile);
  if (!clean) {
    // Motif non reconnu : par élimination, on prend le fichier qui ne
    // contient ni "echo" ni "reverb" dans son nom.
    clean = files.find(f => !isWetFile(f) && !/echo|reverb/i.test(f));
  }
  if (!clean && files.length >= 2) {
    console.warn("[dereverb] motif de nom non reconnu parmi :", files, "— repli sur le fichier le plus volumineux");
    clean = files
      .map(f => ({ f, size: statSync(join(outputDir, f)).size }))
      .sort((a, b) => b.size - a.size)[0].f;
  }
  if (!clean) throw new Error(`Impossible d'identifier le fichier "sans écho" parmi : ${files.join(", ")}`);
  return join(outputDir, clean);
};

// ── Worker dé-reverb persistant (audit perf juillet 2026) ───────────────────
// Même principe que demucs.js/analyzer.js : au lieu de relancer un process
// Python neuf (import torch/onnxruntime + rechargement du modèle UVR
// DeEcho-DeReverb depuis le disque) à CHAQUE appel, un unique process
// persistant garde le modèle chargé en mémoire. Opt-out via DEREVERB_WORKER=0
// (backend/.env) si besoin — tryWorkerDereverb ne lève JAMAIS : tout échec
// (démarrage ou appel) retombe sur l'ancien mode CLI (runAudioSeparator),
// déjà éprouvé.
//
// INCERTITUDE CONNUE (contrairement au correctif équivalent pour Demucs,
// dont l'API Python — demucs.api.Separator — a été vérifiée directement sur
// l'environnement réel de l'utilisateur avant d'être branchée) : l'API
// Python de audio-separator utilisée ici (Separator/load_model/separate, cf.
// services/workers/dereverb_worker.py) est fondée sur la documentation
// publique du package, pas sur une vérification de la version RÉELLEMENT
// installée dans le venv dédié C:\audio-separator-env — accès à ce code
// uniquement, pas à cet environnement d'exécution précis. Le repli
// automatique garantit qu'il n'y a AUCUNE régression possible si l'API ne
// correspond pas exactement (le mode CLI, lui, reste inchangé) — mais le
// gain de perf n'est acquis qu'après vérification dans les logs serveur :
// chercher la ligne "[dereverb] ⏱ dé-reverb via worker persistant" (worker
// actif) plutôt que "[dereverb] worker persistant indisponible" (repli CLI).
const WORKER_ENABLED = process.env.DEREVERB_WORKER !== "0";
let _dereverbWorker = null;
const getDereverbWorker = () => {
  if (_dereverbWorker) return _dereverbWorker;
  const scriptPath = join(__dirname, "workers", "dereverb_worker.py");
  _dereverbWorker = registerWorker(new PersistentWorker(PYTHON_BIN, [scriptPath], {
    name: "dereverb",
    readyTimeoutMs: 90000, // 1er chargement du modèle (~100 Mo) peut prendre du temps
    env: {
      DEREVERB_MODEL: MODEL,
      DEREVERB_MODEL_DIR: MODEL_DIR,
      DEREVERB_USE_CUDA: detectCudaDereverb() ? "1" : "0",
    },
  }));
  return _dereverbWorker;
};

// Tente le dé-reverb via le worker persistant. Renvoie null (jamais ne lève)
// si le worker est indisponible ou échoue — l'appelant retombe alors sur
// runAudioSeparator, sans que le job échoue pour autant.
const tryWorkerDereverb = async (inputPath, outputDir) => {
  if (!WORKER_ENABLED) return null;
  const t0 = Date.now();
  try {
    await getDereverbWorker().call({ inputPath, outputDir }, 300000);
    console.log(`[dereverb] ⏱ dé-reverb via worker persistant — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return true;
  } catch (e) {
    console.warn(`[dereverb] worker persistant indisponible, repli sur le mode CLI : ${e.message}`);
    return null;
  }
};

const runAudioSeparator = (inputPath, outputDir) => new Promise((resolve, reject) => {
  // Invoqué via "python -m" (et non la commande "audio-separator" directe) :
  // pip installe son script dans un dossier qui n'est pas toujours dans le
  // PATH (cf. warning pip "not on PATH"), "python -m" évite ce problème.
  const args = [
    "-m", "audio_separator.utils.cli",
    inputPath,
    "--model_filename", MODEL,
    "--model_file_dir", MODEL_DIR,
    "--output_dir", outputDir,
    "--output_format", "FLAC",
    ...(detectCudaDereverb() ? ["--use_cuda"] : []),
  ];

  const proc = spawn(PYTHON_BIN, args);
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", d => { process.stdout.write(d); stdout += d.toString(); });
  proc.stderr.on("data", d => { process.stderr.write(d); stderr += d.toString(); });

  const timer = setTimeout(() => {
    proc.kill();
    reject(new Error("De-reverb timeout (5min)"));
  }, 300000);

  proc.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return reject(new Error(`audio-separator a échoué (code ${code}) : ${(stderr || stdout).slice(-500)}`));
    resolve(stdout);
  });
  proc.on("error", (err) => {
    clearTimeout(timer);
    reject(new Error(`Impossible de lancer audio-separator via ${PYTHON_BIN} (venv créé ? package installé ?) : ${err.message}`));
  });
});

// Diagnostic en lecture seule (audit perf juillet 2026 — lenteurs dé-reverb)
// — aucun effet de bord, exposé via routes/diag.js pour vérifier en
// conditions réelles CUDA/le venv/le modèle sans avoir à lire les logs
// serveur bruts.
export const _diagnostics = () => ({
  pythonBin: PYTHON_BIN,
  modelDir: MODEL_DIR,
  model: MODEL,
  workerEnabled: WORKER_ENABLED,
  cuda: detectCudaDereverb(),
});

// Retire l'écho/réverb d'une piste vocale isolée. Renvoie le chemin du
// fichier "sec" obtenu. Cette étape est un bonus optionnel et non bloquant :
// à l'appelant de retomber sur la voix brute (sortie Demucs) si ça échoue
// (package absent, modèle indisponible, etc.) plutôt que de faire échouer
// toute la séparation pour ça.
export const dereverbVocals = async (vocalsPath, outputDir) => {
  mkdirSync(outputDir, { recursive: true });
  // runGpuExclusive : même file GPU partagée que Demucs (services/gpuQueue.js)
  // — évite qu'un dé-reverb et une séparation Demucs se disputent le GPU en
  // même temps (2 pistes traitées en parallèle, cf. Promise.all dans
  // routes/mashup.js) plutôt que de sérialiser tout prepareTrack comme avant.
  // Englobe aussi la tentative worker (pas seulement le repli CLI) : les deux
  // chemins sollicitent le même GPU, doivent donc être sérialisés pareillement.
  const viaWorker = await runGpuExclusive(() => tryWorkerDereverb(vocalsPath, outputDir));
  if (viaWorker) {
    const clean = pickCleanFile(outputDir, "worker dé-reverb persistant");
    console.log(`✅ [dereverb] voix sans écho/réverb (worker) : ${clean}`);
    return clean;
  }

  // Repli : ancien mode "un process par appel", déjà éprouvé.
  await runGpuExclusive(() => runAudioSeparator(vocalsPath, outputDir));
  const clean = pickCleanFile(outputDir, "audio-separator (CLI)");
  console.log(`✅ [dereverb] voix sans écho/réverb (CLI) : ${clean}`);
  return clean;
};
