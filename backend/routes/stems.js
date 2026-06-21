import express from "express";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { copyFile, rm } from "fs/promises";
import { downloadAudio } from "../services/ytdlp.js";
import { extractAudio, combineTracks } from "../services/ffmpeg.js";
import { separateStems } from "../services/demucs.js";
import { getTrack } from "../db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TMP_DIR = join(__dirname, "../tmp");
const OUT_DIR = join(__dirname, "../data/outputs/stems");
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ── Jobs en mémoire (même pattern que routes/mashup.js et routes/clipEditor.js) ──
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

const ANALYZE_OUT_DIR = join(__dirname, "../data/outputs");
const toAbsolute = (url) => join(ANALYZE_OUT_DIR, url.replace(/^\/outputs\//, ""));

// ── Démarre l'extraction voix/instru (FLAC) d'une vidéo YouTube — utilisé
// par les 2 boutons "Extraire voix" / "Extraire instru" sous le lecteur des
// Decks A/B.
//
// Optimisation "gagner du temps" : si le morceau a déjà été analysé via
// /api/analyze (4 stems vocals/drums/bass/other, cf. db/index.js), on NE
// RELANCE PAS Demucs une 2e fois pour le même audio — la voix est déjà
// disponible telle quelle, et l'instrumental se déduit en recombinant
// drums+bass+other (un simple amix ffmpeg, ~1s, pas de GPU). Sinon
// (analyse pas encore faite/pas encore terminée), on retombe sur la
// séparation 2-stems indépendante comme avant.
router.post("/start", async (req, res) => {
  const { videoId, title = "track" } = req.body;
  if (!videoId) return res.status(400).json({ error: "videoId requis" });

  const jobId = uuidv4();
  const jobTmp = join(TMP_DIR, `stems-${jobId}`);
  const jobOut = join(OUT_DIR, jobId);
  mkdirSync(jobTmp, { recursive: true });
  mkdirSync(jobOut, { recursive: true });

  res.json({ jobId });
  updateJob(jobId, { status: "running", title });

  (async () => {
    try {
      const analyzed = getTrack(videoId);
      if (analyzed?.vocals_path && analyzed.drums_path && analyzed.bass_path && analyzed.other_path) {
        console.log(`[stems] ${videoId} déjà analysé — dérivation depuis les 4 stems (pas de 2e Demucs)`);
        const vocalsSrc = toAbsolute(analyzed.vocals_path);
        const vocalsName = "vocals" + extname(vocalsSrc);
        const instruName = "instrumental.flac";
        await copyFile(vocalsSrc, join(jobOut, vocalsName));
        await combineTracks(
          [analyzed.drums_path, analyzed.bass_path, analyzed.other_path].map(toAbsolute),
          join(jobOut, instruName),
        );
        updateJob(jobId, {
          status: "done",
          vocals: `/outputs/stems/${jobId}/${vocalsName}`,
          instrumental: `/outputs/stems/${jobId}/${instruName}`,
        });
        console.log(`✅ [stems] ${jobId} dérivé instantanément depuis l'analyse`);
        return;
      }

      const audioBase = join(jobTmp, "raw");
      await downloadAudio(videoId, audioBase);

      const exts = [".wav", ".opus", ".webm", ".m4a", ".mp3", ".ogg", ".flac", ".aac"];
      const rawAudio = exts.map(e => audioBase + e).find(p => existsSync(p));
      if (!rawAudio) throw new Error("Audio introuvable après téléchargement");

      const wav = join(jobTmp, "audio.wav");
      await extractAudio(rawAudio, wav);

      const stemsTmp = join(jobTmp, "stems");
      const { vocals, instrumental } = await separateStems(wav, stemsTmp);

      const vocalsName = "vocals" + extname(vocals);
      const instruName = "instrumental" + extname(instrumental);
      await copyFile(vocals, join(jobOut, vocalsName));
      await copyFile(instrumental, join(jobOut, instruName));

      updateJob(jobId, {
        status: "done",
        vocals: `/outputs/stems/${jobId}/${vocalsName}`,
        instrumental: `/outputs/stems/${jobId}/${instruName}`,
      });
      console.log(`✅ [stems] séparation ${jobId} terminée`);
    } catch (err) {
      console.error(`❌ [stems] séparation ${jobId} échouée :`, err.message);
      updateJob(jobId, { status: "error", message: err.message });
    } finally {
      await rm(jobTmp, { recursive: true, force: true }).catch(() => {});
    }
  })();
});

// ── Téléchargement forcé (Content-Disposition fixé côté serveur) ──
// L'attribut HTML "download" est ignoré par le navigateur en cross-origin
// (frontend Vite / backend Express sur des ports différents) — même
// solution que /:id/video-silent dans routes/clipEditor.js.
router.get("/:id/download/:which", (req, res) => {
  const { id, which } = req.params;
  const job = jobs.get(id);
  if (!job || job.status !== "done") return res.status(404).json({ error: "Stem introuvable ou pas encore prêt." });

  const url = which === "vocals" ? job.vocals : which === "instrumental" ? job.instrumental : null;
  if (!url) return res.status(400).json({ error: "Paramètre 'which' invalide (vocals|instrumental)." });

  const filePath = toAbsolute(url);
  if (!existsSync(filePath)) return res.status(404).json({ error: "Fichier introuvable sur le serveur." });

  const safeTitle = (job.title || "track").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "track";
  const label = which === "vocals" ? "voix" : "instru";
  const ext = filePath.slice(filePath.lastIndexOf("."));
  res.download(filePath, `${safeTitle} (${label})${ext}`);
});

export default router;
