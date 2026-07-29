// ── Helpers partagés "préparation de piste" (Phase 5, juillet 2026) ────────
// Extraits TELS QUELS (aucune logique modifiée) de routes/mashup.js, où ils
// vivaient comme closures locales du handler POST "/" — nécessaire pour être
// réutilisés par routes/mashupMulti.js (nouveau, mashup à N pistes) sans dupli-
// quer ~150 lignes de logique de scoring/alignement délicate.
//
// Extraction volontairement LIMITÉE à des fonctions PURES (aucune dépendance
// à jobId/tmpDir/mode ni à aucun état de requête) — prepareTrack lui-même
// (le gros morceau : cache Demucs/Librosa, téléchargement, dé-reverb...) N'A
// PAS été extrait ni modifié : trop risqué de toucher au chemin le plus
// utilisé de toute l'app pour un premier jet "backend d'abord". La nouvelle
// route N-pistes (mashupMulti.js) a donc son propre chemin de préparation,
// plus simple, qui exige que les pistes soient DÉJÀ analysées (cf. commentaire
// détaillé en tête de ce fichier-là) plutôt que de reproduire tout le chemin
// "à froid" (téléchargement + Demucs + dé-reverb) de prepareTrack.
import { join, sep } from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { STEM_MODE_NAMES } from "./demucs.js";
import { scoreKey } from "./scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// services/ est au même niveau que routes/ (backend/services/, backend/routes/)
// — donc le même "../data/outputs" relatif que dans routes/mashup.js pointe
// bien vers backend/data/outputs dans les deux cas.
const outputsDir = join(__dirname, "../data/outputs");

