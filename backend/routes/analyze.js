import express from "express";
import multer from "multer";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, createReadStream } from "fs";
import { rename, rm } from "fs/promises";
import { downloadAudio } from "../services/ytdlp.js";
import { extractAudio } from "../services/ffmpeg.js";
import { analyzeAudio } from "../services/analyzer.js";
import { separateStems, separateStemsFull, STEM_MODE_NAMES } from "../services/demucs.js";
import { getTrack, upsertTrack } from "../db/index.js";
import { computeCompatibility } from "../services/scoring.js";
import { registerJobCleanup } from "../services/jobCleanup.js";

// ── Sélecteur 2/4 stems ──────────────────────────────────────────────────
// Décrit, pour chaque mode, la correspondance entre le nom de piste renvoyé
// par services/demucs.js et la colonne SQLite correspondante — utilisé à la
// fois pour vérifier le cache (stemsUsable ci-dessous) et pour construire la
// ligne à sauvegarder (upsertTrack) une fois la séparation terminée. "vocals"
// est toujours en 1ère position par convention (les helpers ci-dessous s'y
// fient pour retrouver rapidement le chemin de la voix). Le mode 6 (+
// guitare/piano) a été retiré (juillet 2026) — cf. commentaire dans
// services/demucs.js. Les colonnes guitar_path/piano_path restent dans le
// schéma SQLite (db/index.js) pour ne pas casser d'anciennes lignes déjà en
// cache, mais ne sont plus jamais écrites ni lues.
const STEM_COLUMNS_BY_MODE = {
  2: [["vocals", "vocals_path"], ["instrumental", "instrumental_path"]],
  4: STEM_MODE_NAMES[4].map(n => [n, `${n}_path`]),
};
// Toutes les colonnes de stems existantes, tous modes confondus — pour
// remettre à null celles qui NE font PAS partie du mode courant lors de
// l'upsert (évite de garder des chemins d'un mode précédent, incohérents
// avec le nouveau stem_mode enregistré).
const ALL_STEM_COLUMNS = ["vocals_path", "instrumental_path", "drums_path", "bass_path", "guitar_path", "piano_path", "other_path"];

const normalizeStemMode = (m) => ([2, 4].includes(Number(m)) ? Number(m) : 4);

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TMP_DIR = join(__dirname, "../tmp");
const OUT_DIR = join(__dirname, "../data/outputs/analyze");
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ── Jobs en mémoire (même pattern que routes/mashup.js, clipEditor.js, stems.js) ──
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });
registerJobCleanup(jobs, { label: "[analyze]" });

// ── Verrou par (videoId, stemMode) — audit juillet 2026 ──
// Sans ça, deux requêtes simultanées pour le même morceau (double-clic sur
// "Réanalyser", ou 2 Decks chargeant la même vidéo au même moment) lançaient
// chacune leur propre séparation Demucs vers le MÊME dossier de sortie
// (jobOut = data/outputs/analyze/<videoId>) : calcul GPU gaspillé en double,
// et risque réel de fichiers partiellement écrasés par le perdant de la
// course (rename() de l'un pouvant s'intercaler avec celui de l'autre).
// activeAnalyses associe "<videoId>:<stemMode>" au jobId déjà en cours pour
// cette combinaison ; une requête qui arrive pendant qu'un job tourne déjà
// se contente de renvoyer ce même jobId (le frontend, qui poll déjà
// GET /:id/status, voit sa progression comme s'il l'avait lancé lui-même).
const activeAnalyses = new Map();

// ── Upload d'un fichier audio local (mp3 perso, pas YouTube) ──
// Même dossier tmp que le reste de cette route, avec l'extension d'origine
// conservée (ffmpeg s'en sort en général sans, mais autant rester cohérent
// avec le même pattern déjà utilisé pour l'upload de routes/macheupdj.js).
const ALLOWED_UPLOAD_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".opus", ".webm"]);
const safeUploadExt = (originalName) => {
  const ext = extname(originalName || "").toLowerCase();
  return ALLOWED_UPLOAD_EXT.has(ext) ? ext : ".mp3";
};
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, `analyze_upload_${uuidv4()}${safeUploadExt(file.originalname)}`),
});
const uploadMulter = multer({ storage: uploadStorage, limits: { fileSize: 300 * 1024 * 1024 } });

