// ── Moteur de scoring de compatibilité entre 2 morceaux ──────────────────
//
// Calcule en pur JS (pas de subprocess Python) un score /100 à partir des
// features déjà extraites par services/analyzer.js et stockées en SQLite
// (db/index.js) : BPM, clé/mode/Camelot, énergie (RMS), structure (sections
// énergie), empreinte spectrale (MFCC). Aucun traitement de signal ici — ce
// module ne fait que comparer des nombres déjà calculés, donc le score entre
// 2 morceaux déjà analysés est instantané (0ms, pas de GPU/CPU sollicité).
//
// Pondération du score global (cahier des charges) :
//   BPM        20%
//   Clé        20%
//   Énergie    20%
//   Structure  25%
//   Spectral   15%
//
// ── Verrou anti-décrochage vocal ("gatekeeper") ──
// Distinct du sous-score Clé (qui évalue la compatibilité harmonique au sens
// large, façon roue de Camelot) : ce verrou calcule le pitch-shift RÉEL (en
// demi-tons) qu'il faudrait appliquer à la voix du morceau A pour l'accorder
// sur la tonalité du morceau B. Au-delà de ±1 demi-ton, la voix commence à
// sonner artificiellement (timbre dénaturé) — le mashup est alors invalidé
// (score global forcé à 0), quels que soient les autres sous-scores.

const PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const clamp = (v, min = 0, max = 100) => Math.min(max, Math.max(min, v));

// ── BPM (20%) ──
// Tolère l'équivalence "double/moitié tempo" (90 BPM se mixe avec du 180 BPM
// en jouant l'un à double vitesse) — pratique standard en DJing. Au-delà de
// ~8% d'écart relatif (tolérance typique d'un pitch fader CDJ/vinyle), le
// score tombe à 0.
const TEMPO_TOLERANCE = 0.08;
export function scoreBpm(bpmA, bpmB) {
  if (!bpmA || !bpmB) return 0;
  const relDiff = (a, b) => Math.abs(a - b) / Math.max(a, b);
  const best = Math.min(
    relDiff(bpmA, bpmB),
    relDiff(bpmA, bpmB * 2),
    relDiff(bpmA * 2, bpmB),
  );
  return clamp(100 * (1 - best / TEMPO_TOLERANCE));
}

// ── Distance sur la roue de Camelot ──
// 0 = code identique (match parfait)
// 1 = relative majeur/mineur (même numéro, lettre différente) OU numéro
//     adjacent même lettre (quinte — mix harmonique "smooth" standard)
// 2 = numéro adjacent + lettre différente, ou 2 pas sur la roue
// 3+ = de moins en moins compatible
function parseCamelot(code) {
  const m = /^(\d{1,2})([AB])$/.exec((code || "").toUpperCase());
  if (!m) return null;
  return { number: parseInt(m[1], 10), letter: m[2] };
}

export function camelotDistance(codeA, codeB) {
  const a = parseCamelot(codeA);
  const b = parseCamelot(codeB);
  if (!a || !b) return 6; // inconnu → traité comme peu compatible, pas comme "parfait"
  if (a.number === b.number && a.letter === b.letter) return 0;
  const rawDiff = Math.abs(a.number - b.number);
  const numberDist = Math.min(rawDiff, 12 - rawDiff); // roue circulaire (1..12)
  const letterPenalty = a.letter === b.letter ? 0 : 1;
  return numberDist + letterPenalty;
}

// ── Clé / Camelot (20%) ──
export function scoreKey(camelotA, camelotB) {
  const dist = camelotDistance(camelotA, camelotB);
  return clamp(100 - dist * 25);
}

// ── Pitch-shift réel requis (demi-tons signés, -6..+6) pour accorder la
// tonique du morceau A sur celle du morceau B. Indépendant du mode
// (majeur/mineur) : un pitch-shift audio translate toutes les fréquences
// uniformément, peu importe le mode — le mode influence la compatibilité
// HARMONIQUE (déjà capturée par scoreKey/camelotDistance), pas la distance
// de fréquence à parcourir.
export function semitoneShift(keyPitchA, keyPitchB) {
  const ia = PITCHES.indexOf(keyPitchA);
  const ib = PITCHES.indexOf(keyPitchB);
  if (ia === -1 || ib === -1) return null;
  let diff = (ib - ia + 12) % 12;
  if (diff > 6) diff -= 12; // chemin le plus court (signé)
  return diff;
}

// ── Énergie / RMS (20%) ──
export function scoreEnergy(trackA, trackB) {
  const relDiff = (a, b) => {
    const denom = Math.max(a, b, 1e-6);
    return Math.abs(a - b) / denom;
  };
  const rmsDiff = relDiff(trackA.energy_rms || 0, trackB.energy_rms || 0);
  const stdDiff = relDiff(trackA.energy_std || 0, trackB.energy_std || 0);
  return clamp(100 * (1 - 0.5 * rmsDiff - 0.5 * stdDiff));
}

