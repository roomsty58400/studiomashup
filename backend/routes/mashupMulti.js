// ── Mashup multi-sources (Phase 5, juillet 2026) ────────────────────────────
// Généralise le mode "stems à la carte" de routes/mashup.js (POST "/", mode
// "stems") à N morceaux (3 à 5) au lieu de strictement 2 (A/B) — cf. roadmap
// (architecture-moteur-mashup-roadmap.md, Phase 5). Scope volontairement
// "backend d'abord" (décision utilisateur) : cette route est fonctionnelle et
// testable via API, mais aucune interface n'a été construite pour elle — le
// reste de l'app (Deck, Mixer, ComboPanel...) reste sur le modèle à 2 decks
// A/B, inchangé.
//
// ── Pourquoi une route SÉPARÉE plutôt qu'une extension de POST "/" ─────────
// routes/mashup.js est le chemin le plus utilisé de toute l'app (chaque
// mashup passe par là) et prepareTrack() y est une fonction de ~200 lignes
// qui gère un cache à 2 niveaux (stems Demucs + analyse Librosa), le
// téléchargement à froid, et le dé-reverb — la toucher pour la généraliser à
// N pistes aurait été le changement à plus haut risque de cette session. Au
// lieu de ça :
//   - Les helpers PURS (scoring, alignement de mesure) ont été extraits tels
//     quels dans services/trackPreparation.js et sont réutilisés ICI aussi.
//   - Cette route n'a PAS de "chemin à froid" : elle EXIGE que chaque piste
//     référencée soit déjà analysée ET séparée (même mode 4 stems) avant
//     l'appel — exactement l'état où se trouve un morceau après avoir été
//     ajouté à un Deck (auto-analyse déclenchée côté front dès la validation
//     de l'URL, cf. /api/analyze). Si une piste n'est pas prête, l'erreur le
//     dit explicitement plutôt que de retomber sur un téléchargement/Demucs
//     à froid ici (qui aurait fallu réimplémenter ET tester en conditions
//     réelles avec plusieurs pistes simultanées — hors budget de cette passe).
//   - Le moteur de combinaison (alignAndCombineStems, mixFullRave) est
//     RÉUTILISÉ SANS AUCUNE MODIFICATION : ces fonctions étaient déjà
//     génériques pour N sources (cf. services/ffmpeg.js), seule la route qui
//     les appelle manquait.
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { rm } from "fs/promises";
import { downloadVideo } from "../services/ytdlp.js";
import {
  alignAndCombineStems, mixFullRave, exportFLAC, muxVideoAudio,
  getDuration, buildMultiSourceVideoMontage,
} from "../services/ffmpeg.js";
import { getTrack } from "../db/index.js";
import { addMashupToHistory } from "../services/mashupHistory.js";
import {
  resolveOutputPath, normalizeStemMode, nonVocalPartsForMode,
  parseBeatTimes, parseStructure, snapToMeasureBoundary, pickBestSegmentPair,
} from "../services/trackPreparation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const outputsDir = join(__dirname, "../data/outputs");
mkdirSync(outputsDir, { recursive: true });

// ── Jobs en mémoire — même pattern que routes/mashup.js, Map dédiée (route
// isolée, cf. commentaire d'en-tête) plutôt que partagée. ──────────────────
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// Lit le cache DB d'une piste et vérifie qu'elle est réellement exploitable
// pour LE mode de stems demandé — mêmes garde-fous que prepareTrack()
// (routes/mashup.js) : stem_mode qui correspond, bpm non nul (pas un repli
// silencieux jamais réellement analysé), fichiers présents sur le disque.
// Ne télécharge/ne sépare RIEN — cf. commentaire d'en-tête du fichier.
const loadPreparedTrack = (trackId, stemMode, index) => {
  const cached = getTrack(trackId);
  if (!cached) {
    throw new Error(`Piste #${index + 1} (${trackId}) : pas encore analysée — ouvre-la dans un Deck au moins une fois avant de créer un mashup multi-sources.`);
  }
  if (cached.bpm == null) {
    throw new Error(`Piste #${index + 1} (${trackId}) : analyse BPM/clé absente ou invalide en cache — relance son analyse depuis un Deck.`);
  }
  if (normalizeStemMode(cached.stem_mode) !== stemMode) {
    throw new Error(`Piste #${index + 1} (${trackId}) : séparée en mode ${cached.stem_mode || "?"} stems, mais ${stemMode} stems demandés — ré-analyse cette piste dans un Deck avec le bon mode.`);
  }
  const nonVocalParts = nonVocalPartsForMode(stemMode) || [];
  const requiredCols = ["vocals_path", ...nonVocalParts.map(p => `${p}_path`)];
  for (const col of requiredCols) {
    const path = cached[col] ? resolveOutputPath(cached[col]) : null;
    if (!path || !existsSync(path)) {
      throw new Error(`Piste #${index + 1} (${trackId}) : stem "${col.replace("_path", "")}" manquant sur le disque — ré-analyse cette piste dans un Deck (mode ${stemMode} stems).`);
    }
  }
  return {
    id: trackId,
    bpm: cached.bpm,
    keyPitch: cached.key_pitch ?? null,
    camelot: cached.camelot ?? null,
    structure: parseStructure(cached.structure_json),
    beatTimes: parseBeatTimes(cached.beat_times_json),
    vocalsPath: resolveOutputPath(cached.vocals_path),
    stemPaths: Object.fromEntries(nonVocalParts.map(p => [p, resolveOutputPath(cached[`${p}_path`])])),
  };
};

