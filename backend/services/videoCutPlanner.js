// ── Planner de coupes vidéo calé sur la musique (Phase 3, juillet 2026) ─────
// Remplace, quand les données sont disponibles, le montage à durée FIXE de
// buildAlternatingFilter (6-14s par segment, sans rapport avec le morceau)
// par un plan dont CHAQUE coupe tombe sur un temps fort réel (beat_times,
// déjà calculé par analyzer.js/analyzer_worker.py) et dont le point de départ
// dans chaque vidéo source évite autant que possible de démarrer en plein
// milieu d'un plan déjà en cours (scènes détectées par videoAnalysis.js).
//
// Fonction PURE (aucun appel ffmpeg ici) — toutes les entrées sont déjà
// calculées ailleurs (analyse audio + detectSceneCuts), ce qui la rend
// testable isolément sans dépendance à un vrai fichier vidéo/audio.
//
// Repli automatique : si beatTimes est absent/trop court, on tombe sur EXACTE-
// MENT le même calcul que l'ancien videoSegmentDuration (segment de durée
// fixe) — cette fonction ne peut donc jamais produire un plan "pire" que
// l'ancien comportement, seulement l'améliorer quand l'info est là.

const MAX_SEGMENTS_DEFAULT = 12;

// Durée minimale d'un segment après accroche sur un temps fort — évite
// qu'une limite de segment ne se retrouve collée à sa voisine (segment
// quasi invisible, transition xfade qui n'a pas le temps de "respirer").
const MIN_SEGMENT_SEC = 2.5;

// Arrondit une durée cible au nombre de MESURES (par défaut 4 beats) le plus
// proche du beat grid réel, plutôt qu'à une durée arbitraire — permet à
// chaque coupe de tomber pile sur un temps fort. minBeats=4 correspond à une
// mesure 4/4 standard (même hypothèse que snapToMeasureBoundary dans
// routes/mashup.js, réutilisée ici côté vidéo).
const snapDurationToBeats = (targetSec, beatTimes, minBeats = 4) => {
  if (!Array.isArray(beatTimes) || beatTimes.length < 2) return targetSec;
  const intervals = [];
  for (let i = 1; i < beatTimes.length; i++) intervals.push(beatTimes[i] - beatTimes[i - 1]);
  const avgBeat = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (!(avgBeat > 0)) return targetSec;
  const measuresInTarget = Math.max(1, Math.round(targetSec / (avgBeat * minBeats)));
  return measuresInTarget * minBeats * avgBeat;
};

