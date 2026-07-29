import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { copyFile, rm, unlink, stat, readFile } from "fs/promises";
import { execFile } from "child_process";
import { downloadAudio, downloadVideo } from "../services/ytdlp.js";
import { extractAudio, mixQuick, mixSmart, mixFullRave, mixFullRaveDuo, mixFullOverlay, exportFLAC, exportMP4_916, buildSilentVideoMontage, muxVideoAudio, getCachedInstrumental, alignAndCombineStems, getDuration, normalizeStemLoudness } from "../services/ffmpeg.js";
import { analyzeAudio } from "../services/analyzer.js";
import { separateStems, separateStemsFull } from "../services/demucs.js";
import { getTrack } from "../db/index.js";
import { dereverbVocals } from "../services/dereverb.js";
import { runCpuLimited } from "../services/cpuQueue.js";
import { cleanupMediaFiles } from "../services/cleanup.js";
import { addMashupToHistory } from "../services/mashupHistory.js";
// Phase 5 (juillet 2026) : ces helpers étaient des closures locales de ce
// fichier — extraits tels quels (logique inchangée) dans un module partagé
// pour être réutilisés par routes/mashupMulti.js (mashup à N pistes) sans
// dupliquer ~150 lignes de scoring/alignement. Cf. services/trackPreparation.js
// pour le détail de ce qui a (et n'a volontairement PAS) été extrait.
import {
  resolveOutputPath, normalizeStemMode, nonVocalPartsForMode,
  parseBeatTimes, parseStructure, parseDrops, deriveHighlightTimes, findHighEnergyOffset,
  snapToMeasureBoundary, pickBestSegmentPair,
} from "../services/trackPreparation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Multer : upload temporaire des fichiers audio ──
// Extension whitelistée plutôt qu'acceptée telle quelle (audit juillet 2026,
// défense en profondeur) : ce nom de fichier repart ensuite tel quel dans
// des commandes ffmpeg (exec/execAsync avec interpolation de chaîne,
// services/clipEditor.js) — extname(file.originalname) sans validation
// laisserait passer n'importe quelle chaîne fournie par le client après le
// dernier "." de son nom de fichier original. Sur Windows, NTFS interdit déjà
// le caractère '"' dans un nom de fichier (ce qui bloque en pratique
// l'évasion la plus simple d'une commande shell interpolée), mais s'appuyer
// sur cette limite incidente du système de fichiers plutôt que sur une
// validation explicite est fragile — whitelist explicite à la place.
const ALLOWED_AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".opus", ".webm"]);
const safeAudioExt = (originalName) => {
  const ext = extname(originalName || "").toLowerCase();
  return ALLOWED_AUDIO_EXT.has(ext) ? ext : ".mp3";
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, "../tmp")),
  filename: (req, file, cb) => {
    cb(null, `upload_${uuidv4()}${safeAudioExt(file.originalname)}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

// ── Téléchargement forcé (audit juillet 2026 — Content-Disposition) ────────
// /outputs est servi en express.static (server.js), SANS Content-Disposition.
// Les boutons ⬇ du frontend (MashupStudio, MashupsBar, MashupProgressModal...)
// pointent vers ces URLs avec l'attribut HTML `download` ou via window.open() :
// les deux sont sans effet en cross-origin (frontend :5173 → backend :3001 =
// origines différentes pour le navigateur), qui ouvre/joue le fichier au lieu
// de le télécharger. Route générique réutilisable par tout composant qui
// détient déjà une URL "/outputs/..." (flacUrl/mp4Url/silentUrl, quel que soit
// la route qui les a produites — mashup simple, multi, stems...) : réutilise
// resolveOutputPath (anti-traversée déjà durci, cf. trackPreparation.js) pour
// ne jamais servir un chemin hors de data/outputs, puis res.download() force
// Content-Disposition: attachment quelle que soit l'origine de la requête —
// même pattern déjà en place sur stems.js/clipEditor.js/radio.js.
router.get("/download", (req, res) => {
  const { url, name } = req.query;
  const filePath = resolveOutputPath(url);
  if (!filePath || !existsSync(filePath)) {
    return res.status(404).json({ error: "Fichier introuvable." });
  }
  const ext = extname(filePath);
  const safeName = String(name || "mashup").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80) || "mashup";
  res.download(filePath, `${safeName}${ext}`);
});

// ── Upload d'un fichier audio ──
router.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  res.json({ fileId: req.file.filename });
});

const jobs = new Map();

// ── Verrou anti-doublon (même principe que routes/analyze.js, audit juillet
// 2026) ── Sans ça, un double-clic sur "Générer" (ou 2 onglets sur la même
// paire) lançait 2 pipelines complets EN PARALLÈLE (téléchargement + Demucs
// GPU + ffmpeg) pour le même mashup — calcul gaspillé en double, et risque
// de collision d'écriture dans data/outputs/analyze/<videoId> (le cache de
// stems PARTAGÉ entre les 2 pistes du mashup, cf. prepareTrack). Clé =
// (idA, idB, mode, stemMode, durationMode) ; ne s'applique qu'aux morceaux
// YouTube (id stable) — un upload de fichier local génère de toute façon un
// nom de fichier temporaire unique à chaque fois, donc pas de vraie
// collision possible dans ce cas.
const activeMashups = new Map(); // lockKey -> jobId
const isJobActive = (id) => {
  const job = jobs.get(id);
  return !!job && job.status !== "done" && job.status !== "error";
};
const updateJob = (id, patch) => {
  const job = jobs.get(id) || {};
  jobs.set(id, { ...job, ...patch, updatedAt: Date.now() });
};
// ── Mise à jour de progression "monotone" (perf audit juillet 2026) ──
// prepareTrack(A) et prepareTrack(B) tournent maintenant EN PARALLÈLE
// (cf. Promise.all plus bas — gain de temps sur le téléchargement/extraction/
// analyse, qui n'ont aucune raison d'être sérialisés entre les 2 pistes ;
// seuls les appels GPU eux-mêmes restent sérialisés, via services/gpuQueue.js).
// Chaque piste écrit dans le MÊME job (un seul job par mashup), donc leurs
// updateJob({step, ...}) s'entremêlent désormais dans le temps — sans garde,
// la barre de progression (frontend, purement pilotée par ce "step" numérique)
// pourrait ponctuellement reculer (ex: piste B démarre "step 0" juste après
// que piste A soit passée à "step 2"). On ne laisse jamais "step" reculer.
const updateJobStep = (id, patch) => {
  const job = jobs.get(id) || {};
  const step = patch.step != null && job.step != null ? Math.max(job.step, patch.step) : patch.step;
  updateJob(id, { ...patch, ...(patch.step != null ? { step } : {}) });
};

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ── Nettoyage des fichiers générés (FLAC/MP3/MP4/WAV) ──
// Appelé quand l'utilisateur bascule le bouton ON/OFF du Mixer sur OFF :
// supprime les fichiers temporaires produits par un macheup (cover IA exclue,
// gérée par sa propre route). basename() + vérif outDir évite toute
// traversée de chemin (../../etc) à partir des URLs reçues du client.
//
// + balayage .wav de tmp/ (ajouté juillet 2026) : les .wav intermédiaires
// (extraction audio, mixage — cf. a.wav/b.wav/mixed.wav plus bas dans ce
// fichier) vivent dans des sous-dossiers de job normalement autonettoyés
// (finally/rm(jobTmp)) — mais un job interrompu avant ce finally (crash,
// fermeture brutale du serveur) peut laisser des .wav orphelins qui ne
// repartent jamais tout seuls. Scopé à tmp/ UNIQUEMENT (pas data/outputs) :
// ne touche donc jamais aux stems/instrumentaux déjà mis en cache pour
// d'autres morceaux — seulement les .wav (par définition toujours du
// intermédiaire jetable, jamais un résultat final gardé). C'est le même
// mécanisme que le grand nettoyage 🧹 (services/cleanup.js), juste restreint
// à un sous-ensemble sûr pour un simple OFF plutôt que le grand ménage complet.
const outputsDir = join(__dirname, "../data/outputs");
const tmpRootDir = join(__dirname, "../tmp");
router.post("/cleanup", async (req, res) => {
  const { flacUrl, mp4Url } = req.body || {};
  const urls = [flacUrl, mp4Url].filter(Boolean);
  const deleted = [];
  for (const url of urls) {
    try {
      const name = basename(url);
      const filePath = join(outputsDir, name);
      if (filePath.startsWith(outputsDir) && existsSync(filePath)) {
        await unlink(filePath);
        deleted.push(name);
      }
    } catch (e) {
      console.warn("[mashup/cleanup] échec suppression :", url, e.message);
    }
  }
  const wavStats = cleanupMediaFiles([tmpRootDir], "ON/OFF Mixer", new Set([".wav"]));
  res.json({ ok: true, deleted, wavDeleted: wavStats.deleted });
});

// ── [OUTIL DE DÉVELOPPEMENT UNIQUEMENT — À SUPPRIMER AVANT DÉPLOIEMENT] ────
// Ouvre un fichier généré (FLAC/MP4) dans VLC (ou le lecteur par défaut du
// système en repli) directement depuis le serveur — permet de vérifier si un
// problème audio (ex: "superposition" perçue dans le Mixer) vient du fichier
// généré lui-même ou seulement de la lecture dans le navigateur, en
// comparant les deux. N'a de sens QUE sur la machine de développement : le
// serveur exécute une commande shell locale pour ouvrir une appli
// bureautique, ce qui n'est ni possible ni souhaitable une fois le site
// déployé sur une machine distante/multi-utilisateurs.
// Repasser DEV_OPEN_EXTERNAL_ENABLED à false (ou supprimer cette route et le
// bouton "Ouvrir dans VLC" côté Mixer.jsx) avant tout déploiement public.
const DEV_OPEN_EXTERNAL_ENABLED = true;
const VLC_CANDIDATE_PATHS = [
  "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
  "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
];
router.post("/open-external", (req, res) => {
  if (!DEV_OPEN_EXTERNAL_ENABLED) {
    return res.status(403).json({ error: "Fonction de développement désactivée." });
  }
  const filePath = resolveOutputPath((req.body || {}).url);
  if (!filePath || !existsSync(filePath)) {
    return res.status(400).json({ error: "Fichier introuvable." });
  }
  const vlcPath = VLC_CANDIDATE_PATHS.find(p => existsSync(p));
  // execFile (argv séparé) plutôt que exec (chaîne shell) — audit juillet
  // 2026 : filePath est déjà contraint sous data/outputs par
  // resolveOutputPath, mais son NOM de fichier reste en partie dérivé de
  // l'entrée cliente (req.body.url) et n'était pas jusqu'ici garanti sans
  // guillemets/métacaractères shell (`"`, `;`, `&`, ...) avant d'être
  // interpolé tel quel dans une commande `exec()`. Avec execFile, filePath
  // est passé comme UN SEUL argument au processus cible, sans jamais passer
  // par un interpréteur shell — même un nom de fichier "hostile" ne peut
  // plus être interprété comme une commande.
  const openWithDefault = () => {
    // explorer.exe (plutôt que "cmd /c start", qui reste un interpréteur
    // shell) : ouvre le fichier avec son appli associée sans re-parser la
    // ligne de commande. Note : explorer.exe renvoie parfois un code de
    // sortie non nul même quand l'ouverture réussit (particularité Windows
    // connue) — on ne traite donc pas un code d'erreur comme un échec ici.
    execFile("explorer.exe", [filePath], () => {
      res.json({ ok: true, via: "default" });
    });
  };
  if (vlcPath) {
    execFile(vlcPath, [filePath], (err) => {
      if (err) {
        console.warn("[mashup/open-external] échec ouverture VLC, repli lecteur système :", err.message);
        return openWithDefault();
      }
      res.json({ ok: true, via: "vlc" });
    });
  } else {
    console.warn("[mashup/open-external] VLC introuvable aux emplacements habituels — repli sur le lecteur par défaut du système.");
    openWithDefault();
  }
});