// Voix "sans écho" en cache (cf. cleanVocalsReverb dans routes/mashup.js) —
// lecture seule, best-effort : si absente, on utilise la voix brute plutôt
// que de relancer le dé-reverb ici (garde cette route rapide et déterministe,
// cf. commentaire d'en-tête).
const dereverbedVocalsIfCached = (vocalsPath) => {
  const candidate = join(dirname(vocalsPath), "vocals_dereverbed.flac");
  return existsSync(candidate) ? candidate : vocalsPath;
};

// POST /api/mashup-multi (cf. server.js — préfixe dédié, PAS "/api/mashup",
// pour zéro risque de collision avec les routes ":id/status" existantes de
// routes/mashup.js, déjà montées sur "/api/mashup").
router.post("/", async (req, res) => {
  const {
    tracks = [], stemMode: rawStemMode = 4, stemSelection = {},
    crossfade = 0.5, title = "mashup",
    pitchShiftOverride = null, tempoRatioOverride = null,
  } = req.body || {};

  if (!Array.isArray(tracks) || tracks.length < 3 || tracks.length > 5) {
    return res.status(400).json({ error: "tracks doit contenir entre 3 et 5 morceaux (pour 2 morceaux, utilise POST /api/mashup avec mode \"stems\")." });
  }
  const trackIds = tracks.map(t => (typeof t === "string" ? t : t?.id)).filter(Boolean);
  if (trackIds.length !== tracks.length) {
    return res.status(400).json({ error: "Chaque entrée de tracks doit être un id YouTube (string) ou { id }." });
  }

  const stemMode = normalizeStemMode(rawStemMode);
  if (stemMode === 2) {
    return res.status(400).json({ error: "Le mode 2 stems (voix/instru complet) n'a pas de stems individuels à répartir — choisis le mode 4 stems." });
  }
  const nonVocalParts = nonVocalPartsForMode(stemMode);
  const requiredKeys = ["vocals", ...nonVocalParts];
  for (const key of requiredKeys) {
    const idx = stemSelection[key];
    if (!Number.isInteger(idx) || idx < 0 || idx >= trackIds.length) {
      return res.status(400).json({ error: `stemSelection.${key} doit être un index valide vers tracks (0-${trackIds.length - 1}).` });
    }
  }

  const jobId = uuidv4();
  const tmpDir = join(__dirname, "../tmp", jobId);
  mkdirSync(tmpDir, { recursive: true });
  updateJob(jobId, { status: "running", step: 0, label: "Préparation" });
  res.json({ jobId });

  (async () => {
    try {
      // ── 1. Chargement des pistes déjà analysées (aucun téléchargement ici,
      // cf. commentaire d'en-tête) ────────────────────────────────────────
      const prepared = trackIds.map((id, i) => loadPreparedTrack(id, stemMode, i));

      // ── 2. Ancre = piste majoritaire parmi les stems NON-vocaux choisis
      // (généralisation N-way du vote A/B existant, cf. routes/mashup.js) —
      // en cas d'égalité, préfère la piste voix si elle est parmi les
      // gagnantes ex-æquo (cohérence tonale avec la voix), sinon l'index le
      // plus bas (déterministe). ─────────────────────────────────────────
      const votes = new Map();
      for (const part of nonVocalParts) {
        const idx = stemSelection[part];
        votes.set(idx, (votes.get(idx) || 0) + 1);
      }
      const maxVotes = Math.max(...votes.values());
      const leaders = [...votes.entries()].filter(([, v]) => v === maxVotes).map(([idx]) => idx);
      const anchorIdx = leaders.includes(stemSelection.vocals) ? stemSelection.vocals : Math.min(...leaders);
      const anchor = prepared[anchorIdx];
      console.log(`[mashupMulti] ${jobId} : ${trackIds.length} pistes, voix=#${stemSelection.vocals} ${nonVocalParts.map(p => `${p}=#${stemSelection[p]}`).join(" ")} — ancre=#${anchorIdx} (BPM ${anchor.bpm}, ${anchor.camelot || "?"})`);

      // ── 3. Instrumental composite (réutilise alignAndCombineStems, déjà
      // générique pour N parts — AUCUNE modification de cette fonction) ───
      updateJob(jobId, { step: 1, label: "Alignement + combinaison des stems choisis" });
      const instruDir = join(tmpDir, "stems_composite");
      mkdirSync(instruDir, { recursive: true });
      const instruComposite = join(instruDir, "instrumental_composite.flac");
      const stemParts = nonVocalParts.map((part) => {
        const idx = stemSelection[part];
        const src = prepared[idx];
        return {
          path: src.stemPaths[part],
          bpm: src.bpm, camelot: src.camelot, keyPitch: src.keyPitch,
          label: `${part}_${idx}`,
          allowPitchShift: part !== "drums",
        };
      });
      await alignAndCombineStems(stemParts, anchor.bpm, anchor.camelot, anchor.keyPitch, instruComposite);

      // ── 4. Voix + alignement (réutilise pickBestSegmentPair/snapToMeasure-
      // Boundary EXTRAITS de routes/mashup.js — logique inchangée) ─────────
      const vocalsTrack = prepared[stemSelection.vocals];
      const vocalsPath = dereverbedVocalsIfCached(vocalsTrack.vocalsPath);

      const { offsetA: vocalsOffset, offsetB: anchorOffset, harmonicScore, energyScore, reason } =
        pickBestSegmentPair(vocalsTrack.structure, anchor.structure);
      console.log(`[mashupMulti] ${jobId} : appariement segments — ${reason}`);
      const segmentCompatAvg = (harmonicScore + energyScore) / 2;
      const duckingRatio = segmentCompatAvg >= 75 ? 2.0 : segmentCompatAvg >= 50 ? 2.5 : 3.2;
      const vocalsStartOffset = snapToMeasureBoundary(vocalsOffset, vocalsTrack.beatTimes, vocalsTrack.bpm);
      const instruStartOffset = snapToMeasureBoundary(anchorOffset, anchor.beatTimes, anchor.bpm);
      const finalMeasureDur = vocalsTrack.bpm > 0 ? (4 * 60 / vocalsTrack.bpm) : 2.0;
      const introMeasures = Math.max(1, Math.round(4.0 / finalMeasureDur));
      const vocalDelayMs = Math.round(introMeasures * finalMeasureDur * 1000);

      // ── 5. Montage vidéo à N sources EN PARALLÈLE du mixage audio (même
      // principe que routes/mashup.js — cf. commentaire détaillé là-bas) ───
      // Vidéos téléchargées pour les seuls index DISTINCTS réellement
      // utilisés (une piste peut fournir 2+ stems, ex: vocals ET bass du
      // même morceau — inutile de la télécharger 2 fois).
      const usedIndices = [...new Set([stemSelection.vocals, ...nonVocalParts.map(p => stemSelection[p])])].sort((a, b) => a - b);
      const videoPaths = new Map(); // idx -> chemin local
      const videoDir = join(tmpDir, "video");
      mkdirSync(videoDir, { recursive: true });
      // Téléchargements vidéo EN PARALLÈLE (contrairement au téléchargement
      // AUDIO de prepareTrack, qui doit rester séquentiel — cf. le REVERT
      // documenté dans routes/mashup.js : ce bug de collision yt-dlp est
      // spécifique au chemin audio à froid, absent ici puisque cette route
      // ne télécharge JAMAIS d'audio, cf. commentaire d'en-tête. Le
      // téléchargement vidéo, lui, tourne déjà en parallèle sans problème
      // dans routes/mashup.js — downloadVideo(trackA)/downloadVideo(trackB).
      const videoDownloadPromise = Promise.all(usedIndices.map(async (idx) => {
        const p = join(videoDir, `vid_${idx}.mp4`);
        await downloadVideo(trackIds[idx], p, 1080);
        videoPaths.set(idx, p);
      }));
      videoDownloadPromise.catch(() => {});

      const silentFile = join(tmpDir, `silent.mp4`);
      let videoMontagePromise = null;
      if (tempoRatioOverride == null) {
        const vocalsDurationForVideo = await getDuration(vocalsTrack.vocalsPath);
        const totalSecEstimate = (vocalDelayMs / 1000) + Math.max(0, vocalsDurationForVideo - vocalsStartOffset);
        videoMontagePromise = (async () => {
          await videoDownloadPromise;
          // Ordre des vidéos = usedIndices (croissant) — DOIT correspondre à
          // l'ordre attendu par la suite (aucun mapping supplémentaire requis
          // ici, buildMultiSourceVideoMontage ne connaît que des indices 0..N-1
          // locaux à CE tableau, indépendants des index globaux de tracks[]).
          const orderedPaths = usedIndices.map(idx => videoPaths.get(idx));
          await buildMultiSourceVideoMontage(orderedPaths, totalSecEstimate, parseFloat(crossfade), silentFile,
            { beatTimes: vocalsTrack.beatTimes, structure: vocalsTrack.structure });
        })();
        videoMontagePromise.catch(() => {});
      }

      // ── 6. Mixage final (mixFullRave — AUCUNE modification, déjà générique
      // dès lors qu'on lui donne 1 voix + 1 instrumental composite) ────────
      updateJob(jobId, { step: 2, label: "Mixage voix + instrumental composite" });
      const mixedWav = join(tmpDir, "mixed.wav");
      await mixFullRave(vocalsPath, instruComposite, vocalsTrack.bpm, anchor.bpm, parseFloat(crossfade), mixedWav,
        { keyVocals: vocalsTrack.keyPitch, keyInstru: anchor.keyPitch, camelotVocals: vocalsTrack.camelot, camelotInstru: anchor.camelot,
          vocalsStartOffset, instruStartOffset, vocalDelayMs, duckingRatio,
          beatTimesVocals: vocalsTrack.beatTimes, beatTimesInstru: anchor.beatTimes,
          manualSemitoneShift: pitchShiftOverride, manualTempoRatio: tempoRatioOverride });

      // ── 7. Export final : FLAC + MP4 en parallèle ────────────────────────
      updateJob(jobId, { step: 3, label: "Export final (FLAC + MP4)" });
      const safeName = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const baseName = `${safeName}_${jobId.slice(0, 8)}`;
      const flacFile = join(outputsDir, `${baseName}.flac`);
      const mp4File = join(outputsDir, `${baseName}.mp4`);

      await Promise.all([
        exportFLAC(mixedWav, flacFile),
        (async () => {
          if (videoMontagePromise) {
            await videoMontagePromise;
            await muxVideoAudio(silentFile, mixedWav, mp4File);
          }
        })(),
      ]);

      const flacUrl = `/outputs/${baseName}.flac`;
      const mp4Url = videoMontagePromise && existsSync(mp4File) ? `/outputs/${baseName}.mp4` : null;
      updateJob(jobId, { status: "done", step: 4, label: "Terminé !", flacUrl, mp4Url, title });
      // Persistance historique (même correctif que routes/mashup.js, cf.
      // services/mashupHistory.js) — pas de piste vidéo muette côté multi.
      addMashupToHistory({ id: jobId, title, flacUrl, mp4Url, silentUrl: null });
      console.log(`✅ [mashupMulti] ${jobId} terminé : ${flacUrl}${mp4Url ? " + " + mp4Url : ""}`);
    } catch (err) {
      console.error(`❌ [mashupMulti] ${jobId} échoué :`, err.message);
      updateJob(jobId, { status: "error", message: err.message });
    } finally {
      // .catch() plutôt qu'un simple await : sur Windows, un process ffmpeg
      // tout juste tué (timeout dépassé, cf. execAsync dans ffmpeg.js) peut
      // garder son fichier de sortie verrouillé quelques instants même après
      // le rejet de la promesse — rm() peut alors échouer avec EBUSY (constaté
      // en conditions réelles lors des tests de cette route). Sans ce filet,
      // cette erreur de nettoyage devenait une exception NON gérée qui
      // faisait planter tout le process Node (donc TOUT le serveur, pas
      // seulement ce job) — un simple dossier tmp orphelin est un problème
      // largement moins grave qu'un crash serveur complet.
      await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[mashupMulti] ${jobId} : nettoyage tmpDir incomplet (${err.code || err.message}) — sans conséquence sur les livrables déjà produits dans data/outputs.`);
      });
    }
  })();
});

export default router;
