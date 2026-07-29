// ── Mashup Wheel ───────────────────────────────────────────────────────
//
// Étant donné un morceau déjà analysé (Deck A, cf. routes/analyze.js), trouve
// une liste de morceaux candidats compatibles pour un mix DJ ou un mashup :
// rythmique (BPM), harmonie (Camelot/clé), énergie, structure et timbre —
// en réutilisant TEL QUEL le moteur de scoring déjà existant
// (services/scoring.js, computeCompatibility), sans aucun nouveau calcul
// audio pour les morceaux déjà en base.
//
// Le bassin de candidats vient de 2 sources :
//   1. La bibliothèque locale (SQLite, tous les morceaux déjà analysés par
//      l'app, tous utilisateurs/decks confondus) — instantané, 0 traitement.
//   2. Une découverte complémentaire (recherche YouTube dérivée du titre/
//      artiste du morceau source + "remix"/"mashup") pour les nouveaux
//      morceaux jamais vus — chacun reçoit une analyse ALLÉGÉE (BPM/clé/
//      structure via Librosa, SANS séparation Demucs 4 stems, beaucoup trop
//      lente pour rester en ligne sur un simple "trouve-moi des candidats").
//      Une vraie séparation ne sera faite QUE si l'utilisateur choisit
//      effectivement ce candidat pour un mashup (routes/mashup.js s'en charge
//      lui-même à ce moment-là, indépendamment de ce module).
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { rm } from "fs/promises";
import { downloadAudio } from "../services/ytdlp.js";
import { extractAudio } from "../services/ffmpeg.js";
import { analyzeAudio } from "../services/analyzer.js";
import { getTrack, upsertTrack, listAnalyzedTracks } from "../db/index.js";
import { computeCompatibility } from "../services/scoring.js";
import { registerJobCleanup } from "../services/jobCleanup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TMP_DIR = join(__dirname, "../tmp");
mkdirSync(TMP_DIR, { recursive: true });

const SELF_BASE = `http://localhost:${process.env.PORT || 3001}`;

// ── Jobs en mémoire (même pattern que routes/analyze.js, mashup.js...) ──
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });
registerJobCleanup(jobs, { label: "[mashup-wheel]" });

// ── Verrou anti-doublon (généralisé lors de l'audit de juillet 2026, même
// principe que routes/mashup.js/analyze.js) — sans ça, relancer la roue 2
// fois de suite sur le même morceau avant la fin du premier calcul (clic
// rapide, changement d'onglet et retour) lance 2 découvertes YouTube/analyses
// en parallèle pour rien, chacune pouvant re-télécharger/analyser les mêmes
// morceaux candidats. Clé = videoId source uniquement (un seul calcul de
// roue par morceau source à la fois, quel que soit qui l'a demandé).
const activeWheels = new Map(); // videoId -> jobId
const isJobActive = (id) => {
  const job = jobs.get(id);
  return !!job && job.status !== "done" && job.status !== "error";
};

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