// resolveOutputPath : importé de services/trackPreparation.js (Phase 5) —
// cf. en-tête de fichier pour le détail de cette extraction.

// normalizeStemMode / nonVocalPartsForMode : importés de
// services/trackPreparation.js (Phase 5) — cf. en-tête de fichier.

// ── Cadre "combos" (à gauche de Mes MacheUps) — assemble la voix FLAC d'un
// deck avec l'instrumental FLAC de l'autre deck (mixFullRave, même moteur que
// le mode FULL du mashup principal : loudnorm + sidechain ducking + calage
// tempo), pour proposer un aperçu écoutable avant de créer un mashup
// personnalisé avec la vidéo silencieuse.
router.post("/combine-stems", async (req, res) => {
  const { vocalsUrl, instrumentalUrl, bpmA, bpmB, crossfade = 0.5, keyVocals, keyInstru,
          camelotVocals, camelotInstru, pitchShiftOverride = null, tempoRatioOverride = null } = req.body || {};
  const vocalsPath = resolveOutputPath(vocalsUrl);
  const instruPath = resolveOutputPath(instrumentalUrl);
  if (!vocalsPath || !instruPath || !existsSync(vocalsPath) || !existsSync(instruPath)) {
    return res.status(400).json({ error: "Fichiers voix/instru introuvables." });
  }
  try {
    const id = uuidv4().slice(0, 8);
    const outFile = join(outputsDir, `combo_${id}.flac`);
    // Retour utilisateur : sur ces 2 pistes "combos", la voix ressort trop
    // forte par rapport à l'instru — équilibre décalé de 4 dB en faveur de
    // l'instru (voix -2 dB / instru +2 dB) + ducking plus doux (1.5 au lieu
    // de 2.5) pour que l'instru reste audible pendant la voix, PLUS une baisse
    // sèche de 1 dB supplémentaire sur la voix seule (vocalsTrimDb).
    // camelotVocals/camelotInstru (notation roue de Camelot, ex "8B") permet
    // une correction harmonique plus fine que keyVocals/keyInstru seuls (note
    // brute) : autorise l'unisson, la relative majeur/mineur ou une tonalité
    // voisine, et choisit le plus petit décalage parmi ces options
    // compatibles, au lieu de forcer systématiquement l'unisson strict (cf.
    // camelotAwareShift dans services/ffmpeg.js).
    // runCpuLimited (diagnostic capture terminal fournie par l'utilisateur) :
    // les 4 combos sont demandés en parallèle par le frontend dès que les 2
    // decks sont prêts — sans plafond, jusqu'à 4 mixFullRave/mixFullRaveDuo
    // (donc une dizaine de process ffmpeg, 2-3 chacun) se disputaient le CPU
    // en même temps, ralentissant l'encodage bien en dessous du temps réel
    // (speed=0.476x observé) au point de dépasser le timeout ci-dessous —
    // d'où les 4 combos en échec simultané. cf. services/cpuQueue.js.
    await runCpuLimited(() => mixFullRave(vocalsPath, instruPath, bpmA || null, bpmB || null, parseFloat(crossfade), outFile,
      { balanceOffsetDb: 4, duckingRatio: 1.5, vocalsTrimDb: 1, keyVocals: keyVocals || null, keyInstru: keyInstru || null,
        camelotVocals: camelotVocals || null, camelotInstru: camelotInstru || null,
        manualSemitoneShift: pitchShiftOverride, manualTempoRatio: tempoRatioOverride }));
    res.json({ url: `/outputs/combo_${id}.flac` });
  } catch (e) {
    console.error("[mashup/combine-stems] échec :", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Combo DUO : voix A + voix B alternées mesure→mesure sur un instrumental
// au choix (Instru A ou Instru B). Appelle mixFullRaveDuo qui réalise un gate
// volume par frame : voix A sur mesures paires, voix B sur mesures impaires.
// Les 2 voix sont pitch-shiftées indépendamment pour rejoindre la tonalité
// de l'instru choisi (camelotAwareShift côté ffmpeg.js).
router.post("/combine-stems-duo", async (req, res) => {
  const {
    vocalsUrlA, vocalsUrlB, instrumentalUrl,
    bpmA, bpmB, bpmInstru,
    crossfade = 0.5,
    keyVocalsA, keyVocalsB, keyInstru,
    camelotVocalsA, camelotVocalsB, camelotInstru,
  } = req.body || {};

  const vocalsPathA = resolveOutputPath(vocalsUrlA);
  const vocalsPathB = resolveOutputPath(vocalsUrlB);
  const instruPath  = resolveOutputPath(instrumentalUrl);

  if (!vocalsPathA || !vocalsPathB || !instruPath
      || !existsSync(vocalsPathA) || !existsSync(vocalsPathB) || !existsSync(instruPath)) {
    return res.status(400).json({ error: "Fichiers voix A / voix B / instru introuvables." });
  }

  try {
    const id = uuidv4().slice(0, 8);
    const outFile = join(outputsDir, `combo_duo_${id}.flac`);
    // Même réglage que /combine-stems : voix légèrement en retrait vs instru
    // (balanceOffsetDb 4 + vocalsTrimDb 1) et sidechain doux (1.5).
    // runCpuLimited : cf. commentaire détaillé dans /combine-stems ci-dessus
    // (même file d'attente CPU partagée, services/cpuQueue.js).
    await runCpuLimited(() => mixFullRaveDuo(
      vocalsPathA, vocalsPathB, instruPath,
      bpmA || null, bpmB || null, bpmInstru || null,
      parseFloat(crossfade), outFile,
      {
        balanceOffsetDb: 4, duckingRatio: 1.5, vocalsTrimDb: 1,
        keyVocalsA: keyVocalsA || null, keyVocalsB: keyVocalsB || null, keyInstru: keyInstru || null,
        camelotVocalsA: camelotVocalsA || null, camelotVocalsB: camelotVocalsB || null, camelotInstru: camelotInstru || null,
      },
    ));
    res.json({ url: `/outputs/combo_duo_${id}.flac` });
  } catch (e) {
    console.error("[mashup/combine-stems-duo] échec :", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Durée de sortie "tailored" (mode optionnel, audit RaveDJ juillet 2026) ─
// RaveDJ ne produit jamais un mashup de la longueur complète d'une chanson
// source — 2 tests réels ont donné 1:49 et 3:08, jamais la durée d'un
// morceau entier. Le comportement historique de MacheUp (mode "full",
// inchangé par défaut) fait durer le mashup aussi longtemps que la voix
// choisie, du segment sélectionné jusqu'à sa fin naturelle — souvent 3-4+
// min. Cette fonction calcule une durée de sortie resserrée à la façon de
// RaveDJ : elle part du segment structurel (structure[], cf. analyzer.js)
// qui contient le point de départ choisi par pickBestSegmentPair, et s'arrête
// à sa fin — en incluant le segment suivant si le premier est trop court
// (< 45s) pour éviter une coupe qui tomberait en plein milieu d'une phrase.
// Bornée à [TAILORED_MIN_SEC, TAILORED_MAX_SEC], une fourchette centrée sur
// la plage observée chez RaveDJ (109-188s), avec un peu de marge de chaque
// côté plutôt que de coller exactement aux 2 seuls échantillons mesurés.
const TAILORED_MIN_SEC = 70, TAILORED_MAX_SEC = 180;
const computeTailoredMaxDuration = (structure, startOffset, vocalDelaySec) => {
  if (!Array.isArray(structure) || !structure.length) return null; // pas de structure exploitable → repli sur "full" (appelant gère le null)
  let idx = structure.findIndex(s => startOffset >= s.start && startOffset < s.end);
  if (idx === -1) idx = structure.length - 1;
  let endTime = structure[idx].end;
  if (endTime - startOffset < 45 && idx + 1 < structure.length) {
    endTime = structure[idx + 1].end;
  }
  const span = Math.max(0, endTime - startOffset);
  const total = vocalDelaySec + span;
  return Math.min(Math.max(total, TAILORED_MIN_SEC), TAILORED_MAX_SEC);
};

// ── Prévisualisation audio du mashup "à la carte" ─────────────────────────
// Demande explicite : pouvoir ÉCOUTER le résultat d'une combinaison de stems
// (voix/batterie/basse/autres, chacun A ou B) AVANT de lancer la génération
// complète (audio + vidéo + pochette), bien plus longue. Réutilise le même
// moteur que le mode "stems" du POST "/" principal (alignAndCombineStems +
// mixFullRave), mais en lisant directement les stems déjà en cache SQLite
// (aucun téléchargement, aucun Demucs relancé — les 2 morceaux sont déjà
// forcément analysés à ce stade, puisque c'est ce qui alimente ce même
// cadre côté Mixer.jsx) et SANS export vidéo : quelques secondes au lieu de
// plusieurs minutes.
// Simplification volontaire par rapport au mode "stems" complet : pas de
// recherche du meilleur couple de segments (pickBestSegmentPair) ni de
// ducking adaptatif — on part du tout début des 2 morceaux avec un réglage
// fixe raisonnable. C'est un aperçu rapide, pas le rendu final : la
// génération complète (bouton "GÉNÉRER CE MASHUP À LA CARTE") applique elle
// tout le raffinement habituel.
router.post("/preview-stems", async (req, res) => {
  const { videoIdA, videoIdB, stemSelection, crossfade = 0.5 } = req.body || {};
  if (!videoIdA || !videoIdB) return res.status(400).json({ error: "videoIdA et videoIdB requis." });

  const trackA = getTrack(videoIdA);
  const trackB = getTrack(videoIdB);
  if (!trackA || trackA.bpm == null || !trackB || trackB.bpm == null) {
    return res.status(400).json({ error: "Les 2 morceaux doivent être analysés (BPM/clé) avant de prévisualiser." });
  }
  // Mode-aware (sélecteur 2/4 stems) : construit dynamiquement la liste des
  // stems non-vocaux à partir du stem_mode réellement enregistré pour chaque
  // morceau, plutôt qu'une liste figée à drums/bass/other — cf. même logique
  // que dans prepareTrack (mode "stems" du POST "/" principal).
  const stemPathsOf = (t) => {
    const parts = nonVocalPartsForMode(t.stem_mode);
    if (!parts) return null; // mode "2" : pas de stems individuels
    const cols = ["vocals_path", ...parts.map(p => `${p}_path`)];
    if (!cols.every(c => t[c])) return null;
    const out = {};
    for (const c of cols) out[c.replace(/_path$/, "")] = resolveOutputPath(t[c]);
    return out;
  };
  const stemsA = stemPathsOf(trackA);
  const stemsB = stemPathsOf(trackB);
  if (!stemsA || !stemsB || !Object.values(stemsA).every(existsSync) || !Object.values(stemsB).every(existsSync)) {
    return res.status(400).json({ error: "Stems individuels indisponibles pour l'un des 2 morceaux (mode 4 stems requis) — attends la fin de l'analyse automatique du Deck." });
  }

  try {
    const nonVocalKeys = Object.keys(stemsA).filter(k => k !== "vocals" && k in stemsB);
    const pick = (part) => (stemSelection?.[part] === "B" ? "B" : "A");
    const originOf = Object.fromEntries(nonVocalKeys.map(part => [part, pick(part)]));
    const votesB = Object.values(originOf).filter(o => o === "B").length;
    const anchorSide = votesB > nonVocalKeys.length / 2 ? "B" : "A";
    const anchorTrack = anchorSide === "A" ? trackA : trackB;
    const anchorStems = anchorSide === "A" ? stemsA : stemsB;
    const otherStems = anchorSide === "A" ? stemsB : stemsA;
    const otherTrack = anchorSide === "A" ? trackB : trackA;

    const stemParts = nonVocalKeys.map((part) => {
      const side = originOf[part];
      const stems = side === anchorSide ? anchorStems : otherStems;
      const track = side === anchorSide ? anchorTrack : otherTrack;
      return {
        path: stems[part], bpm: track.bpm, camelot: track.camelot, keyPitch: track.key_pitch,
        label: `${part}_${side}`, allowPitchShift: part !== "drums",
      };
    });

    const vocalsSide = pick("vocals");
    const vocalsStems = vocalsSide === "A" ? stemsA : stemsB;
    const vocalsTrack = vocalsSide === "A" ? trackA : trackB;

    const id = uuidv4().slice(0, 8);
    const workDir = join(outputsDir, "tmp_preview", id);
    mkdirSync(workDir, { recursive: true });
    const instruComposite = join(workDir, "instrumental_composite.flac");
    await alignAndCombineStems(stemParts, anchorTrack.bpm, anchorTrack.camelot, anchorTrack.key_pitch, instruComposite);

    const outFile = join(outputsDir, `stems_preview_${id}.flac`);
    await runCpuLimited(() => mixFullRave(vocalsStems.vocals, instruComposite, vocalsTrack.bpm, anchorTrack.bpm, parseFloat(crossfade), outFile,
      { balanceOffsetDb: 4, duckingRatio: 2.0, vocalsTrimDb: 1,
        keyVocals: vocalsTrack.key_pitch, keyInstru: anchorTrack.key_pitch,
        camelotVocals: vocalsTrack.camelot, camelotInstru: anchorTrack.camelot }));

    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    res.json({ url: `/outputs/stems_preview_${id}.flac` });
  } catch (e) {
    console.error("[mashup/preview-stems] échec :", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Mashup personnalisé : recombine la vidéo silencieuse déjà générée pour le
// mashup du Mixer avec le fichier audio combiné choisi par l'utilisateur dans
// le cadre "combos" — simple mux (copie du flux vidéo), pas de ré-encodage.
router.post("/personalize", async (req, res) => {
  const { silentVideoUrl, audioUrl, title = "mashup perso" } = req.body || {};
  const videoPath = resolveOutputPath(silentVideoUrl);
  const audioPath = resolveOutputPath(audioUrl);
  if (!videoPath || !audioPath || !existsSync(videoPath) || !existsSync(audioPath)) {
    return res.status(400).json({ error: "Vidéo silencieuse ou audio combiné introuvable." });
  }
  try {
    const safeName = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const id = uuidv4().slice(0, 8);
    const outFile = join(outputsDir, `${safeName}_${id}_perso.mp4`);
    await muxVideoAudio(videoPath, audioPath, outFile);
    res.json({ url: `/outputs/${safeName}_${id}_perso.mp4` });
  } catch (e) {
    console.error("[mashup/personalize] échec :", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  // Accepte l'ancien format (videoA/videoB) et le nouveau (trackA/trackB)
  const { videoA, videoB, trackA: tA, trackB: tB,
          mode = "full", crossfade = 0.5, title = "mashup",
          // ── Longueur de sortie (demande explicite, audit RaveDJ juillet 2026) ──
          // "full" (défaut, comportement historique inchangé) = le mashup dure
          // aussi longtemps que la voix choisie (du segment sélectionné à sa
          // fin) — peut faire 3-4+ min selon le morceau source.
          // "tailored" = plafonne la sortie à une durée resserrée autour du
          // segment le mieux assorti (harmonie+énergie), à la façon de RaveDJ
          // qui ne produit JAMAIS un mashup de la longueur complète d'une
          // chanson (constaté : 1:49 et 3:08 sur 2 tests réels) — cf.
          // computeTailoredMaxDuration plus bas et maxDurationSec dans
          // services/ffmpeg.js::mixFullRave.
          durationMode = "full",
          // Mode de séparation Demucs choisi dans le cadre COMBO (2/4/6
          // stems, cf. ComboPanel.jsx) — piloté globalement pour les 2
          // decks, donc transmis ici tel quel plutôt que déduit du cache.
          stemMode: rawStemMode = 4,
          // ── "Pitch fader" manuel (Mixer.jsx, panneau "Réglages avancés") ──
          // null/absent = comportement automatique inchangé. Fournis par
          // l'utilisateur pour forcer un décalage de tonalité (demi-tons) et/ou
          // un ratio de tempo précis, y compris au-delà de ce que l'algorithme
          // aurait choisi automatiquement — cf. ffmpeg.js (manualSemitoneShift /
          // manualTempoRatio) et scoring.js (seuils indicatifs, jamais bloquants
          // côté création réelle du mashup).
          pitchShiftOverride = null, tempoRatioOverride = null,
          // ── Mashup "à la carte" (mode "stems") ──────────────────────────
          // Provenance indépendante ("A" ou "B") par stem Demucs — cf. le
          // nouveau bloc mode==="stems" plus bas et alignAndCombineStems dans
          // services/ffmpeg.js. Défaut = équivalent exact du mode "full"
          // classique (voix de A, instru entièrement de B) si absent.
          stemSelection = { vocals: "A", drums: "B", bass: "B", other: "B" },
          // ── Dé-reverb voix : désactivé PAR DÉFAUT (audit perf juillet 2026) ──
          // Historique : retiré du pipeline auto le 2026-07-03 (gain de temps),
          // puis RÉ-ACTIVÉ à la demande explicite de l'utilisateur (préférait
          // alors la qualité vocale à la vitesse). Nouveau constat en conditions
          // réelles (cf. /api/diag/dereverb) : le venv dédié (C:\audio-separator-env)
          // n'a PAS CUDA — ce modèle réseau de neurones tourne donc sur CPU à
          // chaque appel, assez lent pour dépasser régulièrement le timeout du
          // worker persistant (5 min), puis retomber sur un repli CLI qui repaie
          // le même coût CPU et peut lui aussi échouer/timeouter (5 min de plus)
          // — jusqu'à ~10 min perdues PAR PISTE avant d'abandonner et revenir de
          // toute façon à la voix brute (donc souvent pour rien). Redevient
          // opt-in : `enableDereverb: true` dans le corps de la requête pour le
          // réactiver au cas par cas (ex: avant un voice-swap Kits.ai) sans payer
          // ce risque sur un mashup classique.
          enableDereverb = false } = req.body;
  const stemMode = normalizeStemMode(rawStemMode);

  const trackA = tA || (videoA ? { type: "youtube", id: videoA.id } : null);
  const trackB = tB || (videoB ? { type: "youtube", id: videoB.id } : null);

  if (!trackA || !trackB)
    return res.status(400).json({ error: "trackA et trackB sont requis" });

  // FLAC toujours généré ; MP4 en plus si possible — les 2 sont produits en
  // parallèle (cf. Promise.all à l'étape export) au lieu de forcer l'usager
  // à choisir un seul format, pour gagner du temps sur l'ensemble du job.
  // MP4 nécessite des vidéos YouTube pour les 2 decks (pas de fichier upload).
  const canMp4 = trackA.type !== "file" && trackB.type !== "file";

  // Verrou anti-doublon — cf. commentaire sur activeMashups plus haut.
  const lockKey = (trackA.type !== "file" && trackB.type !== "file" && trackA.id && trackB.id)
    ? `${trackA.id}:${trackB.id}:${mode}:${stemMode}:${durationMode}`
    : null;
  if (lockKey) {
    const runningJobId = activeMashups.get(lockKey);
    if (runningJobId && isJobActive(runningJobId)) {
      console.log(`[mashup] paire ${lockKey} : génération déjà en cours (job ${runningJobId}) — pas de second lancement`);
      return res.json({ jobId: runningJobId });
    }
  }

  const jobId = uuidv4();
  const tmpDir = join(__dirname, "../tmp", jobId);
  const outDir = join(__dirname, "../data/outputs");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  if (lockKey) activeMashups.set(lockKey, jobId);
  res.json({ jobId });

  // Téléchargement vidéo (pour l'export MP4) : ne dépend d'aucune étape audio
  // (mixage, BPM, Demucs), donc on le démarre tout de suite en arrière-plan,
  // en parallèle de la préparation audio, plutôt que d'attendre la toute fin.
  const vidA = join(tmpDir, "vid_a.mp4");
  const vidB = join(tmpDir, "vid_b.mp4");
  // maxHeight=1080 (perf audit — optimisation Demucs/vidéo) : le montage
  // final (exportMP4_916) downscale de toute façon tout en 1920x1080 —
  // télécharger une source 4K/2K pour la rescaler immédiatement après ne
  // gagne rien visuellement mais coûte du temps de téléchargement ET de
  // décodage/filtrage ffmpeg (bien plus de pixels par frame). cf.
  // services/ytdlp.js pour le détail (routes/clipEditor.js, qui livre la
  // vidéo à résolution native, n'est pas concerné par ce plafond).
  const videoDownloadPromise = canMp4
    ? Promise.all([downloadVideo(trackA.id, vidA, 1080), downloadVideo(trackB.id, vidB, 1080)])
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
      // findHighEnergyOffset / snapToMeasureBoundary / parseBeatTimes /
      // parseStructure / pickBestSegmentPair : importés de
      // services/trackPreparation.js (Phase 5) — cf. en-tête de fichier.

      // ── Nettoyage réverb/écho de la voix (best-effort, non bloquant) ──
      // Un stem vocal isolé par Demucs garde souvent une traîne de réverb/écho
      // héritée du mix d'origine — c'est ce résidu, perçu comme "un petit
      // effet reverb disgracieux", qu'un modèle IA dédié (UVR DeEcho-DeReverb,
      // cf. services/dereverb.js) retire bien plus efficacement qu'un simple
      // filtre ffmpeg. Cette étape avait été retirée du pipeline auto le
      // 2026-07-03 pour gagner du temps — RÉ-ACTIVÉE ici à la demande explicite
      // de l'utilisateur, qui préfère maintenant la qualité vocale à la
      // vitesse sur ce point précis. Reste strictement best-effort : un échec
      // (venv/modèle audio-separator absent, timeout 5min...) ne bloque JAMAIS
      // la création du mashup, on retombe simplement sur la voix brute.
      // persistentCacheDir (perf audit juillet 2026) : quand la piste vient du
      // cache permanent d'analyse (data/outputs/analyze/<videoId>/, cf.
      // prepareTrack plus bas), on persiste AUSSI le résultat du dé-reverb à
      // côté (même principe que getCachedInstrumental dans services/ffmpeg.js
      // pour l'instrumental dérivé) — sinon ce modèle GPU était relancé à
      // CHAQUE régénération du même mashup (ex: l'utilisateur ajuste juste le
      // crossfade/pitch fader et relance), alors que la voix source, elle,
      // n'a pas changé. Sans hint (piste re-séparée à la volée, ou fichier
      // uploadé sans identifiant stable), comportement inchangé : dé-reverb
      // reconduit sans persistance, exactement comme avant.
      const cleanVocalsReverb = async (stems, label, persistentCacheDir = null) => {
        if (!stems?.vocals) return stems;
        if (!enableDereverb) {
          // Opt-in désactivé (défaut désormais) : zéro coût, voix brute
          // Demucs telle quelle — cf. commentaire au niveau de la route pour
          // le pourquoi (CPU-bound + double timeout observé en conditions
          // réelles, jusqu'à ~10 min perdues pour rien par piste).
          return stems;
        }
        if (persistentCacheDir) {
          const cachedClean = join(persistentCacheDir, "vocals_dereverbed.flac");
          if (existsSync(cachedClean)) {
            console.log(`[mashup] piste ${label} : voix "sans écho" déjà en cache — dé-reverb non relancé`);
            return { ...stems, vocals: cachedClean };
          }
        }
        try {
          const cleanDir = join(tmpDir, "dereverb", label.toLowerCase());
          const cleaned = await dereverbVocals(stems.vocals, cleanDir);
          if (persistentCacheDir) {
            try {
              await copyFile(cleaned, join(persistentCacheDir, "vocals_dereverbed.flac"));
            } catch (e) {
              console.warn(`[mashup] piste ${label} : mise en cache du dé-reverb ignorée (non bloquant) — ${e.message}`);
            }
          }
          console.log(`[mashup] piste ${label} : voix nettoyée (réverb/écho retirés)`);
          return { ...stems, vocals: cleaned };
        } catch (e) {
          console.warn(`[mashup] piste ${label} : nettoyage réverb/écho ignoré (repli sur la voix brute) — ${e.message}`);
          return stems;
        }
      };

      const prepareTrack = async (track, rawBasePath, wavPath, label) => {
        // ── Optimisation chronologie : chaque clip est déjà analysé (BPM +
        // 4 stems vocals/drums/bass/other) dès sa validation dans la barre de
        // recherche du Deck (cf. /api/analyze, auto-déclenché côté front).
        // Si ce travail est déjà fait et en cache SQLite pour cette vidéo, on
        // le RÉUTILISE tel quel au lieu de re-télécharger l'audio et de
        // relancer un 2e Demucs pour le même morceau — gain de temps énorme
        // ET surtout évite d'avoir 2 process Demucs lourds qui tournent en
        // même temps (celui du Deck + celui du mashup), source de plantages
        // par saturation CPU/GPU/RAM constatée en pratique.
        //
        // IMPORTANT — les deux caches (stems / analyse BPM-clé) sont
        // maintenant traités SÉPARÉMENT, plutôt qu'en bloc :
        //   - stemsUsable  : les 4 fichiers stems Demucs existent réellement
        //     sur le disque (cf. garde-fou ENOENT déjà en place).
        //   - analysisUsable : la ligne SQLite contient un VRAI résultat
        //     d'analyse (bpm non nul). Les lignes créées avant le correctif
        //     du 2026-07-03 peuvent contenir le repli silencieux de l'époque
        //     (bpm=120/camelot="8B", cf. services/analyzer.js et la purge
        //     dans db/index.js) — les traiter comme "déjà analysées" aurait
        //     perpétué le blocage sur 120 BPM même après avoir corrigé la
        //     cause racine.
        // Un morceau peut très bien avoir des stems valides (Demucs, indépendant
        // de Librosa) mais pas d'analyse valide : on réutilise alors les stems
        // SANS relancer Demucs, mais on relance quand même une vraie analyse
        // BPM/clé.
        let cached = null;
        if ((mode === "full" || mode === "stems") && track.type === "youtube") {
          cached = getTrack(track.id);
        }
        // AJOUT sélecteur 2/4 stems : le cache n'est utilisable QUE si son
        // stem_mode correspond au mode demandé pour CE mashup (stemMode,
        // depuis le cadre COMBO) — une seule "version" des stems est
        // conservée par morceau (cf. db/schema.sql), changer de mode oblige
        // donc à re-séparer, exactement comme pour /api/analyze.
        const cacheModeMatches = cached && normalizeStemMode(cached.stem_mode) === stemMode;
        // nonVocalParts : null en mode "2" (pas de stems individuels — le
        // "cache stems" se limite alors à vocals_path/instrumental_path).
        const nonVocalParts = nonVocalPartsForMode(stemMode);
        const cachedStemCols = nonVocalParts
          ? ["vocals_path", ...nonVocalParts.map(p => `${p}_path`)]
          : ["vocals_path", "instrumental_path"];
        const cachedStemPaths = cacheModeMatches && cachedStemCols.every(c => cached[c])
          ? cachedStemCols.map(c => resolveOutputPath(cached[c]))
          : null;
        const stemsUsable = !!cachedStemPaths && cachedStemPaths.every(p => p && existsSync(p));
        if (cached && !cacheModeMatches) {
          console.warn(`[mashup] piste ${label} (${track.id}) : mode demandé (${stemMode} stems) différent du cache (${cached.stem_mode || "?"} stems) — Demucs sera relancé`);
        } else if (cacheModeMatches && !stemsUsable) {
          console.warn(`[mashup] piste ${label} (${track.id}) : cache stems SQLite présent mais incomplet/manquant sur le disque — Demucs sera relancé`);
        }
        const analysisUsable = cached?.bpm != null;
        if (cached && !analysisUsable) {
          console.warn(`[mashup] piste ${label} (${track.id}) : pas d'analyse BPM/clé valide en cache (purgée ou jamais aboutie) — une vraie analyse va être relancée`);
        }

        // Chemin le plus rapide : stems ET analyse valides → aucun
        // téléchargement, aucune extraction, aucun Demucs, aucun Librosa.
        if (stemsUsable && analysisUsable) {
          console.log(`[mashup] piste ${label} (${track.id}) déjà analysée — réutilisation complète (stems + BPM/clé du Deck, mode ${stemMode})`);
          updateJobStep(jobId, { status: "running", step: 1, label: `Réutilisation de l'analyse piste ${label}` });

          const stemsDir = join(tmpDir, "stems", label.toLowerCase());
          mkdirSync(stemsDir, { recursive: true });
          const vocalsSrc = resolveOutputPath(cached.vocals_path);
          const vocalsDst = join(stemsDir, "vocals" + extname(vocalsSrc));
          const instruDst = join(stemsDir, "instrumental.flac");
          await copyFile(vocalsSrc, vocalsDst);
          let instruSrc;
          let stemsRawPaths = null;
          if (nonVocalParts) {
            // getCachedInstrumental : amix ffmpeg relancé UNE SEULE fois par
            // morceau, réutilisé ensuite (cf. services/ffmpeg.js) — évite de
            // recombiner les stems non-vocaux à chaque mashup/export
            // utilisant ce même morceau déjà analysé.
            instruSrc = await getCachedInstrumental(...nonVocalParts.map(p => resolveOutputPath(cached[`${p}_path`])));
            stemsRawPaths = Object.fromEntries(nonVocalParts.map(p => [p, resolveOutputPath(cached[`${p}_path`])]));
          } else {
            // Mode "2" : déjà un instrumental complet, rien à combiner.
            instruSrc = resolveOutputPath(cached.instrumental_path);
          }
          await copyFile(instruSrc, instruDst);
          const stems = await cleanVocalsReverb({ vocals: vocalsDst, instrumental: instruDst }, label, dirname(vocalsSrc));
          return {
            bpm: cached.bpm, stems,
            // stemsRaw : les stems non-vocaux INDIVIDUELS (pas encore
            // combinés) — utilisé uniquement par le mode "stems" (mashup à
            // la carte, provenance par stem) ci-dessous ; null en mode "2"
            // (rien à choisir par instrument) ; ignoré par les autres modes.
            stemsRaw: stemsRawPaths,
            keyPitch: cached.key_pitch ?? null, camelot: cached.camelot ?? null,
            startOffset: findHighEnergyOffset(cached.structure_json),
            structure: parseStructure(cached.structure_json),
            beatTimes: parseBeatTimes(cached.beat_times_json),
            drops: parseDrops(cached.drops_json),
          };
        }

        // Sinon : il faut l'audio brut, ne serait-ce que pour ré-analyser
        // (même si les stems, eux, sont réutilisables).
        updateJobStep(jobId, { status: "running", step: 0, label: `Téléchargement piste ${label}` });
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

        updateJobStep(jobId, { step: 1, label: `Extraction audio piste ${label}` });
        await extractAudio(actual, wavPath);

        let bpm = null, stems = null, keyPitch = null, camelot = null, startOffset = 0, structure = [], beatTimes = [], drops = [];
        // Renseigné seulement quand les stems viennent du cache permanent
        // d'analyse (data/outputs/analyze/<videoId>/) — permet à
        // cleanVocalsReverb de persister/réutiliser le résultat du dé-reverb
        // à cet endroit stable plutôt que dans le tmp/ jetable du job.
        let dereverbCacheDir = null;
        // "overlay" (superposition complète façon RaveDJ, cf. mixFullOverlay)
        // a besoin de BPM/clé/structure comme "full"/"stems", mais PAS de
        // séparation Demucs (cf. plus bas, volontairement exclu de cette
        // 2e condition) — aussi rapide que "quick"/"smart" sur ce point.
        if (mode === "smart" || mode === "full" || mode === "stems" || mode === "overlay") {
          if (analysisUsable) {
            // Analyse déjà valide en cache (mais stems à refaire, sinon on
            // serait passés par le chemin rapide ci-dessus) : pas besoin de
            // rappeler Librosa pour ce morceau.
            bpm = cached.bpm;
            keyPitch = cached.key_pitch ?? null;
            camelot = cached.camelot ?? null;
            startOffset = findHighEnergyOffset(cached.structure_json);
            structure = parseStructure(cached.structure_json);
            beatTimes = parseBeatTimes(cached.beat_times_json);
            drops = parseDrops(cached.drops_json);
          } else {
            updateJobStep(jobId, { step: 1, label: `Analyse BPM / Tonalité piste ${label}` });
            const info = await analyzeAudio(wavPath);
            // Ne pas continuer avec un BPM/clé inventé (cf. services/analyzer.js) :
            // un échec silencieux ici revenait à mixer avec un tempo/tonalité
            // faux pour la piste, ce qui a été la cause probable n°1 du
            // décalage vocal/instru remonté par l'utilisateur (deux morceaux
            // "tombant" tous les deux sur le même repli 120 BPM/8B se
            // retrouvaient jugés déjà parfaitement synchronisés, donc aucune
            // correction n'était appliquée).
            if (info.analysisFailed) {
              throw new Error(`Analyse BPM/Tonalité impossible (piste ${label}) : ${info.analysisError}`);
            }
            bpm = info.bpm;
            keyPitch = info.key_pitch ?? null;
            camelot = info.camelot ?? null;
            startOffset = findHighEnergyOffset(info.structure);
            structure = info.structure || [];
            beatTimes = info.beat_times || [];
            drops = info.drops || [];
          }
        }
        // stemsRaw : stems non-vocaux INDIVIDUELS (mode "stems" uniquement,
        // cf. commentaire d'en-tête plus bas) — null pour "quick"/"smart", et
        // pour "full"/mode "2" (aucun fichier individuel disponible dans ce
        // cas, cf. branche "else" ci-dessous).
        let stemsRaw = null;
        if (mode === "full" || mode === "stems") {
          if (stemsUsable) {
            console.log(`[mashup] piste ${label} (${track.id}) : stems réutilisés (pas de 2e Demucs, mode ${stemMode}), analyse rejouée`);
            const stemsDir = join(tmpDir, "stems", label.toLowerCase());
            mkdirSync(stemsDir, { recursive: true });
            const vocalsSrc = resolveOutputPath(cached.vocals_path);
            const vocalsDst = join(stemsDir, "vocals" + extname(vocalsSrc));
            const instruDst = join(stemsDir, "instrumental.flac");
            await copyFile(vocalsSrc, vocalsDst);
            if (nonVocalParts) {
              const combinedInstru = await getCachedInstrumental(...nonVocalParts.map(p => resolveOutputPath(cached[`${p}_path`])));
              await copyFile(combinedInstru, instruDst);
              stemsRaw = Object.fromEntries(nonVocalParts.map(p => [p, resolveOutputPath(cached[`${p}_path`])]));
            } else {
              await copyFile(resolveOutputPath(cached.instrumental_path), instruDst);
            }
            stems = { vocals: vocalsDst, instrumental: instruDst };
            dereverbCacheDir = dirname(vocalsSrc);
          } else {
            updateJobStep(jobId, { step: 2, label: `Séparation stems piste ${label} (Demucs)` });
            const stemsDir = join(tmpDir, "stems", label.toLowerCase());
            mkdirSync(stemsDir, { recursive: true });
            if (mode === "stems") {
              // Le mode "à la carte" a besoin des stems INDIVIDUELS (pas
              // seulement voix/instru en bloc) pour pouvoir en choisir la
              // provenance un par un — séparation complète en mode 4 stems
              // (le mode "2" ne permet pas le mashup à la carte, filtré côté
              // frontend, cf. ComboPanel.jsx).
              const full = await separateStemsFull(wavPath, stemsDir, stemMode);
              const parts = nonVocalPartsForMode(stemMode) || [];
              stemsRaw = Object.fromEntries(parts.map(p => [p, full[p]]));
              // getCachedInstrumental écrit son résultat à côté du 1er stem
              // (dans le sous-dossier où Demucs a produit CES stems, cf.
              // stemsOutputDir dans services/demucs.js) — un sous-dossier de
              // stemsDir, lui-même jetable comme tout tmpDir de ce job : aucun
              // risque de collision entre morceaux ou entre jobs différents.
              const instruCombined = await getCachedInstrumental(...parts.map(p => full[p]));
              stems = { vocals: full.vocals, instrumental: instruCombined };
            } else {
              stems = await separateStems(wavPath, stemsDir);
            }
          }
        }
        const cleanedStems = await cleanVocalsReverb(stems, label, dereverbCacheDir);
        return { bpm, stems: cleanedStems, stemsRaw, keyPitch, camelot, startOffset, structure, beatTimes, drops };
      };

      // REVERT (juillet 2026) — une tentative de paralléliser prepareTrack(A)
      // et prepareTrack(B) via Promise.all avait été introduite ici pour
      // gagner du temps, mais elle a réintroduit EXACTEMENT le bug déjà
      // documenté juste au-dessus (commentaire "Pipeline complet PAR
      // PISTE...") : 2 téléchargements yt-dlp simultanés se marchent dessus
      // (cache/composants partagés entre process yt-dlp concurrents, pas
      // seulement la contention GPU Demucs) — retour utilisateur : le mashup
      // final sonnait comme s'il "superposait 2 fois le même flac", cohérent
      // avec une des 2 pistes ayant reçu l'audio de l'AUTRE par ce
      // mécanisme. Revenu à la séquence stricte A PUIS B, seule version dont
      // la fiabilité est établie. Le gain de vitesse dans le cas "tout en
      // cache" (aucun téléchargement/Demucs à refaire, juste des copies de
      // fichiers) n'en valait pas le risque de corruption croisée.
      const resA = await prepareTrack(trackA, join(tmpDir, "a_raw"), wavA, "A");
      const resB = await prepareTrack(trackB, join(tmpDir, "b_raw"), wavB, "B");

      // ── Garde-fou anti-doublon ("le mashup final superpose 2 fois le même
      // flac", retour utilisateur récurrent) ──────────────────────────────
      // Le pipeline est désormais strictement séquentiel (cf. revert plus
      // haut) et chaque relecture de code n'a fait apparaître aucune autre
      // source de collision de fichier entre A et B — mais le symptôme est
      // exactement celui d'un mashup où voix A et instru B finissent par
      // pointer vers LE MÊME contenu audio. Plutôt que de continuer à
      // chercher une cause qui ne se reproduit pas de façon isolable, on
      // détecte ce cas PRÉCIS de façon fiable et on fait échouer le job
      // explicitement, au lieu de livrer silencieusement un mashup corrompu :
      //  1) Même vidéo des 2 côtés (sélection utilisateur, ou préremplissage
      //     Mashup Wheel/pendingPair) — cause la plus probable et la moins
      //     coûteuse à vérifier.
      //  2) Par sécurité, si les 2 fichiers stems finaux (voix A / instru B)
      //     ont EXACTEMENT la même taille (improbable pour 2 pistes
      //     distinctes), on compare leur contenu complet — un vrai doublon de
      //     fichier (cache croisé, copie ratée...) est alors détecté et
      //     bloqué, avec les 2 chemins en clair dans le message d'erreur pour
      //     enfin pouvoir remonter jusqu'à SA cause exacte au prochain cas.
      if (trackA.type === "youtube" && trackB.type === "youtube" && trackA.id === trackB.id) {
        throw new Error(`Piste A et piste B sont la même vidéo (${trackA.id}) — choisis 2 morceaux différents.`);
      }
      let statVoc, statInstru;
      try {
        [statVoc, statInstru] = await Promise.all([stat(resA.stems.vocals), stat(resB.stems.instrumental)]);
        console.log(`[mashup] anti-doublon : voix A="${resA.stems.vocals}" (${statVoc.size} o) | instru B="${resB.stems.instrumental}" (${statInstru.size} o)`);
      } catch (e) {
        console.warn(`[mashup] vérif anti-doublon ignorée (fichiers non lisibles) : ${e.message}`);
      }
      if (statVoc && statInstru && statVoc.size === statInstru.size) {
        const [bufVoc, bufInstru] = await Promise.all([readFile(resA.stems.vocals), readFile(resB.stems.instrumental)]);
        if (bufVoc.equals(bufInstru)) {
          throw new Error(
            `Voix A ("${resA.stems.vocals}") et instru B ("${resB.stems.instrumental}") sont IDENTIQUES ` +
            `(${statVoc.size} o) — mashup annulé pour éviter un rendu corrompu (voix et instru superposeraient le même audio). ` +
            `Signale ces 2 chemins tels quels : ils indiquent précisément où le pipeline a mélangé les 2 pistes.`
          );
        }
      }

      const mixedWav = join(tmpDir, "mixed.wav");
      const safeName = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const baseName = `${safeName}_${jobId.slice(0, 8)}`;
      const flacFile = join(outDir, `${baseName}.flac`);
      const mp4File = join(outDir, `${baseName}.mp4`);
      // Montage vidéo SANS le son, persisté à part (data/outputs, donc pas
      // supprimé avec tmp/) : réutilisé pour générer un "mashup personnalisé"
      // (cadre à gauche de Mes MacheUps) sans refaire le montage vidéo.
      const silentFile = join(outDir, `${baseName}_silent.mp4`);

      // ── Montage vidéo en parallèle du mixage audio (audit perf juillet
      // 2026) ────────────────────────────────────────────────────────────
      // Renseigné UNIQUEMENT par les modes "full"/"stems" ci-dessous (seuls
      // modes où la durée totale de sortie est calculable À L'AVANCE, avec
      // la même formule que mixFullRave utilise déjà en interne pour son
      // propre plan de tempo — cf. buildSilentVideoMontage dans
      // services/ffmpeg.js). Si non null, l'étape d'export final (plus bas)
      // attend juste sa fin puis fait un mux rapide au lieu de relancer tout
      // exportMP4_916 depuis zéro. Les modes "quick"/"smart" (mixage bien
      // plus rapide, acrossfade simple) gardent le comportement séquentiel
      // d'origine — le gain potentiel n'y justifie pas le risque.
      let videoMontagePromise = null;

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

        // ── Rec #4 (v2, matrice de mashability) : sélection du MEILLEUR
        // COUPLE de segments entre A et B (harmonie + énergie), pas juste le
        // 1er segment "high" de chaque piste indépendamment — cf.
        // pickBestSegmentPair plus haut. Calé sur la limite de mesure la plus
        // proche ensuite (rec #5, inchangé).
        const { offsetA: bestOffsetA, offsetB: bestOffsetB, harmonicScore, energyScore, reason: pairingReason } =
          pickBestSegmentPair(resA.structure, resB.structure);
        console.log(`[mashup] appariement segments (mashability) : ${pairingReason}`);

        // ── Ducking adaptatif ──────────────────────────────────────────────
        // Plus la paire de segments choisie est bien assortie (harmonie +
        // énergie), moins le ducking a besoin d'être marqué : l'instru peut
        // rester présent sans masquer la voix. Une paire moins bien assortie
        // (énergie ou tonalité plus éloignées) a besoin d'un ducking plus
        // franc pour que la voix reste intelligible malgré un instru moins
        // complémentaire. Remplace l'ancienne valeur fixe (2.5, toujours la
        // même quel que soit le morceau) par un réglage propre à CHAQUE paire.
        const segmentCompatAvg = (harmonicScore + energyScore) / 2;
        const duckingRatio = segmentCompatAvg >= 75 ? 2.0 : segmentCompatAvg >= 50 ? 2.5 : 3.2;
        console.log(`[mashup] ducking adaptatif : ratio=${duckingRatio} (compatibilité segment ${segmentCompatAvg.toFixed(0)}/100)`);
        const vocalsStartOffset = snapToMeasureBoundary(bestOffsetA, resA.beatTimes, resA.bpm);
        const instruStartOffset = snapToMeasureBoundary(bestOffsetB, resB.beatTimes, resB.bpm);
        console.log(`[mashup] segment offset voix=${vocalsStartOffset.toFixed(2)}s instru=${instruStartOffset.toFixed(2)}s`);

        // ── Rec #5 : délai vocal calé sur une mesure entière de l'instru ──
        // Cible ~4s d'intro, arrondi au multiple entier de mesure 4/4 le plus
        // proche du tempo EFFECTIF de sortie — c'est-à-dire celui de la VOIX A
        // (resA.bpm), PAS le BPM brut de l'instru B (resB.bpm).
        // BUG corrigé : mixFullRave applique atempo=ratio à l'instru B pour le
        // recaler sur le tempo de la voix A ("B est recalé au tempo de A", cf.
        // ffmpeg.js). Après ce recalage, une mesure de l'instru dure
        // 4*60/bpmA secondes dans le flux final — PAS 4*60/bpmB. Calculer le
        // délai vocal avec resB.bpm (comme avant) revenait à caler la voix sur
        // la grille de mesure D'AVANT l'étirement temporel, qui n'existe plus
        // dans le mix final dès que bpmA ≠ bpmB : la voix entrait alors en
        // plein milieu d'une mesure au lieu du temps fort visé, exactement le
        // symptôme de désalignement rythmique remonté par l'utilisateur.
        const finalMeasureDur = resA.bpm > 0 ? (4 * 60 / resA.bpm) : 2.0;  // s/mesure, tempo de sortie réel
        const introMeasures = Math.max(1, Math.round(4.0 / finalMeasureDur));
        const vocalDelayMs = Math.round(introMeasures * finalMeasureDur * 1000);
        console.log(`[mashup] délai vocal=${vocalDelayMs}ms (${introMeasures} mesure(s) à ${resA.bpm} BPM — tempo de sortie)`);

        if (pitchShiftOverride != null || tempoRatioOverride != null) {
          console.log(`[mashup] réglages manuels appliqués : ${pitchShiftOverride != null ? `décalage=${pitchShiftOverride}st` : "décalage=auto"}, ${tempoRatioOverride != null ? `tempo=${tempoRatioOverride}` : "tempo=auto"}`);
        }

        // ── Durée "tailored" (mode optionnel) — cf. computeTailoredMaxDuration.
        // null si durationMode !== "tailored" OU si la structure est absente
        // (repli silencieux sur le comportement "full" historique).
        const maxDurationSec = durationMode === "tailored"
          ? computeTailoredMaxDuration(resA.structure, vocalsStartOffset, vocalDelayMs / 1000)
          : null;
        if (maxDurationSec != null) {
          console.log(`[mashup] durée de sortie plafonnée (mode tailored) : ${maxDurationSec.toFixed(1)}s`);
        }

        // ── Démarre le montage vidéo MAINTENANT, en parallèle du mixage audio
        // qui suit (cf. commentaire détaillé sur videoMontagePromise plus haut
        // et sur buildSilentVideoMontage dans services/ffmpeg.js). totalSec
        // est calculé ICI avec EXACTEMENT la même formule que mixFullRave
        // utilise en interne pour son plan de tempo piecewise (vocalDelaySec +
        // durée voix utile) — jamais une nouvelle hypothèse, juste la même
        // rendue disponible avant la fin du mixage plutôt qu'après.
        // UNIQUEMENT si tempoRatioOverride est absent : avec un ratio de tempo
        // MANUEL, mixFullRave désactive son plan de tempo par segment (cf.
        // ffmpeg.js) et étire l'instru sur toute sa longueur au lieu de le
        // faire correspondre à la durée voix — la formule ne serait alors plus
        // fiable, donc on retombe sur l'ancien comportement séquentiel dans ce
        // cas précis (réglage manuel = cas plus rare, le gain n'en vaut pas le
        // risque d'un montage vidéo plus court que le mix audio réel).
        if (canMp4 && tempoRatioOverride == null) {
          const vocalsDurationForVideo = await getDuration(resA.stems.vocals);
          const naturalTotalSecEstimate = (vocalDelayMs / 1000) + Math.max(0, vocalsDurationForVideo - vocalsStartOffset);
          const totalSecEstimate = maxDurationSec != null ? Math.min(naturalTotalSecEstimate, maxDurationSec) : naturalTotalSecEstimate;
          videoMontagePromise = (async () => {
            await videoDownloadPromise;
            // musicSync (Phase 3) : beat_times/structure de la VOIX A — même
            // piste qui pilote déjà tout le calage temporel du mix audio
            // (vocalDelayMs, plan de tempo...) ci-dessous, donc le montage
            // vidéo se cale sur la même référence rythmique que le son.
            await buildSilentVideoMontage(vidA, vidB, totalSecEstimate, parseFloat(crossfade), silentFile,
              { beatTimes: resA.beatTimes, structure: resA.structure, highlightTimes: deriveHighlightTimes(resA.structure, resA.drops) });
          })();
          videoMontagePromise.catch(() => {}); // gérée : le vrai rejet est relevé plus bas à l'export
        }

        await mixFullRave(resA.stems.vocals, resB.stems.instrumental, resA.bpm, resB.bpm, parseFloat(crossfade), mixedWav,
          { keyVocals: resA.keyPitch, keyInstru: resB.keyPitch, camelotVocals: resA.camelot, camelotInstru: resB.camelot,
            vocalsStartOffset, instruStartOffset, vocalDelayMs, duckingRatio, maxDurationSec,
            // Grille de beats complète des 2 pistes (cf. analyzer.js) — permet
            // à mixFullRave de corriger le tempo de l'instru PAR SEGMENT (tempo
            // local réel) au lieu d'un seul ratio constant sur toute la durée,
            // qui dérivait progressivement dès que le tempo réel n'était pas
            // parfaitement stable ("décrochage" rapporté par l'utilisateur).
            beatTimesVocals: resA.beatTimes, beatTimesInstru: resB.beatTimes,
            manualSemitoneShift: pitchShiftOverride, manualTempoRatio: tempoRatioOverride });
        updateJob(jobId, { step: 4, label: "Export final" });

      } else if (mode === "stems") {
        // ── Mashup "à la carte" — provenance indépendante par stem ────────
        // cf. commentaire détaillé dans services/ffmpeg.js (alignAndCombineStems).
        // stemSelection = { vocals, drums, bass, other }, chacun dans un des
        // 4 états proposés par ComboPanel.jsx : "A", "B", "AB" (les 2
        // morceaux RÉELLEMENT mixés ensemble dans le mashup final — plus un
        // simple aperçu navigateur approximatif, cf. juillet 2026 : retour
        // utilisateur "je veux que ça fonctionne comme une console de
        // mixage qui sert à générer le mashup final") ou "mute" (ce stem est
        // absent du mashup final). La liste EXACTE des clés dépend du mode
        // choisi (cf. nonVocalPartsForMode) — mode 4 stems uniquement depuis
        // le retrait du mode 6 (juillet 2026).
        if (!resA.stemsRaw || !resB.stemsRaw) {
          throw new Error("Stems individuels indisponibles pour ce mode — vérifie que les 2 morceaux ont bien terminé leur analyse automatique (Deck, en mode 4 stems) avant de lancer un mashup à la carte.");
        }
        // Intersection des clés réellement disponibles des 2 côtés (au cas où
        // A et B auraient été analysés sous des modes différents, ex. l'un
        // avant un changement de sélecteur) — toujours 3 clés (mode 4).
        const nonVocalKeys = Object.keys(resA.stemsRaw).filter(k => k in resB.stemsRaw);
        if (nonVocalKeys.length === 0) {
          throw new Error("Aucun stem non-vocal commun entre les 2 morceaux (modes de séparation incompatibles) — relance l'analyse des 2 decks dans le même mode (4 stems).");
        }
        const pick = (part) => {
          const v = stemSelection?.[part];
          return (v === "B" || v === "AB" || v === "mute") ? v : "A";
        };
        const originOf = Object.fromEntries(nonVocalKeys.map(part => [part, pick(part)]));
        // "Ancre" = morceau majoritaire parmi les stems non-vocaux à
        // provenance UNIQUE ("A" ou "B" seulement — "AB"/"mute" ne votent
        // pas, ils n'indiquent aucune préférence de morceau). Ancien
        // invariant "toujours impair, jamais d'égalité" cassé par ces 2
        // nouveaux états : on retombe simplement sur "A" par défaut en cas
        // d'égalité (ou si aucun stem n'a de provenance unique).
        const votingParts = nonVocalKeys.filter(k => originOf[k] === "A" || originOf[k] === "B");
        const votesB = votingParts.filter(k => originOf[k] === "B").length;
        const anchorSide = votesB > votingParts.length / 2 ? "B" : "A";
        const anchorRes = anchorSide === "A" ? resA : resB;
        const otherRes = anchorSide === "A" ? resB : resA;
        console.log(`[mashup] stems à la carte (${nonVocalKeys.length + 1} stems) : voix=${pick("vocals")} ${nonVocalKeys.map(k => `${k}=${originOf[k]}`).join(" ")} — ancre=${anchorSide} (BPM ${anchorRes.bpm}, ${anchorRes.camelot || "?"})`);

        // Entrées à aligner+combiner pour l'instrumental composite : "A"/"B"
        // → 1 entrée (comme avant) ; "AB" → 2 entrées (les 2 morceaux,
        // CHACUN réaligné indépendamment sur l'ancre, puis combinés
        // ensemble — alignAndCombineStems ne fait aucune distinction entre
        // "2 stems différents à combiner" et "2 versions du même stem à
        // combiner", donc aucun changement nécessaire côté ffmpeg.js) ;
        // "mute" → aucune entrée (le stem est vraiment absent du composite).
        const stemParts = nonVocalKeys.flatMap((part) => {
          const state = originOf[part];
          // Batterie = contenu percussif/atonal : le pitch-shift n'y a pas de
          // sens (cf. commentaire détaillé dans ffmpeg.js) — seul le tempo
          // est réaligné pour cette piste.
          const allowPitchShift = part !== "drums";
          if (state === "mute") return [];
          if (state === "AB") {
            return [
              { path: resA.stemsRaw[part], bpm: resA.bpm, camelot: resA.camelot, keyPitch: resA.keyPitch, label: `${part}_A`, allowPitchShift },
              { path: resB.stemsRaw[part], bpm: resB.bpm, camelot: resB.camelot, keyPitch: resB.keyPitch, label: `${part}_B`, allowPitchShift },
            ];
          }
          const res = state === anchorSide ? anchorRes : otherRes;
          return [{ path: res.stemsRaw[part], bpm: res.bpm, camelot: res.camelot, keyPitch: res.keyPitch, label: `${part}_${state}`, allowPitchShift }];
        });
        if (stemParts.length === 0) {
          throw new Error("Tous les stems non-vocaux sont en \"Muet\" — sélectionne au moins un stem non-vocal actif (batterie/basse/autres...) pour générer un instrumental.");
        }

        const instruDir = join(tmpDir, "stems_composite");
        mkdirSync(instruDir, { recursive: true });
        const instruComposite = join(instruDir, "instrumental_composite.flac");
        updateJob(jobId, { step: 3, label: "Alignement + combinaison des stems choisis" });
        await alignAndCombineStems(stemParts, anchorRes.bpm, anchorRes.camelot, anchorRes.keyPitch, instruComposite);

        const vocalsState = pick("vocals");

        if (vocalsState === "mute") {
          // ── Instrumental seul (voix en "Muet") ──────────────────────────
          // Pas de piste voix à mixer : mixFullRave est conçu autour d'UNE
          // voix + UN instru (calage, ducking, EQ de présence...) et n'a pas
          // de sens sans voix — on exporte directement le composite
          // instrumental déjà combiné ci-dessus, remis au même niveau cible
          // (LUFS) que les autres exports de stem isolé (cf. normalizeStemLoudness,
          // déjà utilisée pour les exports voix/instru seuls).
          updateJob(jobId, { step: 3, label: "Export instrumental (voix muette)" });
          await normalizeStemLoudness(instruComposite, mixedWav, "-13.5");

          if (canMp4 && tempoRatioOverride == null) {
            const instruDurationForVideo = await getDuration(instruComposite);
            videoMontagePromise = (async () => {
              await videoDownloadPromise;
              await buildSilentVideoMontage(vidA, vidB, instruDurationForVideo, parseFloat(crossfade), silentFile,
                { beatTimes: anchorRes.beatTimes, structure: anchorRes.structure, highlightTimes: deriveHighlightTimes(anchorRes.structure, anchorRes.drops) });
            })();
            videoMontagePromise.catch(() => {});
          }
          updateJob(jobId, { step: 4, label: "Export final" });
        } else {
          // ── Piste voix : A, B, ou A+B réellement mixées ensemble ────────
          let vocalsRes, vocalsPathForMix;
          if (vocalsState === "AB") {
            // Convention : resA sert de référence rythmique/tonale (segments,
            // grille de beats, durée) pour tout le calage ci-dessous — comme
            // si vocalsState==="A" — et la voix de B est mixée PAR-DESSUS,
            // réalignée (tempo+tonalité) sur cette même référence via la
            // fonction déjà utilisée pour l'instrumental composite.
            vocalsRes = resA;
            const vocalsDir = join(tmpDir, "vocals_composite");
            mkdirSync(vocalsDir, { recursive: true });
            const vocalsComposite = join(vocalsDir, "vocals_composite.flac");
            updateJob(jobId, { step: 3, label: "Combinaison des 2 voix (A+B)" });
            await alignAndCombineStems(
              [
                { path: resA.stems.vocals, bpm: resA.bpm, camelot: resA.camelot, keyPitch: resA.keyPitch, label: "vocals_A", allowPitchShift: true },
                { path: resB.stems.vocals, bpm: resB.bpm, camelot: resB.camelot, keyPitch: resB.keyPitch, label: "vocals_B", allowPitchShift: true },
              ],
              resA.bpm, resA.camelot, resA.keyPitch, vocalsComposite
            );
            vocalsPathForMix = vocalsComposite;
          } else {
            vocalsRes = vocalsState === "A" ? resA : resB;
            vocalsPathForMix = vocalsRes.stems.vocals;
          }

          const { offsetA: bestOffsetVocals, offsetB: bestOffsetAnchor, harmonicScore, energyScore, reason: pairingReason } =
            pickBestSegmentPair(vocalsRes.structure, anchorRes.structure);
          console.log(`[mashup] stems à la carte — appariement segments : ${pairingReason}`);
          const segmentCompatAvg = (harmonicScore + energyScore) / 2;
          const duckingRatio = segmentCompatAvg >= 75 ? 2.0 : segmentCompatAvg >= 50 ? 2.5 : 3.2;
          const vocalsStartOffset = snapToMeasureBoundary(bestOffsetVocals, vocalsRes.beatTimes, vocalsRes.bpm);
          const instruStartOffset = snapToMeasureBoundary(bestOffsetAnchor, anchorRes.beatTimes, anchorRes.bpm);
          const finalMeasureDur = vocalsRes.bpm > 0 ? (4 * 60 / vocalsRes.bpm) : 2.0;
          const introMeasures = Math.max(1, Math.round(4.0 / finalMeasureDur));
          const vocalDelayMs = Math.round(introMeasures * finalMeasureDur * 1000);

          // Durée "tailored" (mode optionnel) — cf. computeTailoredMaxDuration
          // et le même mécanisme dans la branche "full" ci-dessus.
          const maxDurationSec = durationMode === "tailored"
            ? computeTailoredMaxDuration(vocalsRes.structure, vocalsStartOffset, vocalDelayMs / 1000)
            : null;
          if (maxDurationSec != null) {
            console.log(`[mashup] durée de sortie plafonnée (mode tailored) : ${maxDurationSec.toFixed(1)}s`);
          }

          // Montage vidéo en parallèle du mixage — cf. commentaire détaillé
          // dans la branche "full" ci-dessus (même formule, même garde-fou
          // sur tempoRatioOverride). Durée mesurée sur vocalsPathForMix (et
          // non plus systématiquement vocalsRes.stems.vocals) : en état
          // "AB", c'est le composite déjà combiné qui compte, sa durée peut
          // légèrement différer de la piste voix brute de resA.
          if (canMp4 && tempoRatioOverride == null) {
            const vocalsDurationForVideo = await getDuration(vocalsPathForMix);
            const naturalTotalSecEstimate = (vocalDelayMs / 1000) + Math.max(0, vocalsDurationForVideo - vocalsStartOffset);
            const totalSecEstimate = maxDurationSec != null ? Math.min(naturalTotalSecEstimate, maxDurationSec) : naturalTotalSecEstimate;
            videoMontagePromise = (async () => {
              await videoDownloadPromise;
              // musicSync (Phase 3) : beat_times/structure de la piste voix
              // de référence (vocalsRes) — même référence rythmique que le
              // mixage audio ci-dessous.
              await buildSilentVideoMontage(vidA, vidB, totalSecEstimate, parseFloat(crossfade), silentFile,
                { beatTimes: vocalsRes.beatTimes, structure: vocalsRes.structure, highlightTimes: deriveHighlightTimes(vocalsRes.structure, vocalsRes.drops) });
            })();
            videoMontagePromise.catch(() => {});
          }

          updateJob(jobId, { step: 3, label: "Mixage voix + instrumental composite" });
          await mixFullRave(vocalsPathForMix, instruComposite, vocalsRes.bpm, anchorRes.bpm, parseFloat(crossfade), mixedWav,
            { keyVocals: vocalsRes.keyPitch, keyInstru: anchorRes.keyPitch, camelotVocals: vocalsRes.camelot, camelotInstru: anchorRes.camelot,
              vocalsStartOffset, instruStartOffset, vocalDelayMs, duckingRatio, maxDurationSec,
              beatTimesVocals: vocalsRes.beatTimes, beatTimesInstru: anchorRes.beatTimes,
              manualSemitoneShift: pitchShiftOverride, manualTempoRatio: tempoRatioOverride });
          updateJob(jobId, { step: 4, label: "Export final" });
        }
      } else if (mode === "overlay") {
        // ── Mode SUPERPOSITION COMPLÈTE ("overlay", façon RaveDJ) ──────────
        // cf. services/ffmpeg.js::mixFullOverlay pour le détail du
        // raisonnement. Contrairement à "full"/"stems", ce mode superpose
        // les 2 MIX COMPLETS (wavA/wavB, avant toute séparation Demucs) —
        // aucune isolation vocale, résultat plus "brut"/dense, option
        // supplémentaire à côté du mode stems existant (pas un remplacement).
        console.log(`[mashup] mode SUPERPOSITION COMPLÈTE (overlay) — BPM A=${resA.bpm} B=${resB.bpm}`);
        updateJob(jobId, { step: 3, label: "Superposition des mix complets A + B" });

        const { offsetA: bestOffsetA, offsetB: bestOffsetB, reason: pairingReason } =
          pickBestSegmentPair(resA.structure, resB.structure);
        console.log(`[mashup] overlay — appariement segments : ${pairingReason}`);
        const offsetA = snapToMeasureBoundary(bestOffsetA, resA.beatTimes, resA.bpm);
        const offsetB = snapToMeasureBoundary(bestOffsetB, resB.beatTimes, resB.bpm);

        // Pas d'intro/délai ici (les 2 mix démarrent ensemble, contrairement
        // à "full" où l'instru B précède la voix A) — vocalDelaySec=0 dans
        // computeTailoredMaxDuration en conséquence.
        const maxDurationSec = durationMode === "tailored"
          ? computeTailoredMaxDuration(resA.structure, offsetA, 0)
          : null;
        if (maxDurationSec != null) {
          console.log(`[mashup] overlay — durée de sortie plafonnée (mode tailored) : ${maxDurationSec.toFixed(1)}s`);
        }

        if (canMp4) {
          const wavADuration = await getDuration(wavA);
          const naturalTotalSecEstimate = Math.max(0, wavADuration - offsetA);
          const totalSecEstimate = maxDurationSec != null ? Math.min(naturalTotalSecEstimate, maxDurationSec) : naturalTotalSecEstimate;
          videoMontagePromise = (async () => {
            await videoDownloadPromise;
            await buildSilentVideoMontage(vidA, vidB, totalSecEstimate, parseFloat(crossfade), silentFile,
              { beatTimes: resA.beatTimes, structure: resA.structure, highlightTimes: deriveHighlightTimes(resA.structure, resA.drops) });
          })();
          videoMontagePromise.catch(() => {});
        }

        await mixFullOverlay(wavA, wavB, resA.bpm, resB.bpm, parseFloat(crossfade), mixedWav,
          { keyA: resA.keyPitch, keyB: resB.keyPitch, camelotA: resA.camelot, camelotB: resB.camelot,
            offsetA, offsetB, maxDurationSec,
            beatTimesA: resA.beatTimes, beatTimesB: resB.beatTimes });
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
          if (videoMontagePromise) {
            // Montage déjà lancé EN PARALLÈLE du mixage audio ci-dessus
            // (modes "full"/"stems" sans réglage tempo manuel — cf.
            // videoMontagePromise) : il ne reste qu'à attendre sa fin puis
            // faire le mux final, une simple copie de flux vidéo + encodage
            // AAC de l'audio, quasi instantané.
            await videoMontagePromise;
            await muxVideoAudio(silentFile, mixedWav, mp4File);
            console.log("[mashup] export MP4 : mux vidéo (déjà montée en parallèle) + mix audio terminé");
          } else {
            // Modes "quick"/"smart", ou réglage tempo manuel actif :
            // comportement séquentiel d'origine, inchangé. Le téléchargement
            // vidéo a été lancé en parallèle dès le début du job (cf.
            // videoDownloadPromise) : on attend juste qu'il se termine s'il
            // n'est pas déjà fini, au lieu de le démarrer seulement ici.
            await videoDownloadPromise;
            await exportMP4_916(vidA, vidB, mixedWav, mp4File, parseFloat(crossfade), silentFile);
          }
        })());
      }
      await Promise.all(exportJobs);

      const flacUrl = `/outputs/${baseName}.flac`;
      const mp4Url = canMp4 ? `/outputs/${baseName}.mp4` : null;
      const silentUrl = canMp4 && existsSync(silentFile) ? `/outputs/${baseName}_silent.mp4` : null;
      updateJob(jobId, { status: "done", step: 5, label: "Terminé !", flacUrl, mp4Url, silentUrl, title });
      // Persistance historique (correctif "Mes macheups n'affiche qu'une
      // entrée", juillet 2026) : cf. services/mashupHistory.js — sans ça,
      // le résultat n'existait que dans le state React de MashupStudio.jsx,
      // perdu au moindre rechargement de page.
      addMashupToHistory({ id: jobId, title, flacUrl, mp4Url, silentUrl });
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
      // .catch() (Phase 5, juillet 2026 — trouvé en testant routes/mashupMulti.js,
      // même schéma ici) : sur Windows, un process ffmpeg tout juste tué (ex:
      // timeout de execAsync dans ffmpeg.js) peut garder son fichier de sortie
      // verrouillé quelques instants — rm() peut alors échouer avec EBUSY. Sans
      // ce filet, cette erreur de nettoyage devient une exception NON gérée qui
      // fait planter tout le process Node, donc TOUT le serveur (pas seulement
      // ce job) — un dossier tmp orphelin est un problème bien moins grave.
      await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[mashup] ${jobId} : nettoyage tmpDir incomplet (${err.code || err.message}) — sans conséquence sur les livrables déjà produits dans data/outputs.`);
      });
      if (lockKey && activeMashups.get(lockKey) === jobId) activeMashups.delete(lockKey);
    }
  })();
});

export default router;
