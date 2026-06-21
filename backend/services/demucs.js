import { spawn } from "child_process";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import os from "os";

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
const PYTHON_BIN = process.env.DEMUCS_PYTHON || "python";

// Détection rapide et explicite du GPU (CUDA) via torch, AVANT de lancer
// Demucs — plutôt que de lancer tout le traitement en "cuda" et catcher
// l'échec après coup. Quelques secondes max (timeout de sécurité 8s).
const detectCuda = () => new Promise((resolve) => {
  const proc = spawn(PYTHON_BIN, ["-c", "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)"]);
  const timer = setTimeout(() => { proc.kill(); resolve(false); }, 8000);
  proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  proc.on("error", () => { clearTimeout(timer); resolve(false); });
});

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
const runDemucs = (wavPath, outputDir, device, { fullStems = false } = {}) => new Promise((resolve, reject) => {
  // Utiliser flac qui n'a pas besoin de torchcodec
  const args = [
    "-m", "demucs",
    ...(fullStems ? [] : ["--two-stems=vocals"]),
    "--flac",
    "-d", device,
  ];

  if (device === "cpu") {
    args.push("-j", String(cpuJobs()));
  }

  args.push("-o", outputDir, wavPath);

  const proc = spawn(PYTHON_BIN, args);
  let stderr = "";

  proc.stdout.on("data", d => process.stdout.write(d));
  proc.stderr.on("data", d => {
    process.stderr.write(d);
    stderr += d.toString();
  });

  const timer = setTimeout(() => {
    proc.kill();
    reject(new Error("Demucs timeout (15min)"));
  }, 900000);

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
  const hasCuda = await detectCuda();
  if (hasCuda) {
    console.log("[demucs] GPU CUDA détecté — séparation en GPU");
    try {
      await runDemucs(wavPath, outputDir, "cuda", opts);
      return;
    } catch (e) {
      console.warn("[demucs] échec en GPU (OOM VRAM ou autre), repli sur le CPU :", e.message?.split("\n")[0]);
    }
  } else {
    console.log(`[demucs] aucun GPU détecté — séparation en CPU (${cpuJobs()} coeurs en parallèle)`);
  }
  await runDemucs(wavPath, outputDir, "cpu", opts);
};

const stemsOutputDir = (wavPath, outputDir) => {
  const baseName = wavPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  return join(outputDir, "htdemucs", baseName);
};

const findExisting = (stemsDir, name) => {
  for (const ext of [".flac", ".mp3", ".wav"]) {
    const p = join(stemsDir, `${name}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
};

// ── 2 stems (voix / instrumental) — utilisé par ClipEditor et les Decks A/B ──
export const separateStems = async (wavPath, outputDir) => {
  mkdirSync(outputDir, { recursive: true });
  await runWithGpuFallback(wavPath, outputDir, { fullStems: false });

  const stemsDir = stemsOutputDir(wavPath, outputDir);
  const vocals = findExisting(stemsDir, "vocals");
  const instrumental = findExisting(stemsDir, "no_vocals");

  if (!vocals || !instrumental) {
    throw new Error(`Stems introuvables dans ${stemsDir}`);
  }

  console.log(`✅ Stems: ${vocals}`);
  return { vocals, instrumental };
};

// ── 4 stems complets (voix / batterie / basse / autres) — utilisé par le
// moteur d'analyse/scoring (routes/analyze.js) pour reconstruire un
// instrumental "à la carte" (ex: batterie+basse du morceau B, harmonies du
// morceau A) plutôt que de ne jamais pouvoir toucher qu'à voix/instru en bloc.
export const separateStemsFull = async (wavPath, outputDir) => {
  mkdirSync(outputDir, { recursive: true });
  await runWithGpuFallback(wavPath, outputDir, { fullStems: true });

  const stemsDir = stemsOutputDir(wavPath, outputDir);
  const vocals = findExisting(stemsDir, "vocals");
  const drums = findExisting(stemsDir, "drums");
  const bass = findExisting(stemsDir, "bass");
  const other = findExisting(stemsDir, "other");

  if (!vocals || !drums || !bass || !other) {
    throw new Error(`Stems (4 pistes) introuvables dans ${stemsDir}`);
  }

  console.log(`✅ Stems complets: ${stemsDir}`);
  return { vocals, drums, bass, other };
};