// Hash de contenu (SHA-256, tronqué à 16 hex) → identifiant stable pour un
// fichier uploadé, préfixé "up_" pour ne jamais entrer en collision avec un
// id de vidéo YouTube (toujours 11 caractères, alphanumérique+-_). Uploader
// deux fois EXACTEMENT le même fichier retombe sur le même trackId, donc sur
// le même cache SQLite — pas de re-séparation Demucs pour rien.
const hashFile = (filePath) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(filePath)
    .on("data", (chunk) => hash.update(chunk))
    .on("end", () => resolve(hash.digest("hex").slice(0, 16)))
    .on("error", reject);
});

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

// ── Lecture directe du cache (pas de job nécessaire si déjà analysé) ──
// bpm == null : ligne présente en base mais analyse jamais aboutie (ou
// remise à zéro par la purge du cache empoisonné, cf. db/index.js) — NE PAS
// la traiter comme "déjà analysé", sinon le Deck (frontend) considère
// l'analyse terminée avec un résultat vide et affiche "? BPM · ?" pour
// toujours, sans jamais déclencher une vraie analyse (POST /api/analyze).
// Même garde que celle déjà appliquée sur la route POST ci-dessous.
// ?stemMode=2|4 (défaut 4) : n'accepte le cache QUE si son stem_mode
// correspond — sinon 404, pour forcer l'appelant (Deck.jsx) à repasser par
// POST / (qui re-sépare dans le bon mode). Sans cette vérification, changer
// de mode dans l'UI resterait sans effet pour un morceau déjà en cache sous
// l'ancien mode : ce raccourci le servirait tel quel indéfiniment.
// Correctif (retour utilisateur juillet 2026 : le carré rouge "stem
// introuvable" du Combo revenait indéfiniment, MÊME après avoir cliqué le
// badge "Réanalyser" du Deck) — root-causé : ce raccourci ne vérifiait QUE
// track.bpm et stem_mode, jamais l'existence RÉELLE des fichiers sur le
// disque (contrairement à la route POST / ci-dessous, qui a bien son propre
// garde-fou `stemsUsable`/`existsSync`). Deck.jsx (startAnalyzeFor) appelle
// D'ABORD cette route rapide, et ne retombe sur POST / (qui, lui, relance
// vraiment Demucs) QUE si celle-ci répond 404 — donc tant que ce raccourci
// répondait 200 avec des chemins bidon (fichiers effacés entre-temps par un
// redémarrage, cf. services/cleanup.js), cliquer "Réanalyser" ne régénérait
// jamais rien : Deck.jsx croyait les stems déjà prêts et le Combo continuait
// de pointer vers des fichiers fantômes. Même vérification `existsSync`
// ajoutée ici pour que ce cas retombe, lui aussi, sur une vraie re-séparation.
const resolveAnalyzeOutputPath = (url) => join(__dirname, "../data/outputs", (url || "").replace(/^\/outputs\//, ""));
router.get("/cached/:videoId", (req, res) => {
  const track = getTrack(req.params.videoId);
  if (!track || track.bpm == null) return res.status(404).json({ error: "Pas encore analysé." });
  const stemMode = normalizeStemMode(req.query.stemMode);
  if (normalizeStemMode(track.stem_mode) !== stemMode) {
    return res.status(404).json({ error: `En cache sous un autre mode (${track.stem_mode || "?"} stems, demandé : ${stemMode})` });
  }
  const stemColumns = STEM_COLUMNS_BY_MODE[stemMode];
  const stemsUsable = stemColumns.every(([, col]) => track[col] && existsSync(resolveAnalyzeOutputPath(track[col])));
  if (!stemsUsable) {
    return res.status(404).json({ error: "BPM/clé en cache mais stems manquants sur le disque (nettoyage ?) — re-séparation nécessaire." });
  }
  res.json(track);
});

// ── Analyse complète d'un morceau YouTube ──
// BPM/clé/énergie/structure/spectral (analyzer.js) + séparation 4 stems
// (demucs.js, GPU CUDA si dispo) → stocké en SQLite, indexé par videoId.
// Un morceau déjà analysé n'est JAMAIS retraité (Demucs = l'étape la plus
// lente, plusieurs minutes) — on sert directement le cache.
router.post("/", async (req, res) => {
  const { videoId, title = "track", stemMode: rawStemMode } = req.body;
  if (!videoId) return res.status(400).json({ error: "videoId requis" });
  const stemMode = normalizeStemMode(rawStemMode);

  const cached = getTrack(videoId);

  // Stems déjà séparés (Demucs, un traitement totalement indépendant du bug
  // Librosa ci-dessous) : on vérifie qu'ils sont toujours PRÉSENTS SUR LE
  // DISQUE avant de faire confiance au cache. La base SQLite garde les
  // chemins indéfiniment, mais les FICHIERS eux-mêmes sont volontairement
  // effacables (bouton 🧹 "Nettoyage" du Mixer, ou nettoyage de fermeture du
  // serveur, cf. services/cleanup.js — qui balaie tout .mp3/.flac/.mp4 sous
  // data/outputs/, SANS épargner data/outputs/analyze/). Bug constaté en
  // pratique : après un nettoyage, le cache-hit rapide ci-dessous renvoyait
  // quand même les chemins comme si de rien n'était → 404 silencieux côté
  // navigateur.
  //
  // AJOUT sélecteur 2/4 stems : le cache n'est utilisable QUE si le mode
  // demandé correspond au mode de la dernière séparation (cached.stem_mode)
  // — une seule "version" des stems est conservée par morceau (cf.
  // db/schema.sql), changer de mode oblige donc à re-séparer.
  const resolveAnalyzeOutput = (url) => join(__dirname, "../data/outputs", (url || "").replace(/^\/outputs\//, ""));
  const modeMatches = cached && normalizeStemMode(cached.stem_mode) === stemMode;
  const stemColumns = STEM_COLUMNS_BY_MODE[stemMode];
  const cachedStemPaths = modeMatches && stemColumns.every(([, col]) => cached[col])
    ? Object.fromEntries(stemColumns.map(([key, col]) => [key, cached[col]]))
    : null;
  const stemsUsable = cachedStemPaths && Object.values(cachedStemPaths).every(p => existsSync(resolveAnalyzeOutput(p)));

  // bpm null : analyse jamais aboutie, ou remise à zéro par la purge du
  // cache corrompu (cf. migration dans db/index.js) — NE PAS servir tel
  // quel, il faut relancer une vraie analyse. Un simple test de présence de
  // ligne ("if (cached)") traitait par erreur un résultat jamais obtenu
  // comme "déjà fait" — bug constaté en pratique : blocage permanent sur
  // bpm=120/camelot="8B" pour la quasi-totalité des morceaux de la base.
  // AJOUT stemsUsable : un bpm valide ne suffit plus à lui seul, il faut
  // aussi que les stems du mode demandé soient réellement là (cf. ci-dessus).
  if (cached && cached.bpm != null && stemsUsable) {
    return res.json({ cached: true, track: cached });
  }
  // console.log (pas console.warn) : ce sont des cas normaux/attendus et
  // auto-réparants (re-séparation automatique), pas de vraies erreurs — cf.
  // retour utilisateur juillet 2026 : console.warn/error écrit sur stderr,
  // que PowerShell 7 peut afficher en rouge sous forme de faux
  // "NativeCommandError" pour n'importe quelle sortie stderr d'un process
  // node.exe, même sans échec réel. Réservé désormais aux VRAIES erreurs.
  if (cached && cached.bpm != null && !modeMatches) {
    console.log(`[analyze] ${videoId} : mode demandé (${stemMode} stems) différent du cache (${cached.stem_mode || "?"} stems) — re-séparation forcée`);
  } else if (cached && cached.bpm != null && !stemsUsable) {
    console.log(`[analyze] ${videoId} : BPM/clé en cache mais stems manquants sur le disque (nettoyage ?) — re-séparation Demucs forcée`);
  } else if (cached) {
    console.log(`[analyze] ${videoId} : cache présent mais sans analyse BPM/clé valide — nouvelle analyse forcée`);
  }

  // Une analyse (même videoId + même stemMode) est déjà en cours : on
  // renvoie son jobId au lieu d'en démarrer une seconde en parallèle (cf.
  // commentaire sur activeAnalyses plus haut).
  const lockKey = `${videoId}:${stemMode}`;
  const runningJobId = activeAnalyses.get(lockKey);
  if (runningJobId && jobs.get(runningJobId)?.status === "running") {
    console.log(`[analyze] ${videoId} (${stemMode} stems) : analyse déjà en cours (job ${runningJobId}) — pas de second lancement`);
    return res.json({ jobId: runningJobId });
  }

  const jobId = uuidv4();
  const jobTmp = join(TMP_DIR, `analyze-${jobId}`);
  const jobOut = join(OUT_DIR, videoId);
  mkdirSync(jobTmp, { recursive: true });
  mkdirSync(jobOut, { recursive: true });

  activeAnalyses.set(lockKey, jobId);
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
      // Ne PAS continuer (et surtout ne pas mettre en cache) si l'analyse
      // Librosa a échoué — cf. services/analyzer.js : un ancien repli
      // silencieux renvoyait des valeurs plausibles (bpm=120, camelot="8B")
      // qui finissaient mises en cache comme un vrai résultat, pour chaque
      // morceau échoué. On fait échouer le job explicitement à la place,
      // avec le vrai message d'erreur Python, pour que ce soit visible et
      // corrigeable (typiquement : dépendance manquante dans l'environnement
      // Python utilisé par le serveur — "pip install librosa soundfile").
      if (features.analysisFailed) {
        throw new Error(`Analyse musicale (BPM/clé) impossible : ${features.analysisError}`);
      }

      // stemNames : noms de pistes attendus pour CE mode (ex: mode 6 →
      // ["vocals","drums","bass","guitar","piano","other"]) — dérivés de
      // STEM_COLUMNS_BY_MODE pour rester cohérents avec le cache-check
      // plus haut, quel que soit le mode choisi (2/4/6).
      const stemNames = stemColumns.map(([key]) => key);
      let stemFileNames; // { [stemName]: "vocals.flac", ... } — noms de fichiers finaux dans jobOut
      if (stemsUsable) {
        console.log(`[analyze] ${videoId} : stems (${stemMode} pistes) déjà valides sur le disque — Demucs non relancé (seule l'analyse BPM/clé a été refaite)`);
        updateJob(jobId, { step: "separate" });
        stemFileNames = {};
        for (const name of stemNames) stemFileNames[name] = `${name}${extname(cachedStemPaths[name])}`;
        // Les fichiers sont déjà au bon endroit (jobOut === le dossier où ils
        // ont été écrits la première fois) : rien à copier.
      } else {
        updateJob(jobId, { step: "separate" });
        const stemsTmp = join(jobTmp, "stems");
        const separated = stemMode === 2
          ? await separateStems(wav, stemsTmp)
          : await separateStemsFull(wav, stemsTmp, stemMode);

        stemFileNames = {};
        for (const name of stemNames) stemFileNames[name] = `${name}${extname(separated[name])}`;
        // rename() plutôt que copyFile() : stemsTmp est un dossier jetable
        // (supprimé dans le "finally" plus bas), les stems n'y sont plus
        // utilisés une fois déplacés — un déplacement (même disque) est
        // quasi instantané, contrairement à une copie qui duplique des
        // fichiers FLAC potentiellement volumineux sur le disque.
        await Promise.all(
          stemNames.map(name => rename(separated[name], join(jobOut, stemFileNames[name])))
        );
      }

      // Chemins de stems à écrire en base pour CE mode ; toutes les colonnes
      // de stems des AUTRES modes sont explicitement remises à null (évite
      // de garder des chemins d'un mode précédent, incohérents avec le
      // nouveau stem_mode enregistré juste après).
      const stemPathFields = {};
      for (const col of ALL_STEM_COLUMNS) stemPathFields[col] = null;
      for (const [key, col] of stemColumns) stemPathFields[col] = `/outputs/analyze/${videoId}/${stemFileNames[key]}`;

      const track = upsertTrack({
        id: videoId,
        source: "youtube",
        title,
        duration: features.duration,
        bpm: features.bpm,
        key_pitch: features.key_pitch,
        key_mode: features.key_mode,
        key_confidence: features.key_confidence,
        camelot: features.camelot,
        energy_rms: features.energy_rms,
        energy_std: features.energy_std,
        spectral_centroid: features.spectral_centroid,
        mfcc_json: JSON.stringify(features.mfcc_mean || []),
        structure_json: JSON.stringify(features.structure || []),
        beat_times_json: JSON.stringify(features.beat_times || []),
        kick_times_json: JSON.stringify(features.kick_times || []),
        snare_times_json: JSON.stringify(features.snare_times || []),
        drops_json: JSON.stringify(features.drops || []),
        stem_mode: String(stemMode),
        ...stemPathFields,
        analyzed_at: Date.now(),
      });

      updateJob(jobId, { status: "done", step: "done", track });
      console.log(`✅ [analyze] ${videoId} terminé (BPM ${track.bpm}, ${track.camelot})`);
    } catch (err) {
      console.error(`❌ [analyze] ${videoId} échoué :`, err.message);
      updateJob(jobId, { status: "error", message: err.message });
    } finally {
      // Le diagnostic temporaire (crash natif Python 0xC0000005) qui gardait
      // le dossier temporaire de TOUT job en échec — pour rejouer le script
      // Python à la main — est retiré (audit juillet 2026) : le crash est
      // désormais géré par la reprise automatique en 2 temps de
      // analyzeAudio() (services/analyzer.js, safe_tempo_and_beats), rendant
      // cette conservation inutile ; elle avait dégénéré en fuite disque
      // silencieuse (un dossier complet, audio.wav inclus, par échec —
      // fréquent avec des vidéos indisponibles/privées/géo-bloquées), jamais
      // balayée par services/cleanup.js. Nettoyage systématique restauré.
      await rm(jobTmp, { recursive: true, force: true }).catch(() => {});
      // Libère le verrou (uniquement si c'est toujours CE job qui le détient —
      // il ne devrait normalement jamais y avoir de collision, mais on évite
      // par prudence de supprimer le verrou d'un job plus récent).
      if (activeAnalyses.get(lockKey) === jobId) activeAnalyses.delete(lockKey);
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

// ── Analyse complète d'un fichier audio UPLOADÉ (mp3 perso, pas YouTube) ──
// Même pipeline que POST / ci-dessus (BPM/clé/structure + séparation stems),
// mais à partir d'un fichier envoyé par le navigateur plutôt que d'un
// téléchargement YouTube — cf. hashFile()/uploadMulter ci-dessus pour le
// trackId stable. Même contrat de réponse que POST / ({cached:true,track}
// ou {jobId}) pour que le frontend puisse réutiliser tel quel son polling
// existant (GET /:id/status, déjà 100% générique, aucune dépendance à
// videoId au-delà du nom du champ).
//
// Logique de cache/verrou dupliquée volontairement depuis POST / plutôt que
// factorisée à chaud : cette route a sa propre histoire d'edge cases
// documentés en commentaires plus haut dans ce fichier, préférable de ne pas
// la faire dépendre d'un chemin supplémentaire tant que celui-ci n'a pas été
// éprouvé en usage réel.
router.post("/upload", uploadMulter.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier audio manquant." });
  const rawPath = req.file.path;
  const title = req.body.title || req.file.originalname || "track";
  const stemMode = normalizeStemMode(req.body.stemMode);

  try {
    const trackId = `up_${await hashFile(rawPath)}`;
    const stemColumns = STEM_COLUMNS_BY_MODE[stemMode];

    const cached = getTrack(trackId);
    const resolveOut = (url) => join(__dirname, "../data/outputs", (url || "").replace(/^\/outputs\//, ""));
    const modeMatches = cached && normalizeStemMode(cached.stem_mode) === stemMode;
    const cachedStemPaths = modeMatches && stemColumns.every(([, col]) => cached[col])
      ? Object.fromEntries(stemColumns.map(([key, col]) => [key, cached[col]]))
      : null;
    const stemsUsable = cachedStemPaths && Object.values(cachedStemPaths).every(p => existsSync(resolveOut(p)));

    if (cached && cached.bpm != null && stemsUsable) {
      await rm(rawPath, { force: true }).catch(() => {});
      return res.json({ cached: true, track: cached });
    }

    const lockKey = `${trackId}:${stemMode}`;
    const runningJobId = activeAnalyses.get(lockKey);
    if (runningJobId && jobs.get(runningJobId)?.status === "running") {
      await rm(rawPath, { force: true }).catch(() => {});
      return res.json({ jobId: runningJobId });
    }

    const jobId = uuidv4();
    const jobTmp = join(TMP_DIR, `analyze-${jobId}`);
    const jobOut = join(OUT_DIR, trackId);
    mkdirSync(jobTmp, { recursive: true });
    mkdirSync(jobOut, { recursive: true });

    activeAnalyses.set(lockKey, jobId);
    res.json({ jobId });
    updateJob(jobId, { status: "running", step: "extract", videoId: trackId, title });

    (async () => {
      try {
        const wav = join(jobTmp, "audio.wav");
        await extractAudio(rawPath, wav);

        updateJob(jobId, { step: "analyze" });
        const features = await analyzeAudio(wav);
        if (features.analysisFailed) {
          throw new Error(`Analyse musicale (BPM/clé) impossible : ${features.analysisError}`);
        }

        const stemNames = stemColumns.map(([key]) => key);
        updateJob(jobId, { step: "separate" });
        const stemsTmp = join(jobTmp, "stems");
        const separated = stemMode === 2
          ? await separateStems(wav, stemsTmp)
          : await separateStemsFull(wav, stemsTmp, stemMode);

        const stemFileNames = {};
        for (const name of stemNames) stemFileNames[name] = `${name}${extname(separated[name])}`;
        await Promise.all(
          stemNames.map(name => rename(separated[name], join(jobOut, stemFileNames[name])))
        );

        const stemPathFields = {};
        for (const col of ALL_STEM_COLUMNS) stemPathFields[col] = null;
        for (const [key, col] of stemColumns) stemPathFields[col] = `/outputs/analyze/${trackId}/${stemFileNames[key]}`;

        const track = upsertTrack({
          id: trackId,
          source: "upload",
          title,
          duration: features.duration,
          bpm: features.bpm,
          key_pitch: features.key_pitch,
          key_mode: features.key_mode,
          key_confidence: features.key_confidence,
          camelot: features.camelot,
          energy_rms: features.energy_rms,
          energy_std: features.energy_std,
          spectral_centroid: features.spectral_centroid,
          mfcc_json: JSON.stringify(features.mfcc_mean || []),
          structure_json: JSON.stringify(features.structure || []),
          beat_times_json: JSON.stringify(features.beat_times || []),
          kick_times_json: JSON.stringify(features.kick_times || []),
          snare_times_json: JSON.stringify(features.snare_times || []),
          drops_json: JSON.stringify(features.drops || []),
          stem_mode: String(stemMode),
          ...stemPathFields,
          analyzed_at: Date.now(),
        });

        updateJob(jobId, { status: "done", step: "done", track });
        console.log(`✅ [analyze] ${trackId} (upload "${title}") terminé (BPM ${track.bpm}, ${track.camelot})`);
      } catch (err) {
        console.error(`❌ [analyze] ${trackId} (upload) échoué :`, err.message);
        updateJob(jobId, { status: "error", message: err.message });
      } finally {
        await rm(jobTmp, { recursive: true, force: true }).catch(() => {});
        await rm(rawPath, { force: true }).catch(() => {});
        if (activeAnalyses.get(lockKey) === jobId) activeAnalyses.delete(lockKey);
      }
    })();
  } catch (err) {
    await rm(rawPath, { force: true }).catch(() => {});
    console.error("❌ [analyze] upload échoué avant lancement du job :", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
