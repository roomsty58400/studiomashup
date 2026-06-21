import { spawn } from "child_process";
import { mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

// Retire l'écho/réverb d'une piste vocale isolée. Renvoie le chemin du
// fichier "sec" obtenu. Cette étape est un bonus optionnel et non bloquant :
// à l'appelant de retomber sur la voix brute (sortie Demucs) si ça échoue
// (package absent, modèle indisponible, etc.) plutôt que de faire échouer
// toute la séparation pour ça.
export const dereverbVocals = async (vocalsPath, outputDir) => {
  mkdirSync(outputDir, { recursive: true });
  const stdout = await runAudioSeparator(vocalsPath, outputDir);

  const files = readdirSync(outputDir);
  if (files.length === 0) {
    throw new Error(`audio-separator n'a produit aucun fichier dans ${outputDir} — sortie : ${stdout.slice(-500) || "(vide)"}`);
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

  console.log(`✅ [dereverb] voix sans écho/réverb : ${clean}`);
  return join(outputDir, clean);
};
