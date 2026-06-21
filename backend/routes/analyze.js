import express from "express";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { copyFile, rm } from "fs/promises";
import { downloadAudio } from "../services/ytdlp.js";
import { extractAudio } from "../services/ffmpeg.js";
import { analyzeAudio } from "../services/analyzer.js";
import { separateStemsFull } from "../services/demucs.js";
import { getTrack, upsertTrack } from "../db/index.js";
import { computeCompatibility } from "../services/scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TMP_DIR = join(__dirname, "../tmp");
const OUT_DIR = join(__dirname, "../data/outputs/analyze");
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ── Jobs en mémoire (même pattern que routes/mashup.js, clipEditor.js, stems.js) ──
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

// ── Lecture directe du cache (pas de job nécessaire si déjà analysé) ──
router.get("/cached/:videoId", (req, res) => {
  const track = getTrack(req.params.videoId);
  if (!track) return res.status(404).json({ error: "Pas encore analysé." });
  res.json(track);
});

// ── Analyse complète d'un morceau YouTube ──
// BPM/clé/énergie/structure/spectral (analyzer.js) + séparation 4 stems
// (demucs.js, GPU CUDA si dispo) → stocké en SQLite, indexé par videoId.
// Un morceau déjà analysé n'est JAMAIS retraité (Demucs = l'étape la plus
// lente, plusieurs minutes) — on sert directement le cache.
router.post("/", async (req, res) => {
  const { videoId, title = "track" } = req.body;
  if (!videoId) return res.status(400).json({ error: "videoId requis" });

  const cached = getTrack(videoId);
  if (cached) {
    return res.json({ cached: true, track: cached });
  }

  const jobId = uuidv4();
  const jobTmp = join(TMP_DIR, `analyze-${jobId}`);
  const jobOut = join(OUT_DIR, videoId);
  mkdirSync(jobTmp, { recursive: true });
  mkdirSync(jobOut, { recursive: true });

  res.json({ jobId });
  updateJob(jobId, { status: "running", step: "download", videoId, title });

  (async () => {
    try {
      const audioBase = join(jobTmp, "raw");
      await downloadAudio(videoId, audioBase);

      const exts = [".wav", ".opus", ".webm", ".m4a", ".mp3", ".ogg", ".flac", ".aac"];
      const rawAudio = exts.map(e => audioBase + e).find(p => existsSync(p));
      if (!rawAudio) throw new Error("Audio introuvable après téléchargement");

      updateJob(jobId, { step: "extract" });
      const wav = join(jobTmp, "audio.wav");
      await extractAudio(rawAudio, wav);

      // NOTE : avait été mis en parallèle avec la séparation Demucs (même
      // Promise.all) pour gagner du temps — revenu en arrière, Demucs sature
      // déjà les ressources (GPU ou CPU multi-coeurs) à lui seul, et lancer
      // Librosa en même temps peut le faire timeout sur une machine chargée
      // (retour utilisateur côté mashup.js : l'analyse retombait sur son
      // repli par défaut, BPM faussé). On revient à l'analyse PUIS Demucs.
      updateJob(jobId, { step: "analyze" });
      const features = await analyzeAudio(wav);

      updateJob(jobId, { step: "separate" });
      const stemsTmp = join(jobTmp, "stems");
      const { vocals, drums, bass, other } = await separateStemsFull(wav, stemsTmp);

      const vocalsName = "vocals" + extname(vocals);
      const drumsName = "drums" + extname(drums);
      const bassName = "bass" + extname(bass);
      const otherName = "other" + extname(other);
      await Promise.all([
        copyFile(vocals, join(jobOut, vocalsName)),
        copyFile(drums, join(jobOut, drumsName)),
        copyFile(bass, join(jobOut, bassName)),
        copyFile(other, join(jobOut, otherName)),
      ]);

      const track = upsertTrack({
        id: videoId,
        source: "youtube",
        title,
        duration: features.duration,
        bpm: features.bpm,
        key_pitch: features.key_pitch,
        key_mode: features.key_mode,
        camelot: features.camelot,
        energy_rms: features.energy_rms,
        energy_std: features.energy_std,
        spectral_centroid: features.spectral_centroid,
        mfcc_json: JSON.stringify(features.mfcc_mean || []),
        structure_json: JSON.stringify(features.structure || []),
        vocals_path: `/outputs/analyze/${videoId}/${vocalsName}`,
        drums_path: `/outputs/analyze/${videoId}/${drumsName}`,
        bass_path: `/outputs/analyze/${videoId}/${bassName}`,
        other_path: `/outputs/analyze/${videoId}/${otherName}`,
        analyzed_at: Date.now(),
      });

      updateJob(jobId, { status: "done", step: "done", track });
      console.log(`✅ [analyze] ${videoId} terminé (BPM ${track.bpm}, ${track.camelot})`);
    } catch (err) {
      console.error(`❌ [analyze] ${videoId} échoué :`, err.message);
      updateJob(jobId, { status: "error", message: err.message });
    } finally {
      await rm(jobTmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
});

// ── Score de compatibilité entre 2 morceaux déjà analysés ──
// Instantané : ne fait que comparer des features déjà en base, aucun
// traitement audio/GPU n'est relancé ici.
router.post("/score", (req, res) => {
  const { videoIdA, videoIdB } = req.body;
  if (!videoIdA || !videoIdB) return res.status(400).json({ error: "videoIdA et videoIdB requis" });

  const trackA = getTrack(videoIdA);
  const trackB = getTrack(videoIdB);
  if (!trackA || !trackB) {
    const missing = [!trackA && videoIdA, !trackB && videoIdB].filter(Boolean);
    return res.status(400).json({ error: `Morceau(x) pas encore analysé(s) : ${missing.join(", ")}. Lance POST /api/analyze d'abord.` });
  }

  const result = computeCompatibility(trackA, trackB);
  res.json({ trackA, trackB, ...result });
});

export default router;
