import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { rename, rm } from "fs/promises";
import { extractAudio } from "../services/ffmpeg.js";
import { separateStemsFull } from "../services/demucs.js";
import { registerJobCleanup } from "../services/jobCleanup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TMP_DIR = join(__dirname, "../tmp");
const OUT_DIR = join(__dirname, "../data/outputs/macheupdj");
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ── Page MACHEUPDJ (console 2 decks façon VirtualDJ, upload local) ──
// Contrairement au reste de l'app (recherche YouTube), cette page lit le
// fichier DIRECTEMENT côté navigateur (decodeAudioData sur le File choisi) —
// aucun aller-retour serveur nécessaire pour la lecture/scratch/boucle/cues,
// c'est ce qui permet le scratch en temps réel (cf. spec-macheupdj.md).
// Cette route ne sert donc qu'à UNE chose : séparer le fichier en 4 stems en
// tâche de fond (voix/batterie/basse/autres, réutilise separateStemsFull —
// même pipeline que ClipEditor/FadrMacheUp) pour alimenter les pads "Stems
// 2.0", pendant que l'utilisateur mixe déjà avec la piste complète.
const ALLOWED_AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".opus", ".webm"]);
const safeAudioExt = (originalName) => {
  const ext = extname(originalName || "").toLowerCase();
  return ALLOWED_AUDIO_EXT.has(ext) ? ext : ".mp3";
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, `macheupdj_${uuidv4()}${safeAudioExt(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });
registerJobCleanup(jobs, { label: "[macheupdj]" });

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

router.post("/separate", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier audio manquant." });

  const jobId = uuidv4();
  const jobOut = join(OUT_DIR, jobId);
  mkdirSync(jobOut, { recursive: true });

  res.json({ jobId });
  updateJob(jobId, { status: "running" });

  const rawPath = req.file.path;
  const stemsTmp = join(TMP_DIR, `${jobId}-stems`);
  try {
    const sourceWav = join(jobOut, "source.wav");
    await extractAudio(rawPath, sourceWav);

    const separated = await separateStemsFull(sourceWav, stemsTmp, 4);
    const urls = {};
    for (const key of ["vocals", "drums", "bass", "other"]) {
      const destName = `${key}${extname(separated[key])}`;
      const destPath = join(jobOut, destName);
      // rename() : stemsTmp est jetable (supprimé dans le "finally"
      // ci-dessous), le fichier source n'y est plus utilisé après ce déplacement.
      await rename(separated[key], destPath);
      urls[key] = `/outputs/macheupdj/${jobId}/${destName}`;
    }

    updateJob(jobId, { status: "done", ...urls });
    console.log(`✅ [macheupdj] séparation 4 stems ${jobId} terminée`);
  } catch (err) {
    console.error(`❌ [macheupdj] séparation ${jobId} échouée :`, err.message);
    updateJob(jobId, { status: "error", message: err.message });
  } finally {
    await rm(rawPath, { force: true }).catch(() => {});
    await rm(stemsTmp, { recursive: true, force: true }).catch(() => {});
  }
});

export default router;
