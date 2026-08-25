import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { rename, rm } from "fs/promises";
import { downloadAudio, downloadVideo } from "../services/ytdlp.js";
import { extractAudio, exportMP3, combineTracks, mixStemsCustom, applyGenreEffect, GENRE_DSP_PRESETS } from "../services/ffmpeg.js";
import { separateStemsFull } from "../services/demucs.js";
import { dereverbVocals } from "../services/dereverb.js";
import { recomposeReplace, combineStems, stripAudio } from "../services/clipEditor.js";
import { registerJobCleanup } from "../services/jobCleanup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TMP_DIR = join(__dirname, "../tmp");
const OUT_DIR = join(__dirname, "../data/outputs/clip-editor");
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ── Upload de la nouvelle piste audio (transformée par un outil IA externe :
// Kits.ai, Suno, Udio, LALAL.AI...) avant remontage avec la vidéo d'origine.
// Extension whitelistée (audit juillet 2026, même raisonnement que
// routes/mashup.js) : ce fichier est ensuite passé à des commandes ffmpeg
// interpolées en chaîne shell (services/clipEditor.js) — mieux vaut ne
// jamais faire confiance à l'extension brute fournie par le client.
const ALLOWED_AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".opus", ".webm"]);
const safeAudioExt = (originalName) => {
  const ext = extname(originalName || "").toLowerCase();
  return ALLOWED_AUDIO_EXT.has(ext) ? ext : ".mp3";
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, `clipaudio_${uuidv4()}${safeAudioExt(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

// ── Jobs en mémoire (même pattern que routes/mashup.js) ──
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });
registerJobCleanup(jobs, { label: "[clip-editor]" });

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ── Téléchargement forcé de la vidéo SANS son (étape ①/③) ──
// Servir ce fichier via /outputs (express.static) ne force pas le
// téléchargement : sans en-tête Content-Disposition, et comme le frontend
// (port Vite) et le backend sont sur des origines différentes, l'attribut
// HTML "download" est ignoré par le navigateur, qui ouvre/joue la vidéo au
// lieu de la télécharger. res.download() fixe Content-Disposition: attachment
// côté serveur, ce qui force le téléchargement quelle que soit l'origine.
router.get("/:id/video-silent", (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  const filePath = join(OUT_DIR, jobId, "video_silent.mp4");
  if (!existsSync(filePath)) return res.status(404).json({ error: "Vidéo sans son introuvable." });
  const safeTitle = (job?.title || "clip").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "clip";
  res.download(filePath, `${safeTitle} (sanson).mp4`);
});

// ── Export MP3 d'un stem individuel (cadre FadrMacheUp) ── les stems sortent
// de Demucs en FLAC (cf. runSeparation, "flac qui n'a pas besoin de
// torchcodec") : pratique pour un mixage sans perte, mais un MP3 est souvent
// préférable pour un export rapide à partager (poids, compatibilité
// universelle). Réencodé à la demande puis mis en cache sur le disque du job
// (le .mp3 n'est jamais régénéré une fois présent). Même principe de
// téléchargement forcé que /:id/video-silent ci-dessus.
const STEM_MP3_LABELS = { vocals: "voix", drums: "batterie", bass: "basse", other: "autres" };
router.get("/:id/stem-mp3/:key", async (req, res) => {
  const { id: jobId, key } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!STEM_MP3_LABELS[key]) return res.status(400).json({ error: "Stem inconnu." });

  // Voix : on préfère la version nettoyée (sans écho/réverb) si prête, comme
  // /remix-export et /genre-effect plus bas dans ce fichier — c'est la
  // version que le cadre FadrMacheUp fait déjà écouter par défaut.
  const sourceUrl = key === "vocals" ? (job.vocalsClean || job.vocals) : job[key];
  if (!sourceUrl) return res.status(404).json({ error: "Stem indisponible." });

  const jobOut = join(OUT_DIR, jobId);
  const sourcePath = join(jobOut, sourceUrl.split("/").pop());
  if (!existsSync(sourcePath)) return res.status(404).json({ error: "Fichier introuvable sur le serveur." });

  const mp3Path = join(jobOut, `${key}.mp3`);
  try {
    if (!existsSync(mp3Path)) await exportMP3(sourcePath, mp3Path);
    const safeTitle = (job.title || "clip").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "clip";
    res.download(mp3Path, `${safeTitle} (${STEM_MP3_LABELS[key]}).mp3`);
  } catch (err) {
    console.error(`❌ [clip-editor] export MP3 stem "${key}" (${jobId}) échoué :`, err.message);
    res.status(500).json({ error: `Export MP3 échoué : ${err.message}` });
  }
});

// ── Séparation voix / instru (Demucs) ── factorisée pour être appelée à la
// fois automatiquement (juste après l'extraction, en tâche de fond masquée)
// et manuellement via /:id/separate (ex: pour réessayer après une erreur).
// Jamais "await"ée sur le chemin de /extract : ça ne doit JAMAIS bloquer le
// passage à "done" de l'audio, qui doit rester rapide.
const runSeparation = async (jobId) => {
  const job = jobs.get(jobId);
  if (!job || job.stemsStatus === "running" || job.stemsStatus === "done") return;

  const jobOut = join(OUT_DIR, jobId);
  const sourceWav = join(jobOut, "source.wav");
  if (!existsSync(sourceWav)) {
    updateJob(jobId, { stemsStatus: "error", stemsError: "Audio source introuvable" });
    return;
  }

  updateJob(jobId, { stemsStatus: "running" });
  const stemsTmp = join(TMP_DIR, `${jobId}-stems`);
  try {
    // 4 stems (voix/batterie/basse/autres) — même appel que le studio
    // principal (routes/analyze.js), au lieu du 2-stems historique de
    // ClipEditor : nécessaire pour le cadre FadrMacheUp (mixage indépendant
    // par stem). L'instrumental complet est ensuite DÉRIVÉ (drums+bass+other,
    // même principe que getCachedInstrumental ailleurs dans l'app) pour que
    // la recomposition voix/instru existante (étape ②/③, /recompose)
    // continue de fonctionner à l'identique, sans appel Demucs 2-stems
    // séparé.
    const separated = await separateStemsFull(sourceWav, stemsTmp, 4);
    const destPaths = {};
    for (const key of ["vocals", "drums", "bass", "other"]) {
      const destName = `${key}${extname(separated[key])}`;
      const destPath = join(jobOut, destName);
      // rename() : stemsTmp est jetable (supprimé dans le "finally" ci-dessous).
      await rename(separated[key], destPath);
      destPaths[key] = destPath;
    }

    const instruPath = join(jobOut, "instrumental.flac");
    await combineTracks([destPaths.drums, destPaths.bass, destPaths.other], instruPath);

    const urlFor = (p) => `/outputs/clip-editor/${jobId}/${p.split(/[\\/]/).pop()}`;
    updateJob(jobId, {
      stemsStatus: "done",
      dereverbStatus: "idle",
      vocals: urlFor(destPaths.vocals),
      drums: urlFor(destPaths.drums),
      bass: urlFor(destPaths.bass),
      other: urlFor(destPaths.other),
      instrumental: urlFor(instruPath),
    });
    console.log(`✅ [clip-editor] séparation 4 stems ${jobId} terminée`);

    // Nettoyage écho/réverb de la voix, en tâche de fond (masqué, non
    // bloquant) : la voix brute reste utilisable/téléchargeable tout de
    // suite, et est automatiquement remplacée par la version "sèche" dès
    // qu'elle est prête. Optionnel — si le package IA n'est pas installé,
    // on retombe simplement sur la voix brute (cf. runDereverb).
    runDereverb(jobId).catch(() => {});
  } catch (err) {
    console.error(`❌ [clip-editor] séparation ${jobId} échouée :`, err.message);
    updateJob(jobId, { stemsStatus: "error", stemsError: err.message });
  } finally {
    await rm(stemsTmp, { recursive: true, force: true }).catch(() => {});
  }
};

// ── Suppression d'écho/réverb sur la voix séparée (bonus IA, cf.
// services/dereverb.js) ── factorisée comme runSeparation : appelée
// automatiquement après la séparation, et réessayable manuellement via
// /:id/dereverb. Jamais bloquante : en cas d'échec (package non installé,
// modèle indisponible...), la voix brute reste la version utilisée partout.
const runDereverb = async (jobId) => {
  const job = jobs.get(jobId);
  if (!job || job.stemsStatus !== "done" || !job.vocals) return;
  if (job.dereverbStatus === "running" || job.dereverbStatus === "done") return;

  const jobOut = join(OUT_DIR, jobId);
  const vocalsPath = join(jobOut, job.vocals.split("/").pop());
  if (!existsSync(vocalsPath)) return;

  updateJob(jobId, { dereverbStatus: "running" });
  const dereverbTmp = join(TMP_DIR, `${jobId}-dereverb`);
  try {
    const cleanPath = await dereverbVocals(vocalsPath, dereverbTmp);
    const cleanName = "vocals_clean" + extname(cleanPath);
    // rename() : dereverbTmp est jetable (supprimé dans le "finally" ci-dessous).
    await rename(cleanPath, join(jobOut, cleanName));
    updateJob(jobId, {
      dereverbStatus: "done",
      vocalsClean: `/outputs/clip-editor/${jobId}/${cleanName}`,
    });
    console.log(`✅ [clip-editor] dé-réverb ${jobId} terminé`);
  } catch (err) {
    console.warn(`⚠️ [clip-editor] dé-réverb ${jobId} indisponible (repli sur la voix brute) :`, err.message);
    updateJob(jobId, { dereverbStatus: "error", dereverbError: err.message });
  } finally {
    await rm(dereverbTmp, { recursive: true, force: true }).catch(() => {});
  }
};

// ── ÉTAPE 1 (rapide) : téléchargement + extraction + export de la piste
// complète. La séparation voix/instru (Demucs) — de très loin l'étape la plus
// lente, souvent 1 à plusieurs minutes en CPU — ne bloque plus le passage à
// "done" : elle démarre automatiquement juste après, en tâche de fond
// masquée (l'utilisateur n'a plus besoin de cliquer sur quoi que ce soit).
// La vidéo, elle, n'est nécessaire ni à l'audio ni à Demucs : on la télécharge
// aussi en tâche de fond, sans bloquer le passage à "done" sur l'audio (même
// principe que le téléchargement vidéo dans routes/mashup.js).
router.post("/extract", async (req, res) => {
  const { videoId, title = "clip" } = req.body;
  if (!videoId) return res.status(400).json({ error: "videoId requis" });

  const jobId = uuidv4();
  const jobTmp = join(TMP_DIR, jobId);
  const jobOut = join(OUT_DIR, jobId);
  mkdirSync(jobTmp, { recursive: true });
  mkdirSync(jobOut, { recursive: true });

  res.json({ jobId });
  updateJob(jobId, { status: "running", step: 0, label: "Téléchargement audio", stemsStatus: "idle" });

  const videoPath = join(jobTmp, "video.mp4");
  // Démarré tout de suite, en parallèle — on ne l'attend que dans sa propre
  // tâche ci-dessous, jamais sur le chemin de l'audio.
  const videoDownloadPromise = downloadVideo(videoId, videoPath);

  const audioTask = (async () => {
    try {
      const audioBase = join(jobTmp, "audio_raw");
      await downloadAudio(videoId, audioBase);

      const exts = [".wav", ".opus", ".webm", ".m4a", ".mp3", ".ogg", ".flac", ".aac"];
      const rawAudio = exts.map(e => audioBase + e).find(p => existsSync(p));
      if (!rawAudio) throw new Error("Audio introuvable après téléchargement");

      updateJob(jobId, { step: 1, label: "Extraction audio" });
      const wav = join(jobTmp, "audio.wav");
      await extractAudio(rawAudio, wav);

      updateJob(jobId, { step: 2, label: "Export piste complète" });
      const fullMp3 = join(jobOut, "full.mp3");
      await exportMP3(wav, fullMp3);

      // Le WAV est conservé dans data/outputs/ (pas dans tmp/, qui sera
      // nettoyé) pour pouvoir lancer la séparation Demucs plus tard à la
      // demande, sans re-télécharger ni ré-extraire l'audio. rename() plutôt
      // que copyFile() : la source (tmp) n'est plus utilisée après ce point,
      // un déplacement (même disque) évite de dupliquer le WAV sur le disque.
      await rename(wav, join(jobOut, "source.wav"));

      updateJob(jobId, {
        status: "done", step: 3, label: "Terminé",
        title,
        fullAudio: `/outputs/clip-editor/${jobId}/full.mp3`,
      });
      console.log(`✅ [clip-editor] extraction audio ${jobId} terminée`);

      // Séparation auto. masquée : lancée ici sans "await" pour ne jamais
      // retarder le passage à "done" ci-dessus — elle continue en tâche de
      // fond pendant que l'utilisateur lit les instructions, télécharge la
      // piste complète, etc.
      runSeparation(jobId).catch(() => {});
    } catch (err) {
      console.error(`❌ [clip-editor] extraction ${jobId} échouée :`, err.message);
      updateJob(jobId, { status: "error", message: err.message });
    }
  })();

  const videoTask = (async () => {
    try {
      await videoDownloadPromise;
      const videoDest = join(jobOut, "video.mp4");
      // rename() plutôt que copyFile() : videoPath (tmp) n'est plus utilisé
      // après ce point, seul videoDest continue de servir (stripAudio juste
      // en dessous) — évite de dupliquer la vidéo brute sur le disque.
      await rename(videoPath, videoDest);
      updateJob(jobId, { video: `/outputs/clip-editor/${jobId}/video.mp4` });
      console.log(`✅ [clip-editor] vidéo ${jobId} prête`);

      // Version SANS bande son, générée ici en tâche de fond (masquée, aucune
      // action requise de l'utilisateur) — stream-copy donc quasi instantané.
      // C'est cette version qui sera utilisée à l'étape ③ pour recomposer le
      // clip final, afin que l'audio d'origine ne s'y glisse jamais.
      const silentDest = join(jobOut, "video_silent.mp4");
      await stripAudio(videoDest, silentDest);
      updateJob(jobId, { videoSilent: `/outputs/clip-editor/${jobId}/video_silent.mp4` });
      console.log(`✅ [clip-editor] vidéo sans son ${jobId} prête`);
    } catch (err) {
      console.error(`❌ [clip-editor] vidéo ${jobId} échouée :`, err.message);
      updateJob(jobId, { videoError: err.message });
    }
  })();

  // Nettoyage du tmp du job une fois les DEUX tâches terminées (succès ou
  // échec) — elles partagent le même dossier tmp, donc il ne faut le
  // supprimer qu'après que plus aucune des deux n'en ait besoin.
  Promise.allSettled([audioTask, videoTask]).then(() => {
    rm(jobTmp, { recursive: true, force: true }).catch(() => {});
  });
});

// ── Relance manuelle de la séparation ──
// La séparation se lance déjà automatiquement après l'extraction (cf.
// runSeparation ci-dessus) ; cette route ne sert plus qu'à réessayer en cas
// d'erreur, ou si jamais elle n'a pas démarré pour une raison quelconque.
router.post("/:id/separate", async (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job || job.status !== "done")
    return res.status(400).json({ error: "L'extraction de ce clip n'est pas terminée." });
  if (job.stemsStatus === "running")
    return res.status(409).json({ error: "Séparation déjà en cours." });

  res.json({ ok: true });
  updateJob(jobId, { stemsStatus: "idle" }); // pour repasser le "déjà done" éventuel et permettre un retry propre
  runSeparation(jobId).catch(() => {});
});

// ── Relance manuelle du nettoyage écho/réverb de la voix ──
// Utile par exemple si le package "audio-separator" n'était pas encore
// installé lors de la 1ère tentative (auto, juste après la séparation).
router.post("/:id/dereverb", async (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job || job.stemsStatus !== "done")
    return res.status(400).json({ error: "La séparation voix/instru n'est pas terminée." });
  if (job.dereverbStatus === "running")
    return res.status(409).json({ error: "Nettoyage déjà en cours." });

  res.json({ ok: true });
  updateJob(jobId, { dereverbStatus: "idle" });
  runDereverb(jobId).catch(() => {});
});

// ── ÉTAPE 3 : recomposition — vidéo SANS bande son (générée en masqué à
// l'étape ①, cf. video_silent.mp4) + piste audio choisie, directement.
// "source" indique QUEL fichier de l'étape ② l'utilisateur a transformé :
//  - "full"         : l'upload est utilisé tel quel comme bande son du clip.
//  - "vocals"       : l'upload = nouvelle voix → recombinée avec l'INSTRUMENTAL ORIGINAL
//                      (voice swap : seule la voix change).
//  - "instrumental" : l'upload = nouvel instrumental → recombiné avec la VOIX ORIGINALE
//                      (remix de style : seule la musique change, la voix reste).
router.post("/:id/recompose", upload.single("audio"), async (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job || job.status !== "done")
    return res.status(400).json({ error: "L'extraction de ce clip n'est pas terminée." });
  if (!req.file)
    return res.status(400).json({ error: "Fichier audio manquant (la piste transformée par l'IA)." });

  const source = ["vocals", "instrumental"].includes(req.body.source) ? req.body.source : "full";
  const jobOut = join(OUT_DIR, jobId);
  const silentVideoPath = join(jobOut, "video_silent.mp4");
  const newAudioPath = req.file.path;

  if (!existsSync(silentVideoPath)) {
    await rm(newAudioPath, { force: true }).catch(() => {});
    return res.status(404).json({ error: "Vidéo (sans son) pas encore prête pour ce job — réessaie dans quelques secondes." });
  }

  let combinedTmp = null;
  let audioForRecompose = newAudioPath;

  try {
    if (source !== "full") {
      // Pour la recombinaison avec la voix d'origine (remix d'instrumental),
      // on préfère la voix "nettoyée" (sans écho/réverb) si elle est prête —
      // sinon repli sur la voix brute.
      const counterpartUrl = source === "vocals" ? job.instrumental : (job.vocalsClean || job.vocals);
      if (job.stemsStatus !== "done" || !counterpartUrl) {
        return res.status(400).json({ error: "La piste d'origine correspondante (voix/instrumental) n'est pas encore disponible." });
      }
      const counterpartPath = join(jobOut, counterpartUrl.split("/").pop());
      if (!existsSync(counterpartPath)) {
        return res.status(404).json({ error: "Piste d'origine introuvable sur le serveur (a-t-elle expiré ?)." });
      }

      combinedTmp = join(TMP_DIR, `combined_${jobId}_${Date.now()}.wav`);
      await combineStems(newAudioPath, counterpartPath, combinedTmp);
      audioForRecompose = combinedTmp;
    }

    const finalName = `final_${Date.now()}.mp4`;
    const finalPath = join(jobOut, finalName);

    await recomposeReplace(silentVideoPath, audioForRecompose, finalPath);

    const url = `/outputs/clip-editor/${jobId}/${finalName}`;
    updateJob(jobId, { finalUrl: url });
    res.json({ url, source });
  } catch (err) {
    console.error(`❌ [clip-editor] recompose ${jobId} échouée :`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    rm(newAudioPath, { force: true }).catch(() => {});
    if (combinedTmp) rm(combinedTmp, { force: true }).catch(() => {});
  }
});

// ── Cadre FadrMacheUp : export "mix perso" ──
// Mixdown RÉEL (ffmpeg) des 4 stems déjà séparés, pondéré par les réglages
// mute/solo/volume/pan choisis dans l'éditeur — pas de génération IA, cf.
// mixStemsCustom (services/ffmpeg.js). Distinct du bouton "Générer un
// prompt" (/api/prompt/remix, existant) qui lui prépare un texte pour
// Suno/Udio plutôt que de produire un fichier audio directement.
router.post("/:id/remix-export", async (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job || job.stemsStatus !== "done")
    return res.status(400).json({ error: "Les stems de ce clip ne sont pas encore prêts." });

  const settings = req.body?.stems || {};
  const jobOut = join(OUT_DIR, jobId);
  const STEM_KEYS = ["vocals", "drums", "bass", "other"];
  const stemsForMix = [];
  for (const key of STEM_KEYS) {
    // Voix : on préfère la version nettoyée (sans écho/réverb) si prête,
    // comme le fait déjà /recompose ailleurs dans ce fichier.
    const url = key === "vocals" ? (job.vocalsClean || job.vocals) : job[key];
    if (!url) continue;
    const filePath = join(jobOut, url.split("/").pop());
    if (!existsSync(filePath)) continue;
    const s = settings[key] || {};
    stemsForMix.push({
      path: filePath,
      volume: typeof s.volume === "number" ? s.volume : 1,
      pan: typeof s.pan === "number" ? s.pan : 0,
      mute: !!s.mute,
      solo: !!s.solo,
    });
  }
  if (stemsForMix.length === 0)
    return res.status(400).json({ error: "Aucun stem disponible pour ce clip." });

  try {
    const outName = `remix_mix_${Date.now()}.flac`;
    const outPath = join(jobOut, outName);
    await mixStemsCustom(stemsForMix, outPath);
    res.json({ url: `/outputs/clip-editor/${jobId}/${outName}` });
  } catch (err) {
    console.error(`❌ [clip-editor] remix-export ${jobId} échoué :`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cadre FadrMacheUp : effet de genre (gratuit, sans IA externe) ──
// Remplace une 1ère version basée sur ElevenLabs Music (vraie génération IA,
// mais ~0,15$/minute générée — trop cher pour un usage perso régulier,
// retour utilisateur 30/07). Repli sur de VRAIS effets audio ffmpeg (EQ,
// compression, saturation, largeur stéréo, écho, parfois pitch — cf.
// GENRE_DSP_PRESETS/applyGenreEffect, services/ffmpeg.js) appliqués au mix
// des stems EXISTANTS du clip : pas une nouvelle composition, une vraie
// coloration audible du morceau de l'utilisateur, gratuite et quasi
// instantanée (un seul passage ffmpeg, zéro appel réseau externe).
// Réutilise les mêmes réglages mute/solo/volume/pan que /remix-export (repris
// tels quels si fournis, neutres sinon) : l'effet de genre s'applique sur LE
// mix que l'utilisateur est en train d'écouter, pas sur un mix par défaut
// différent.
router.post("/:id/genre-effect", async (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job || job.stemsStatus !== "done")
    return res.status(400).json({ error: "Les stems de ce clip ne sont pas encore prêts." });

  const { genre, stems: mixSettings } = req.body;
  if (!genre) return res.status(400).json({ error: "genre requis" });
  if (!GENRE_DSP_PRESETS[genre]) return res.status(400).json({ error: `Genre inconnu : "${genre}".` });

  const jobOut = join(OUT_DIR, jobId);
  const STEM_KEYS = ["vocals", "drums", "bass", "other"];
  const stemsForMix = [];
  for (const key of STEM_KEYS) {
    const url = key === "vocals" ? (job.vocalsClean || job.vocals) : job[key];
    if (!url) continue;
    const filePath = join(jobOut, url.split("/").pop());
    if (!existsSync(filePath)) continue;
    const s = (mixSettings && mixSettings[key]) || {};
    stemsForMix.push({
      path: filePath,
      volume: typeof s.volume === "number" ? s.volume : 1,
      pan: typeof s.pan === "number" ? s.pan : 0,
      mute: !!s.mute,
      solo: !!s.solo,
    });
  }
  if (stemsForMix.length === 0)
    return res.status(400).json({ error: "Aucun stem disponible pour ce clip." });

  const tmpMixPath = join(TMP_DIR, `genrefx_mix_${jobId}_${Date.now()}.flac`);
  try {
    await mixStemsCustom(stemsForMix, tmpMixPath);

    const safeGenre = genre.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    const outName = `genre_${safeGenre}_${Date.now()}.flac`;
    const outPath = join(jobOut, outName);
    await applyGenreEffect(tmpMixPath, genre, outPath);

    res.json({ url: `/outputs/clip-editor/${jobId}/${outName}` });
  } catch (err) {
    console.error(`❌ [clip-editor] genre-effect ${jobId} (${genre}) échoué :`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    rm(tmpMixPath, { force: true }).catch(() => {});
  }
});

export default router;