// ── Nettoyage léger du titre pour dériver des requêtes de recherche ──
// Retire les mentions entre parenthèses/crochets ("(Official Video)",
// "[Lyrics]"...) et les mots-clés parasites les plus courants — le but n'est
// pas un nettoyage parfait, juste une requête YouTube exploitable.
const cleanTitle = (t) => (t || "")
  .replace(/\(.*?\)|\[.*?\]/g, " ")
  .replace(/official\s*(music\s*)?video|official\s*audio|lyrics?|hd|4k|remaster(ed)?/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

// ── Analyse allégée (BPM/clé/structure), SANS séparation Demucs ──
// Réutilisée uniquement pour les candidats découverts via YouTube (pas déjà
// en base) — cf. commentaire d'en-tête. Si une ligne existe déjà pour cet id
// (même partielle, ex: stems déjà séparés ailleurs mais bpm jamais calculé),
// on préserve ses chemins de stems existants plutôt que de les écraser par
// NULL (upsertTrack réécrit TOUTES les colonnes à chaque appel).
const lightAnalyze = async (videoId, title) => {
  const existing = getTrack(videoId);
  if (existing && existing.bpm != null) return existing; // déjà analysé (léger ou complet) — pas la peine de refaire

  const jobTmp = join(TMP_DIR, `wheel-${videoId}-${Date.now()}`);
  mkdirSync(jobTmp, { recursive: true });
  try {
    const audioBase = join(jobTmp, "raw");
    await downloadAudio(videoId, audioBase);
    const exts = [".wav", ".opus", ".webm", ".m4a", ".mp3", ".ogg", ".flac", ".aac"];
    const rawAudio = exts.map(e => audioBase + e).find(p => existsSync(p));
    if (!rawAudio) throw new Error("Audio introuvable après téléchargement");

    const wav = join(jobTmp, "audio.wav");
    await extractAudio(rawAudio, wav);

    const features = await analyzeAudio(wav);
    if (features.analysisFailed) throw new Error(features.analysisError || "Analyse musicale impossible");

    return upsertTrack({
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
      // Préserve d'éventuels stems déjà séparés par ailleurs (cf. commentaire
      // ci-dessus) — jamais écrasés par cette analyse allégée.
      vocals_path: existing?.vocals_path ?? null,
      drums_path: existing?.drums_path ?? null,
      bass_path: existing?.bass_path ?? null,
      other_path: existing?.other_path ?? null,
      analyzed_at: Date.now(),
    });
  } finally {
    await rm(jobTmp, { recursive: true, force: true }).catch(() => {});
  }
};

// ── Classification "type de mix" à partir des sous-scores ──
// Pure heuristique de présentation (aucun calcul supplémentaire) : aide
// l'utilisateur à comprendre EN QUOI un candidat est proposé plutôt que de
// n'afficher qu'un score brut.
//   - BPM + Clé élevés mais Structure faible → les 2 morceaux sonnent bien
//     ensemble rythmiquement/harmoniquement mais ont une forme différente :
//     profil typique d'un bon MASHUP (superposition voix/instru).
//   - BPM + Structure + Spectral élevés → morceaux globalement très proches
//     (même énergie, même forme, même timbre) : profil d'un MIX DJ fluide
//     (enchaînement/crossfade plutôt qu'une vraie superposition).
//   - Sinon, compatible dans l'ensemble sans profil marqué, ou peu fiable.
const classifyMix = (sub) => {
  if (sub.bpm >= 70 && sub.key >= 70 && sub.structure < 55) {
    return { mixType: "mashup", mixTypeLabel: "🎧 Mashup harmonique" };
  }
  if (sub.bpm >= 70 && sub.structure >= 60 && sub.spectral >= 60) {
    return { mixType: "mix", mixTypeLabel: "🔀 Mix DJ fluide" };
  }
  if (sub.bpm >= 60 && sub.key >= 60) {
    return { mixType: "compatible", mixTypeLabel: "✨ Compatible" };
  }
  return { mixType: "experimental", mixTypeLabel: "🧪 Expérimental" };
};

const toItem = (track, result, extra = {}) => ({
  videoId: track.id,
  title: track.title,
  channel: extra.channel ?? null,
  thumbnail: extra.thumbnail || `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`,
  bpm: track.bpm != null ? Math.round(track.bpm) : null,
  camelot: track.camelot || null,
  keyLabel: [track.key_pitch, track.key_mode === "major" ? "maj" : track.key_mode === "minor" ? "min" : ""].filter(Boolean).join(" "),
  score: result.score,
  subscores: result.subscores,
  pitchShiftSemitones: result.pitchShiftSemitones,
  vocalLockEngaged: result.vocalLockEngaged,
  ...classifyMix(result.subscores),
  origin: extra.origin || "library",
  // Renseigné uniquement pour les candidats trouvés via extractMashupPartner
  // ci-dessous : référence vers le mashup/mix RÉEL déjà publié sur YouTube
  // qui a révélé ce candidat — preuve concrète que la paire fonctionne,
  // au-delà du simple score de compatibilité calculé.
  foundInMashup: extra.foundInMashup || null,
});

// ── Détection de mashups/mixes DÉJÀ EXISTANTS impliquant ce morceau ──────
// Demande explicite : avant de se fier uniquement au score BPM/clé/énergie
// calculé, interroger YouTube pour voir si quelqu'un a DÉJÀ publié un
// mashup/mix avec ce morceau — si oui, l'autre moitié du titre EST un
// candidat mixable prouvé par l'exemple, pas une simple estimation.
// Les titres de mashup/mix DJ suivent presque toujours un motif
// "Morceau A vs/x/+ Morceau B" — on découpe sur ces séparateurs courants.
const PAIR_SEPARATORS = /\s+(?:vs\.?|versus|[x×]|\+|\/|mashed? with|mashup with)\s+/i;

// Nettoyage du fragment extrait : retire les mentions résiduelles
// "(Mashup)"/"[Official]"/"remix"/etc. qui traînent souvent après la découpe.
const cleanExtractedName = (s) => (s || "")
  .replace(/\(.*?\)|\[.*?\]/g, " ")
  .replace(/\bmashup\b|\bremix\b|\bmix\b|\bofficial\b|\bvideo\b|\baudio\b/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

// Similarité grossière par mots communs — suffisant pour décider si un
// fragment de titre EST notre morceau source (pas besoin d'une vraie
// distance d'édition ici, juste éviter de confondre les 2 moitiés).
const wordsOf = (s) => new Set(
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2)
);
const overlapScore = (a, b) => {
  const wa = wordsOf(a), wb = wordsOf(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
};

// Essaie d'extraire le morceau "partenaire" d'un titre de mashup/mix qui
// mentionne déjà notre morceau source — renvoie null si le titre ne suit
// aucun motif "A vs/x B" reconnaissable, ou si on ne peut identifier avec
// assez de confiance QUELLE moitié est la source (évite de proposer un faux
// candidat sur un titre "vs"/"x" sans rapport avec notre morceau).
const MIN_SOURCE_MATCH_CONFIDENCE = 0.34;
const extractMashupPartner = (mashupTitle, baseTitle, channel) => {
  if (!PAIR_SEPARATORS.test(mashupTitle || "")) return null;
  const parts = mashupTitle.split(PAIR_SEPARATORS).map(cleanExtractedName).filter(Boolean);
  if (parts.length < 2) return null;
  const sourceRef = [baseTitle, channel].filter(Boolean).join(" ");
  let sourceIdx = -1, bestScore = MIN_SOURCE_MATCH_CONFIDENCE;
  parts.forEach((p, i) => {
    const score = overlapScore(p, sourceRef);
    if (score > bestScore) { bestScore = score; sourceIdx = i; }
  });
  if (sourceIdx === -1) return null;
  const candidate = parts.find((p, i) => i !== sourceIdx && p.length >= 2);
  return candidate || null;
};

// Plafonds relevés (retour utilisateur, juillet 2026 : "le nombre de
// propositions a l'air limité") — même constat que le sélecteur de clips
// DJMUP (Ext.jsx) et la recherche des Decks, plafonnés trop bas à l'origine.
// MAX_RESULTS 12→24 : la bibliothèque locale (pool, gratuit/instantané)
// dépasse souvent ce plafond une fois quelques dizaines de morceaux
// analysés — les candidats en trop restaient invisibles pour rien.
// MAX_DISCOVER 10→18 : plus de marge pour la découverte YouTube quand le
// pool local ne suffit pas encore (chaque candidat découvert coûte un
// téléchargement + une analyse légère, donc pas démesuré non plus).
const MAX_DISCOVER = 18;
const MAX_RESULTS = 24;

// ── Seuil d'affichage sur la roue ──
// N'affiche que les candidats "orange" ou "vert" (mêmes seuils de couleur que
// le score de compatibilité déjà utilisé dans le Mixer, cf. Mixer.jsx et
// MashupWheel.jsx : score < 40 = rouge). Les candidats rouges sont trop peu
// compatibles pour être utiles sur cette page — mieux vaut ne rien montrer
// que d'afficher un match qui sonnera clairement mal.
const MIN_DISPLAY_SCORE = 40;

// ── Pioche aléatoire dans la bibliothèque locale (juillet 2026, demande
// explicite) ──────────────────────────────────────────────────────────────
// "créer une seconde roue qui va chercher aléatoirement selon la base de
// données un clip chanson qui va pouvoir se marier avec le clip du deck A" —
// contrairement à /start (bibliothèque + découverte YouTube + détection de
// mashups existants, potentiellement lent, plusieurs candidats), ce point
// d'entrée reste VOLONTAIREMENT limité à la bibliothèque locale déjà
// analysée (aucun appel réseau, réponse quasi instantanée) et renvoie UN
// SEUL candidat tiré AU HASARD parmi ceux jugés compatibles (score >=
// MIN_DISPLAY_SCORE, mêmes seuils que la roue ①) — esprit "roue de la
// fortune"/tirage, pas un classement à choisir soi-même.
router.get("/random-match/:videoId", (req, res) => {
  const { videoId } = req.params;
  const source = getTrack(videoId);
  if (!source || source.bpm == null) {
    return res.status(400).json({
      error: "Ce morceau n'a pas encore été analysé (BPM/clé) — patiente la fin de l'analyse automatique du Deck avant de piocher.",
    });
  }

  const pool = listAnalyzedTracks(videoId);
  const candidates = pool
    .map(track => ({ track, result: computeCompatibility(source, track) }))
    .filter(({ result }) => result.score >= MIN_DISPLAY_SCORE);

  if (candidates.length === 0) {
    return res.status(404).json({
      error: "Aucun morceau suffisamment compatible dans la bibliothèque locale pour l'instant — analyse d'autres morceaux dans MacheUp (ou via la roue ① ci-dessus) pour enrichir le tirage au fil du temps.",
    });
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  res.json({
    item: toItem(pick.track, pick.result, { origin: "library" }),
    sourceTrack: {
      videoId: source.id, title: source.title, bpm: Math.round(source.bpm),
      camelot: source.camelot, keyLabel: [source.key_pitch, source.key_mode === "major" ? "maj" : "min"].filter(Boolean).join(" "),
    },
    poolSize: candidates.length,
  });
});

router.post("/start", async (req, res) => {
  const { videoId, title, channel } = req.body || {};
  if (!videoId) return res.status(400).json({ error: "videoId requis" });

  const source = getTrack(videoId);
  if (!source || source.bpm == null) {
    return res.status(400).json({ error: "Ce morceau n'a pas encore été analysé (BPM/clé) — patiente la fin de l'analyse automatique du Deck avant de chercher des correspondances." });
  }

  // Verrou anti-doublon — cf. commentaire sur activeWheels plus haut.
  const runningJobId = activeWheels.get(videoId);
  if (runningJobId && isJobActive(runningJobId)) {
    console.log(`[mashup-wheel] ${videoId} : calcul déjà en cours (job ${runningJobId}) — pas de second lancement`);
    return res.json({ jobId: runningJobId });
  }

  const jobId = uuidv4();
  activeWheels.set(videoId, jobId);
  res.json({ jobId });
  updateJob(jobId, { status: "running", step: "pool", videoId, title: title || source.title });

  (async () => {
    try {
      // 1) Bibliothèque locale — instantané, aucun traitement audio.
      const pool = listAnalyzedTracks(videoId);
      const scoredPool = pool
        .map(track => ({ track, result: computeCompatibility(source, track) }))
        .filter(({ result }) => result.score > 0);

      // 2) Découverte complémentaire via recherche YouTube — seulement si la
      // bibliothèque locale n'a pas encore assez de candidats AFFICHABLES
      // (orange/vert, cf. MIN_DISPLAY_SCORE) — pas la peine de retélécharger/
      // analyser des morceaux pour rien si on a déjà de quoi proposer une
      // belle sélection. On compte ceux qui passeront réellement le filtre
      // d'affichage, pas juste "score > 0" (sinon un pool plein de rouges
      // aurait empêché la découverte alors que la roue serait restée vide).
      const displayableFromPool = scoredPool.filter(({ result }) => result.score >= MIN_DISPLAY_SCORE).length;
      const baseTitle = cleanTitle(source.title || title || "");
      // "seen" partagé entre la découverte générique (2) et la détection de
      // mashups existants (2b) ci-dessous, pour ne jamais analyser 2 fois le
      // même videoId ni proposer un doublon de la bibliothèque locale.
      const seen = new Set([videoId, ...pool.map(t => t.id)]);
      let discoveredScored = [];
      // Seuil relevé 8→16 en même temps que MAX_RESULTS (cf. plus haut) —
      // sinon la découverte s'arrêtait bien avant d'avoir de quoi remplir
      // une roue à 24 candidats.
      if (displayableFromPool < 16) {
        updateJob(jobId, { step: "discover" });
        const queries = [
          channel && `${channel} mashup`,
          channel && `${channel} remix`,
          baseTitle && `${baseTitle} remix`,
          baseTitle && `${baseTitle} mashup`,
          channel || null,
        ].filter(Boolean);

        const discoveredRaw = [];
        for (const q of queries) {
          if (discoveredRaw.length >= MAX_DISCOVER) break;
          try {
            const r = await fetch(`${SELF_BASE}/api/youtube/search?q=${encodeURIComponent(q)}`);
            const data = await r.json();
            if (!Array.isArray(data)) continue; // clé API manquante / quota épuisé / erreur — dégrade sans planter
            for (const v of data) {
              if (discoveredRaw.length >= MAX_DISCOVER) break;
              if (v.unavailable || seen.has(v.videoId)) continue;
              seen.add(v.videoId);
              discoveredRaw.push(v);
            }
          } catch (e) {
            console.warn(`[mashup-wheel] recherche "${q}" échouée :`, e.message);
          }
        }

        updateJob(jobId, { step: "analyze", discoverTotal: discoveredRaw.length, discoverDone: 0 });
        for (const v of discoveredRaw) {
          try {
            const track = await lightAnalyze(v.videoId, v.title);
            if (track?.bpm != null) {
              const result = computeCompatibility(source, track);
              if (result.score > 0) {
                discoveredScored.push({ track, result, channel: v.channel, thumbnail: v.thumbnail });
              }
            }
          } catch (e) {
            console.warn(`[mashup-wheel] analyse allégée échouée pour ${v.videoId} :`, e.message);
          }
          updateJob(jobId, { discoverDone: (jobs.get(jobId)?.discoverDone || 0) + 1 });
        }
      }

      // 2b) Détection de mashups/mixes DÉJÀ EXISTANTS sur YouTube pour ce
      // morceau — TOUJOURS exécutée (pas conditionnée à displayableFromPool),
      // car une paire "prouvée" par un mashup réel déjà publié est une info
      // à part entière, distincte d'une simple estimation de compatibilité.
      // Cf. commentaire détaillé + extractMashupPartner() plus haut dans ce
      // fichier. On reste volontairement modeste sur le nombre de requêtes
      // (3 max) : ce n'est qu'un signal complémentaire, pas la découverte
      // principale.
      updateJob(jobId, { step: "existing-mashups" });
      let existingMashupScored = [];
      try {
        const pairQueries = [
          baseTitle && `${baseTitle} vs`,
          baseTitle && `${baseTitle} mashup`,
          channel && `${channel} vs`,
        ].filter(Boolean);

        const mashupHits = [];
        for (const q of pairQueries) {
          if (mashupHits.length >= MAX_DISCOVER) break;
          try {
            const r = await fetch(`${SELF_BASE}/api/youtube/search?q=${encodeURIComponent(q)}`);
            const data = await r.json();
            if (!Array.isArray(data)) continue;
            for (const v of data) {
              if (v.unavailable) continue;
              mashupHits.push(v);
            }
          } catch (e) {
            console.warn(`[mashup-wheel] recherche mashup existant "${q}" échouée :`, e.message);
          }
        }

        for (const v of mashupHits) {
          if (existingMashupScored.length >= 6) break; // on ne propose pas une liste sans fin de "preuves"
          const partnerName = extractMashupPartner(v.title, baseTitle, channel);
          if (!partnerName) continue;
          try {
            // Recherche le morceau "partenaire" identifié en tant que vidéo
            // À PART (pas le mashup lui-même, qui contient déjà les 2 pistes
            // superposées et n'est donc pas exploitable comme source Deck B).
            const r2 = await fetch(`${SELF_BASE}/api/youtube/search?q=${encodeURIComponent(partnerName)}`);
            const data2 = await r2.json();
            if (!Array.isArray(data2) || !data2.length) continue;
            const clean = data2.find(x => !x.unavailable && !seen.has(x.videoId)) || null;
            if (!clean) continue;
            seen.add(clean.videoId);
            const track = await lightAnalyze(clean.videoId, clean.title);
            if (track?.bpm == null) continue;
            const result = computeCompatibility(source, track);
            existingMashupScored.push({
              track, result, channel: clean.channel, thumbnail: clean.thumbnail,
              foundInMashup: { videoId: v.videoId, title: v.title },
            });
          } catch (e) {
            console.warn(`[mashup-wheel] vérification partenaire "${partnerName}" échouée :`, e.message);
          }
        }
      } catch (e) {
        console.warn("[mashup-wheel] détection mashups existants ignorée :", e.message);
      }

      // 3) Fusion + tri + seuil d'affichage (orange/vert seulement) + top N.
      // Les candidats "existing_mashup" (preuve d'un mashup réel) passent
      // même si leur score de compatibilité calculé est un peu plus faible
      // que MIN_DISPLAY_SCORE : quelqu'un l'a déjà fait, c'est une preuve
      // plus forte qu'une estimation — seuil légèrement abaissé pour eux.
      const MIN_DISPLAY_SCORE_PROVEN = 25;
      const combined = [
        ...scoredPool.map(({ track, result }) => toItem(track, result, { origin: "library" })),
        ...discoveredScored.map(({ track, result, channel: ch, thumbnail }) =>
          toItem(track, result, { origin: "discovered", channel: ch, thumbnail })),
        ...existingMashupScored.map(({ track, result, channel: ch, thumbnail, foundInMashup }) =>
          toItem(track, result, { origin: "existing_mashup", channel: ch, thumbnail, foundInMashup })),
      ]
        .filter(item => item.score >= (item.origin === "existing_mashup" ? MIN_DISPLAY_SCORE_PROVEN : MIN_DISPLAY_SCORE))
        .sort((a, b) => (a.origin === "existing_mashup") !== (b.origin === "existing_mashup")
          ? (a.origin === "existing_mashup" ? -1 : 1) // preuves réelles toujours en tête
          : b.score - a.score)
        .slice(0, MAX_RESULTS);

      updateJob(jobId, {
        status: "done",
        step: "done",
        items: combined,
        sourceTrack: {
          videoId: source.id, title: source.title, bpm: Math.round(source.bpm),
          camelot: source.camelot, keyLabel: [source.key_pitch, source.key_mode === "major" ? "maj" : "min"].filter(Boolean).join(" "),
        },
      });
    } catch (err) {
      console.error("[mashup-wheel] échec :", err.message);
      updateJob(jobId, { status: "error", message: err.message });
    } finally {
      // Libère le verrou (uniquement si c'est toujours CE job qui le détient).
      if (activeWheels.get(videoId) === jobId) activeWheels.delete(videoId);
    }
  })();
});

export default router;