// Cherche la coupure de plan détectée la plus proche de "target" (position
// dans LA vidéo source, pas la timeline finale) et la retourne si elle est à
// moins de toleranceSec — sinon null (aucune coupure assez proche, on garde
// la position d'origine plutôt que de sauter loin du point voulu).
const nearestSceneCut = (target, scenes, toleranceSec = 1.5) => {
  if (!Array.isArray(scenes) || scenes.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const t of scenes) {
    const d = Math.abs(t - target);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return bestDist <= toleranceSec ? best : null;
};

// Cherche le temps fort musical (highlightTimes — début des passages "high"
// du structure_json + drops détectés, cf. deriveHighlightTimes dans
// trackPreparation.js) le plus proche de "target" (position dans la
// TIMELINE finale du montage, pas dans une vidéo source) et le retourne si
// à moins de toleranceSec — sinon null. Même logique que nearestSceneCut
// ci-dessus, appliquée ici aux LIMITES de segment plutôt qu'aux positions
// de départ dans les sources.
const nearestHighlight = (target, highlights, toleranceSec = 1.5) => {
  if (!Array.isArray(highlights) || highlights.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const t of highlights) {
    const d = Math.abs(t - target);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return bestDist <= toleranceSec ? best : null;
};

// Accroche les limites de segment INTERNES (ni 0 ni totalSec, qui ne bougent
// jamais) au temps fort musical le plus proche — pour que chaque coupe A/B
// tombe sur une montée d'énergie plutôt qu'à un endroit arbitraire du beat
// grid ("cut on the drop", technique de montage classique). Chaque accroche
// est bornée pour ne jamais créer un segment plus court que MIN_SEGMENT_SEC
// ni inverser l'ordre des bornes — repli silencieux (borne inchangée) sinon.
const snapBoundariesToHighlights = (boundaries, highlightTimes) => {
  if (!Array.isArray(highlightTimes) || highlightTimes.length === 0) return boundaries;
  const snapped = [...boundaries];
  for (let i = 1; i < snapped.length - 1; i++) {
    const candidate = nearestHighlight(snapped[i], highlightTimes);
    if (candidate == null) continue;
    if (candidate <= snapped[i - 1] + MIN_SEGMENT_SEC) continue;
    if (candidate >= snapped[i + 1] - MIN_SEGMENT_SEC) continue;
    snapped[i] = candidate;
  }
  return snapped;
};

// Position dans la vidéo source, à partir du nombre de secondes DÉJÀ
// consommées dans cette source par les segments précédents de ce côté (A ou
// B) — bouclage modulo si la source est plus courte que ce qu'il faudrait
// pour couvrir tout le montage. Avec des segments de durée UNIFORME
// (comportement historique, cf. buildAlternatingFilter), usedSec après N
// occurrences vaut N*segmentSec : cette fonction généralise l'ancienne
// formule (occurrence*segmentSec) sans en changer le résultat dans ce cas —
// nécessaire pour accepter aussi des segments de durée VARIABLE (accroche
// aux temps forts musicaux, cf. snapBoundariesToHighlights).
const sourcePosition = (usedSec, segmentSec, srcDur) => {
  const span = Math.max(srcDur - segmentSec, 1);
  return srcDur > 0 ? usedSec % span : 0;
};

/**
 * Construit un plan de segments alternés A/B calé sur la musique.
 *
 * @param {number} totalSec       durée totale du montage final
 * @param {number} durA           durée de la vidéo source A
 * @param {number} durB           durée de la vidéo source B
 * @param {number[]} beatTimes    grille de beats (secondes) — cf. analyzer.js
 * @param {number[]} scenesA      coupures de plan détectées dans A (detectSceneCuts)
 * @param {number[]} scenesB      coupures de plan détectées dans B
 * @param {number} baseSegmentSec durée de segment "cible" (avant accroche au beat grid)
 * @param {number} xfadeSec       durée du fondu entre segments
 * @param {number} maxSegments    plafond (cf. MAX_SEGMENTS dans ffmpeg.js — même contrainte mémoire libavfilter)
 * @param {number[]} highlightTimes  temps forts musicaux (cf. deriveHighlightTimes dans
 *   trackPreparation.js) — quand fourni, les limites de segment INTERNES sont accrochées
 *   au temps fort le plus proche (±1.5s) plutôt que de rester à intervalle uniforme —
 *   chaque coupe A/B tombe alors sur une montée d'énergie plutôt qu'à un endroit
 *   arbitraire du beat grid. Absent/vide → comportement identique à avant (segments
 *   uniformes), aucune régression possible.
 * @returns {{ plan: Array<{srcIdx:number,start:number,duration:number}>, segmentSec: number, beatSynced: boolean, highlightSynced: boolean }}
 */
export const planMusicSyncedCuts = ({
  totalSec, durA, durB,
  beatTimes = [], scenesA = [], scenesB = [],
  highlightTimes = [],
  baseSegmentSec = 8, xfadeSec = 0.6,
  maxSegments = MAX_SEGMENTS_DEFAULT,
}) => {
  const beatSynced = Array.isArray(beatTimes) && beatTimes.length >= 8;
  const segmentSec = beatSynced ? snapDurationToBeats(baseSegmentSec, beatTimes) : baseSegmentSec;

  let numSegments = Math.max(2, Math.ceil(totalSec / segmentSec));
  let effectiveSegmentSec = segmentSec;
  if (numSegments > maxSegments) {
    numSegments = maxSegments;
    effectiveSegmentSec = totalSec / numSegments;
  }

  // Bornes uniformes de départ (identique à avant), puis accroche des
  // bornes internes aux temps forts musicaux quand disponibles — la borne
  // finale reste toujours exactement totalSec (durée globale inchangée).
  const rawBoundaries = Array.from({ length: numSegments + 1 }, (_, i) => Math.min(i * effectiveSegmentSec, totalSec));
  rawBoundaries[numSegments] = totalSec;
  const boundaries = snapBoundariesToHighlights(rawBoundaries, highlightTimes);
  const highlightSynced = boundaries.some((b, i) => i > 0 && i < boundaries.length - 1 && b !== rawBoundaries[i]);

  const plan = [];
  let usedA = 0, usedB = 0;
  for (let i = 0; i < numSegments; i++) {
    const isA = i % 2 === 0;
    const srcIdx = isA ? 0 : 1;
    const srcDur = isA ? durA : durB;
    const scenes = isA ? scenesA : scenesB;
    const duration = boundaries[i + 1] - boundaries[i];
    const used = isA ? usedA : usedB;

    const rawStart = sourcePosition(used, duration, srcDur);
    const span = Math.max(srcDur - duration, 1);
    const snapped = nearestSceneCut(rawStart, scenes);
    const start = snapped != null ? Math.min(snapped, span) : rawStart;

    plan.push({ srcIdx, start, duration });
    if (isA) usedA += duration; else usedB += duration;
  }

  return { plan, segmentSec: effectiveSegmentSec, beatSynced, highlightSynced };
};

/**
 * Généralisation à N sources vidéo (Phase 5, juillet 2026) — même principe que
 * planMusicSyncedCuts (durée de segment calée sur le beat grid, point de
 * départ accroché à la coupure de plan détectée la plus proche), mais fait
 * tourner les segments en ROUND-ROBIN sur N sources (srcIdx = i % N) au lieu
 * d'alterner strictement entre 2. planMusicSyncedCuts n'a volontairement PAS
 * été modifiée (elle reste le chemin 2-sources, déjà testé en conditions
 * réelles) — cette fonction est additive, réutilise les mêmes helpers privés
 * ci-dessus.
 *
 * @param {number} totalSec         durée totale du montage final
 * @param {number[]} durations      durée de CHAQUE vidéo source, dans l'ordre (longueur = N)
 * @param {number[]} beatTimes      grille de beats (secondes)
 * @param {number[][]} scenesPerSource  coupures de plan détectées PAR source, même ordre que durations
 * @param {number} baseSegmentSec   durée de segment "cible"
 * @param {number} xfadeSec         durée du fondu entre segments
 * @param {number} maxSegments      plafond (cf. MAX_SEGMENTS dans ffmpeg.js)
 * @param {number[]} highlightTimes temps forts musicaux — cf. planMusicSyncedCuts, même
 *   comportement d'accroche des bornes internes, absent/vide → aucun changement.
 * @returns {{ plan: Array<{srcIdx:number,start:number,duration:number}>, segmentSec: number, beatSynced: boolean, highlightSynced: boolean }}
 */
export const planMultiSourceCuts = ({
  totalSec, durations = [],
  beatTimes = [], scenesPerSource = [],
  highlightTimes = [],
  baseSegmentSec = 8, xfadeSec = 0.6,
  maxSegments = MAX_SEGMENTS_DEFAULT,
}) => {
  const n = durations.length;
  if (n === 0) throw new Error("planMultiSourceCuts : au moins une source vidéo requise (durations vide)");

  const beatSynced = Array.isArray(beatTimes) && beatTimes.length >= 8;
  const segmentSec = beatSynced ? snapDurationToBeats(baseSegmentSec, beatTimes) : baseSegmentSec;

  let numSegments = Math.max(n, Math.ceil(totalSec / segmentSec));
  let effectiveSegmentSec = segmentSec;
  if (numSegments > maxSegments) {
    numSegments = Math.max(n, maxSegments);
    effectiveSegmentSec = totalSec / numSegments;
  }

  const rawBoundaries = Array.from({ length: numSegments + 1 }, (_, i) => Math.min(i * effectiveSegmentSec, totalSec));
  rawBoundaries[numSegments] = totalSec;
  const boundaries = snapBoundariesToHighlights(rawBoundaries, highlightTimes);
  const highlightSynced = boundaries.some((b, i) => i > 0 && i < boundaries.length - 1 && b !== rawBoundaries[i]);

  const plan = [];
  const usedPerSource = new Array(n).fill(0);
  for (let i = 0; i < numSegments; i++) {
    const srcIdx = i % n;
    const srcDur = durations[srcIdx];
    const scenes = scenesPerSource[srcIdx] || [];
    const duration = boundaries[i + 1] - boundaries[i];
    const used = usedPerSource[srcIdx];

    const rawStart = sourcePosition(used, duration, srcDur);
    const span = Math.max(srcDur - duration, 1);
    const snapped = nearestSceneCut(rawStart, scenes);
    const start = snapped != null ? Math.min(snapped, span) : rawStart;

    plan.push({ srcIdx, start, duration });
    usedPerSource[srcIdx] += duration;
  }

  return { plan, segmentSec: effectiveSegmentSec, beatSynced, highlightSynced };
};
