import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { copyFile, rm } from "fs/promises";
import { downloadAudio, downloadVideo } from "../services/ytdlp.js";
import { extractAudio, mixQuick, mixSmart, mixFullRave, exportFLAC, exportMP4_916 } from "../services/ffmpeg.js";
import { analyzeAudio } from "../services/analyzer.js";
import { separateStems } from "../services/demucs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Multer : upload temporaire des fichiers audio ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, "../tmp")),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname) || ".mp3";
    cb(null, `upload_${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

// ── Upload d'un fichier audio ──
router.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  res.json({ fileId: req.file.filename });
});

const jobs = new Map();
const updateJob = (id, patch) => {
  const job = jobs.get(id) || {};
  jobs.set(id, { ...job, ...patch, updatedAt: Date.now() });
};

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

router.post("/", async (req, res) => {
  // Accepte l'ancien format (videoA/videoB) et le nouveau (trackA/trackB)
  const { videoA, videoB, trackA: tA, trackB: tB,
          mode = "full", crossfade = 0.5, title = "mashup" } = req.body;

  const trackA = tA || (videoA ? { type: "youtube", id: videoA.id } : null);
  const trackB = tB || (videoB ? { type: "youtube", id: videoB.id } : null);

  if (!trackA || !trackB)
    return res.status(400).json({ error: "trackA et trackB sont requis" });

  // FLAC toujours généré ; MP4 en plus si possible — les 2 sont produits en
  // parallèle (cf. Promise.all à l'étape export) au lieu de forcer l'usager
  // à choisir un seul format, pour gagner du temps sur l'ensemble du job.
  // MP4 nécessite des vidéos YouTube pour les 2 decks (pas de fichier upload).
  const canMp4 = trackA.type !== "file" && trackB.type !== "file";

  const jobId = uuidv4();
  const tmpDir = join(__dirname, "../tmp", jobId);
  const outDir = join(__dirname, "../data/outputs");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  res.json({ jobId });

  // Téléchargement vidéo (pour l'export MP4) : ne dépend d'aucune étape audio
  // (mixage, BPM, Demucs), donc on le démarre tout de suite en arrière-plan,
  // en parallèle de la préparation audio, plutôt que d'attendre la toute fin.
  const vidA = join(tmpDir, "vid_a.mp4");
  const vidB = join(tmpDir, "vid_b.mp4");
  const videoDownloadPromise = canMp4
    ? Promise.all([downloadVideo(trackA.id, vidA), downloadVideo(trackB.id, vidB)])
    : null;
  // Si le job échoue avant d'avoir atteint l'étape d'export (ex: l'audio
  // échoue au téléchargement), cette promesse n'est jamais "await"ée avant le
  // "finally" → un rejet ici devient une unhandled rejection qui plante tout
  // le process Node. On la marque "gérée" tout de suite ; l'erreur réelle est
  // quand même relevée plus bas via le second `await videoDownloadPromise`.
  videoDownloadPromise?.catch(() => {});

  (async () => {
    try {
      const wavA = join(tmpDir, "a.wav");
      const wavB = join(tmpDir, "b.wav");
      const exts = [".wav", ".opus", ".webm", ".m4a", ".mp3", ".ogg", ".flac", ".aac"];

      // ── Pipeline complet PAR PISTE (téléchargement → extraction →
      // analyse → séparation stems), piste A ENTIÈREMENT terminée avant de
      // démarrer la piste B — au lieu d'A et B en parallèle à chaque étape.
      // Retour utilisateur : la 1ère vidéo se téléchargeait et se séparait
      // bien, mais la 2de plantait systématiquement, qu'il fallait relancer
      // à part avant de pouvoir créer le mashup — 2 téléchargements yt-dlp +
      // 2 process Demucs (GPU ou CPU) simultanés se marchent dessus
      // (contention CPU/RAM/VRAM ou réseau). Un audio après l'autre est plus
      // lent mais nettement plus fiable.
      const prepareTrack = async (track, rawBasePath, wavPath, label) => {
        updateJob(jobId, { status: "running", step: 0, label: `Téléchargement piste ${label}` });
        if (track.type === "youtube") {
          await downloadAudio(track.id, rawBasePath);
        } else {
          // Fichier déjà uploadé — le copier dans le répertoire du job
          const srcPath = join(__dirname, "../tmp", track.fileId);
          const ext = extname(track.fileId) || ".mp3";
          await copyFile(srcPath, rawBasePath + ext);
        }

        const actual = exts.map(e => rawBasePath + e).find(p => existsSync(p));
        if (!actual) throw new Error(`Fichier audio introuvable après téléchargement (piste ${label})`);

        updateJob(jobId, { step: 1, label: `Extraction audio piste ${label}` });
        await extractAudio(actual, wavPath);

        let bpm = null, stems = null;
        if (mode === "smart" || mode === "full") {
          updateJob(jobId, { step: 1, label: `Analyse BPM / Tonalité piste ${label}` });
          const info = await analyzeAudio(wavPath);
          bpm = info.bpm;
        }
        if (mode === "full") {
          updateJob(jobId, { step: 2, label: `Séparation stems piste ${label} (Demucs)` });
          const stemsDir = join(tmpDir, "stems", label.toLowerCase());
          mkdirSync(stemsDir, { recursive: true });
          stems = await separateStems(wavPath, stemsDir);
        }
        return { bpm, stems };
      };

      const resA = await prepareTrack(trackA, join(tmpDir, "a_raw"), wavA, "A");
      const resB = await prepareTrack(trackB, join(tmpDir, "b_raw"), wavB, "B");

      const mixedWav = join(tmpDir, "mixed.wav");
      const safeName = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const baseName = `${safeName}_${jobId.slice(0, 8)}`;
      const flacFile = join(outDir, `${baseName}.flac`);
      const mp4File = join(outDir, `${baseName}.mp4`);

      if (mode === "quick") {
        updateJob(jobId, { step: 3, label: "Mixage rapide" });
        await mixQuick(wavA, wavB, parseFloat(crossfade), mixedWav);
        updateJob(jobId, { step: 4, label: "Export final" });

      } else if (mode === "smart") {
        console.log(`BPM A: ${resA.bpm} | BPM B: ${resB.bpm}`);
        updateJob(jobId, { step: 3, label: "Alignement BPM + mixage" });
        await mixSmart(wavA, wavB, resA.bpm, resB.bpm, parseFloat(crossfade), mixedWav);
        updateJob(jobId, { step: 4, label: "Export final" });

      } else if (mode === "full") {
        console.log(`BPM A: ${resA.bpm} | BPM B: ${resB.bpm}`);
        updateJob(jobId, { step: 3, label: "Mixage voix A + instru B" });
        await mixFullRave(resA.stems.vocals, resB.stems.instrumental, resA.bpm, resB.bpm, parseFloat(crossfade), mixedWav);
        updateJob(jobId, { step: 4, label: "Export final" });
      }

      // ── EXPORT FINAL : FLAC + MP4 en parallèle (au lieu d'un choix unique)
      // pour gagner du temps sur l'ensemble du job. Le FLAC est quasi-
      // instantané ; le MP4 (montage + encodage vidéo) est l'étape longue —
      // les lancer ensemble plutôt qu'à la suite ne fait gagner que peu de
      // temps en pratique (le FLAC est négligeable face au MP4) mais évite
      // une attente artificielle inutile, et garde le code simple.
      updateJob(jobId, { step: 4, label: canMp4 ? "Export final (FLAC + MP4)" : "Export final (FLAC)" });

      const exportJobs = [exportFLAC(mixedWav, flacFile)];
      if (canMp4) {
        exportJobs.push((async () => {
          // Le téléchargement vidéo a été lancé en parallèle dès le début du
          // job (cf. videoDownloadPromise) : on attend juste qu'il se termine
          // s'il n'est pas déjà fini, au lieu de le démarrer seulement ici.
          await videoDownloadPromise;
          await exportMP4_916(vidA, vidB, mixedWav, mp4File, parseFloat(crossfade));
        })());
      }
      await Promise.all(exportJobs);

      const flacUrl = `/outputs/${baseName}.flac`;
      const mp4Url = canMp4 ? `/outputs/${baseName}.mp4` : null;
      updateJob(jobId, { status: "done", step: 5, label: "Terminé !", flacUrl, mp4Url, title });
      console.log(`✅ Job ${jobId} terminé : ${flacUrl}${mp4Url ? " + " + mp4Url : ""}`);

    } catch (err) {
      console.error(`❌ Job ${jobId} failed:`, err.message);
      updateJob(jobId, { status: "error", message: err.message });
    } finally {
      // On attend que le téléchargement vidéo (lancé en parallèle dès le
      // début) soit bien terminé/échoué avant de supprimer tmpDir : sinon
      // downloadVideo essaie encore d'écrire dans un dossier déjà supprimé
      // (ENOENT sur le ".part") quand le job a échoué tôt côté audio.
      if (videoDownloadPromise) await videoDownloadPromise.catch(() => {});
      // Nettoyage des fichiers temporaires du job (audio brut, wav, stems,
      // vidéos sources) — le fichier final livré au client est dans data/outputs,
      // donc indépendant de ce nettoyage. Évite l'accumulation de Go de tmp/.
      // Version async (fs/promises) plutôt que rmSync : un nettoyage synchrone
      // d'un dossier potentiellement volumineux (vidéos, stems Demucs) bloque
      // toute la boucle d'événements Node pendant l'opération — donc TOUTES les
      // autres requêtes en cours (ex: la recherche YouTube) restent en attente
      // pendant ce temps. await rm() rend la main entre les opérations.
      await rm(tmpDir, { recursive: true, force: true });
    }
  })();
});

export default router;