// Résout une URL "/outputs/..." (racine OU sous-dossier, ex: /outputs/stems/<jobId>/vocals.flac)
// en chemin absolu sur le disque, avec vérification anti-traversée de chemin.
export const resolveOutputPath = (url) => {
  if (!url || typeof url !== "string") return null;
  const rel = url.replace(/^\/outputs\//, "");
  const filePath = join(outputsDir, rel);
  // Vérification anti-traversée durcie (audit juillet 2026) : un simple
  // startsWith(outputsDir) sans séparateur de fin laisserait passer un
  // dossier VOISIN dont le nom commence par le même préfixe (ex: si
  // outputsDir = ".../data/outputs" et qu'un dossier ".../data/outputs-evil"
  // existait un jour, filePath.startsWith(outputsDir) serait vrai à tort).
  // On exige soit une égalité stricte, soit que filePath commence par
  // outputsDir + le séparateur de chemin.
  if (filePath !== outputsDir && !filePath.startsWith(outputsDir + sep)) return null;
  return filePath;
};

// ── Sélecteur 2/4 stems ──────────────────────────────────────────────────
// Normalise n'importe quelle valeur reçue (nombre, string, undefined) vers
// 2 ou 4 — défaut 4 (mode "standard"). Le mode 6 a été retiré (juillet 2026).
export const normalizeStemMode = (m) => ([2, 4].includes(Number(m)) ? Number(m) : 4);

// Noms des stems NON-vocaux pour un mode donné (ex: mode 4 →
// ["drums","bass","other"]), null pour le mode "2" (pas de stems
// individuels — voix + instrumental complet seulement, rien "à la carte" à
// ce niveau).
export const nonVocalPartsForMode = (mode) => {
  const m = normalizeStemMode(mode);
  return m === 2 ? null : STEM_MODE_NAMES[m].filter(n => n !== "vocals");
};

export const parseBeatTimes = (raw) => { try { return JSON.parse(raw || "[]"); } catch { return []; } };
export const parseStructure = (raw) => {
  try { return typeof raw === "string" ? JSON.parse(raw) : (raw || []); } catch { return []; }
};
// drops_json : liste de timestamps (montées d'énergie brutales, cf.
// detect_drops dans services/analyzer.js) — même format de stockage
// (JSON stringifié en SQLite) que structure_json, même tolérance de parsing
// (accepte aussi bien une chaîne brute qu'un tableau déjà parsé).
export const parseDrops = (raw) => {
  try { return typeof raw === "string" ? JSON.parse(raw) : (raw || []); } catch { return []; }
};

// Dérive la liste des "temps forts" musicaux (Phase 6, juillet 2026) sur
// lesquels caler les coupes du montage vidéo (cf. videoCutPlanner.js /
// highlightTimes) : le début de chaque passage "high" du structure_json
// (montée d'énergie soutenue) + chaque drop détecté (montée d'énergie
// brutale). Les deux signaux sont complémentaires — un morceau peut avoir
// des drops sans "plateau" haute énergie assez long pour ressortir comme
// segment structurel, ou l'inverse. Dédoublonné (tolérance 1s) et trié.
export const deriveHighlightTimes = (structureRaw, dropsRaw) => {
  const structure = parseStructure(structureRaw);
  const drops = parseDrops(dropsRaw);
  const fromStructure = structure.filter(s => s && s.label === "high" && Number.isFinite(s.start)).map(s => s.start);
  const fromDrops = drops.filter(t => Number.isFinite(t));
  const raw = [...fromStructure, ...fromDrops].sort((a, b) => a - b);
  const out = [];
  for (const t of raw) {
    if (out.length === 0 || t - out[out.length - 1] > 1) out.push(t);
  }
  return out;
};

// Cherche le premier segment "high" dans structure_json (déjà calculé par
// analyzer.js et stocké en SQLite) pour sauter les intros molles et partir
// directement sur la partie la plus énergique du morceau.
export const findHighEnergyOffset = (structureRaw) => {
  try {
    const structure = typeof structureRaw === "string" ? JSON.parse(structureRaw) : (structureRaw || []);
    const highSeg = structure.find(s => s.label === "high");
    return highSeg ? highSeg.start : 0;
  } catch { return 0; }
};

// Cale `offset` sur la limite de mesure (4 temps) la plus proche — version
// "grille réelle" (beat_times complet) avec repli arithmétique si la grille
// est absente ou trop clairsemée. Cf. routes/mashup.js pour l'historique
// détaillé de cette fonction (identique ici, non modifiée).
export const snapToMeasureBoundary = (offset, beatTimes, bpm) => {
  if (!beatTimes || beatTimes.length < 8) {
    if (!bpm || bpm <= 0 || !beatTimes || beatTimes.length === 0) return offset;
    const beatPeriod = 60 / bpm;
    const measureDuration = 4 * beatPeriod;
    const firstBeat = beatTimes[0];
    const measurePhase = ((offset - firstBeat) % measureDuration + measureDuration) % measureDuration;
    if (measurePhase < 0.04) return offset;
    const toNext = measureDuration - measurePhase;
    const toPrev = measurePhase;
    const snapped = (toNext <= toPrev + 0.1) ? offset + toNext : offset - toPrev;
    return Math.max(0, snapped);
  }
  let idx = beatTimes.findIndex(t => t >= offset);
  if (idx === -1) idx = beatTimes.length - 1;
  if (idx > 0 && Math.abs(beatTimes[idx - 1] - offset) < Math.abs(beatTimes[idx] - offset)) idx -= 1;
  const phase = idx % 4;
  if (phase === 0) return beatTimes[idx];
  const prevDownbeatIdx = idx - phase;
  const nextDownbeatIdx = Math.min(beatTimes.length - 1, idx + (4 - phase));
  const toPrev = offset - beatTimes[prevDownbeatIdx];
  const toNext = beatTimes[nextDownbeatIdx] - offset;
  return toNext <= toPrev + 0.1 ? beatTimes[nextDownbeatIdx] : Math.max(0, beatTimes[prevDownbeatIdx]);
};

// ── Matrice de "mashability" façon AutoMashUpper (Davies, Hamel, Yoshii &
// Goto, ISMIR/IEEE 2013-2014) ────────────────────────────────────────────
// Évalue toutes les combinaisons (segment de A) × (segment de B) et retient
// la paire dont la compatibilité harmonique + énergétique + de durée est la
// meilleure. Cf. routes/mashup.js pour l'historique détaillé (identique ici,
// non modifiée).
const MIN_SEGMENT_DURATION = 6;
const MIN_REMAINING_AFTER_START = 45;
const SEGMENT_KEY_CONFIDENCE_MIN = 0.35;
const ENERGY_RANK = { low: 0, mid: 1, high: 2 };

export const pickBestSegmentPair = (structureA, structureB) => {
  const durationA = (structureA && structureA.length) ? Math.max(...structureA.map(s => s.end)) : Infinity;
  const durationB = (structureB && structureB.length) ? Math.max(...structureB.map(s => s.end)) : Infinity;

  const segsA = (structureA || []).filter(s =>
    (s.end - s.start) >= MIN_SEGMENT_DURATION && (durationA - s.start) >= MIN_REMAINING_AFTER_START);
  const segsB = (structureB || []).filter(s =>
    (s.end - s.start) >= MIN_SEGMENT_DURATION && (durationB - s.start) >= MIN_REMAINING_AFTER_START);

  if (segsA.length === 0 || segsB.length === 0) {
    return {
      offsetA: 0, offsetB: 0,
      harmonicScore: 50, energyScore: 50, durationScore: 50,
      reason: "aucun segment ne laisse assez de piste après son point de départ — repli sur le tout début des 2 morceaux",
    };
  }

  let best = null;
  for (const a of segsA) {
    for (const b of segsB) {
      const aReliable = (a.key_confidence ?? 0) >= SEGMENT_KEY_CONFIDENCE_MIN && a.camelot;
      const bReliable = (b.key_confidence ?? 0) >= SEGMENT_KEY_CONFIDENCE_MIN && b.camelot;
      const harmonicScore = (aReliable && bReliable) ? scoreKey(a.camelot, b.camelot) : 50;

      const energyGap = Math.abs((ENERGY_RANK[a.label] ?? 1) - (ENERGY_RANK[b.label] ?? 1));
      const energyScore = 100 - energyGap * 40;

      const durA = a.end - a.start, durB = b.end - b.start;
      const durationScore = 100 * (Math.min(durA, durB) / Math.max(durA, durB));

      const energyBonus = (a.label === "high" ? 5 : 0) + (b.label === "high" ? 5 : 0);

      const score = harmonicScore * 0.4 + energyScore * 0.35 + durationScore * 0.25 + energyBonus;
      if (!best || score > best.score) {
        best = { score, harmonicScore, energyScore, durationScore, offsetA: a.start, offsetB: b.start, a, b };
      }
    }
  }

  return {
    offsetA: best.offsetA, offsetB: best.offsetB,
    harmonicScore: best.harmonicScore, energyScore: best.energyScore, durationScore: best.durationScore,
    reason: `meilleure paire : A[${best.a.start.toFixed(1)}-${best.a.end.toFixed(1)}s/${best.a.label}${best.a.camelot ? "/" + best.a.camelot : ""}] × B[${best.b.start.toFixed(1)}-${best.b.end.toFixed(1)}s/${best.b.label}${best.b.camelot ? "/" + best.b.camelot : ""}] (score ${best.score.toFixed(0)}/100, harmonie ${best.harmonicScore.toFixed(0)}, énergie ${best.energyScore.toFixed(0)}, durée ${best.durationScore.toFixed(0)})`,
  };
};