// ── Structure (25%) ──
// Compare la PROPORTION de durée passée dans chaque palier d'énergie
// ("low"/"mid"/"high", cf. analyzer.js) entre les 2 morceaux — un proxy
// simple de "forme" du morceau (calme/dense/intense), sans dépendre d'un
// alignement temporel précis (les 2 morceaux n'ont presque jamais la même
// durée). C'est une approximation : une vraie comparaison structurelle
// intro/couplet/refrain demanderait un modèle sémantique dédié.
function structureProfile(structure) {
  const profile = { low: 0, mid: 0, high: 0 };
  let total = 0;
  for (const seg of structure || []) {
    const dur = Math.max(0, (seg.end ?? 0) - (seg.start ?? 0));
    profile[seg.label] = (profile[seg.label] || 0) + dur;
    total += dur;
  }
  if (total <= 0) return null;
  return { low: profile.low / total, mid: profile.mid / total, high: profile.high / total };
}

export function scoreStructure(structureA, structureB) {
  const pa = structureProfile(structureA);
  const pb = structureProfile(structureB);
  if (!pa || !pb) return 50; // pas de structure exploitable (morceau trop court...) : neutre, ni bonus ni pénalité
  const l1 = Math.abs(pa.low - pb.low) + Math.abs(pa.mid - pb.mid) + Math.abs(pa.high - pb.high);
  return clamp(100 * (1 - l1 / 2)); // l1 ∈ [0,2] sur des distributions normalisées à 1
}

// ── Similarité spectrale (15%) ──
// Cosinus entre les vecteurs MFCC moyens (timbre global du morceau).
export function scoreSpectral(mfccA, mfccB) {
  if (!Array.isArray(mfccA) || !Array.isArray(mfccB) || mfccA.length === 0 || mfccA.length !== mfccB.length) return 50;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < mfccA.length; i++) {
    dot += mfccA[i] * mfccB[i];
    normA += mfccA[i] * mfccA[i];
    normB += mfccB[i] * mfccB[i];
  }
  if (normA === 0 || normB === 0) return 50;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return clamp(((cosine + 1) / 2) * 100);
}

const WEIGHTS = { bpm: 0.20, key: 0.20, energy: 0.20, structure: 0.25, spectral: 0.15 };

// ── Score global ──
// trackA / trackB : lignes telles que stockées en SQLite (cf. db/schema.sql)
// — structure_json/mfcc_json peuvent être passés déjà parsés (array) ou
// encore en JSON string (le format brut tel que lu depuis la DB) ; les deux
// sont acceptés pour éviter d'imposer un parsing en amont à chaque appelant.
const parseMaybeJson = (v) => {
  if (Array.isArray(v) || v == null) return v;
  try { return JSON.parse(v); } catch { return null; }
};

export function computeCompatibility(trackA, trackB) {
  const structureA = parseMaybeJson(trackA.structure_json ?? trackA.structure);
  const structureB = parseMaybeJson(trackB.structure_json ?? trackB.structure);
  const mfccA = parseMaybeJson(trackA.mfcc_json ?? trackA.mfcc_mean);
  const mfccB = parseMaybeJson(trackB.mfcc_json ?? trackB.mfcc_mean);

  const shift = semitoneShift(trackA.key_pitch, trackB.key_pitch);
  const gated = shift !== null && Math.abs(shift) > 1;

  const sub = {
    bpm: scoreBpm(trackA.bpm, trackB.bpm),
    key: gated ? 0 : scoreKey(trackA.camelot, trackB.camelot),
    energy: scoreEnergy(trackA, trackB),
    structure: scoreStructure(structureA, structureB),
    spectral: scoreSpectral(mfccA, mfccB),
  };

  const global = gated
    ? 0
    : Math.round(
        sub.bpm * WEIGHTS.bpm +
        sub.key * WEIGHTS.key +
        sub.energy * WEIGHTS.energy +
        sub.structure * WEIGHTS.structure +
        sub.spectral * WEIGHTS.spectral
      );

  return {
    score: global,
    subscores: {
      bpm: Math.round(sub.bpm),
      key: Math.round(sub.key),
      energy: Math.round(sub.energy),
      structure: Math.round(sub.structure),
      spectral: Math.round(sub.spectral),
    },
    weights: WEIGHTS,
    pitchShiftSemitones: shift,
    vocalLockEngaged: gated,
    invalidReason: gated
      ? `Décrochage vocal : ${shift > 0 ? "+" : ""}${shift} demi-ton(s) requis pour accorder la voix de A sur B (max ±1 autorisé).`
      : null,
  };
}
