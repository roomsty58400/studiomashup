// ─── Comparaison floue titre/artiste (DJPLAYLIST) ──────────────────────────
// Compare une piste d'une playlist importée (titre/artiste souvent écrits
// un peu différemment d'une source à l'autre) à la bibliothèque locale
// scannée, pour décider si elle est "déjà là" ou "manquante". Similarité de
// Sørensen-Dice sur bigrammes de caractères — simple, sans dépendance, et
// tolérant aux petites variations (majuscules, accents, "feat.", ponctuation).

const NOISE_WORDS = /\b(feat|ft|featuring|remix|edit|version|radio|extended|official|video|audio|hd|hq|lyrics|clip|explicit|remaster(ed)?)\b/gi;

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalize(str) {
  if (!str) return "";
  let s = stripDiacritics(String(str)).toLowerCase();
  s = s.replace(/[()[\]{}]/g, " ");
  s = s.replace(NOISE_WORDS, " ");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function bigrams(s) {
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

// Coefficient de Sørensen-Dice : 2*|intersection| / (|A|+|B|), 0..1.
export function diceCoefficient(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na), gb = bigrams(nb);
  if (ga.length === 0 || gb.length === 0) return na === nb ? 1 : 0;
  const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let intersection = 0;
  for (const g of gb) {
    const c = counts.get(g) || 0;
    if (c > 0) { intersection++; counts.set(g, c - 1); }
  }
  return (2 * intersection) / (ga.length + gb.length);
}

// Score combiné titre (poids dominant) + artiste (si connu des 2 côtés).
export function matchScore(ref, candidate) {
  const titleScore = diceCoefficient(ref.title, candidate.title);
  if (ref.artist && candidate.artist) {
    const artistScore = diceCoefficient(ref.artist, candidate.artist);
    return titleScore * 0.65 + artistScore * 0.35;
  }
  return titleScore;
}

// Si les tags sont absents/incomplets, tente "Artiste - Titre" à partir du
// nom de fichier lui-même (convention très répandue) plutôt que de laisser
// le nom de fichier ENTIER (avec l'artiste dedans) polluer la comparaison
// de titre — sans ça, "Coldplay - Yellow.mp3" ne matchait jamais "Yellow".
function candidateFromEntry(entry) {
  if (entry.tags?.title) return { title: entry.tags.title, artist: entry.tags?.artist || null };
  const base = (entry.name || "").replace(/\.[a-z0-9]+$/i, "");
  const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (m) return { title: m[2].trim(), artist: m[1].trim() };
  return { title: base, artist: null };
}

// Cherche la meilleure correspondance d'une piste de référence dans la
// bibliothèque locale scannée (liste d'objets { relPath, name, tags }).
// Retourne { entry, score } ou null si rien ne dépasse le seuil.
//
// Essaie aussi l'ordre "Titre - Artiste" en plus de "Artiste - Titre" pour
// CETTE piste de référence : les imports TXT/PDF n'ont pas de format fixé
// (cf. playlistParse.js) et l'ordre exact ne peut pas être deviné avec
// certitude à la lecture d'une seule ligne — plutôt que de rater le match
// à cause d'un ordre inversé, on tente les 2 et on garde le meilleur score.
export function findBestMatch(ref, libraryEntries, threshold = 0.55) {
  const swapped = ref.artist ? { title: ref.artist, artist: ref.title } : null;
  let best = null, bestScore = 0;
  for (const entry of libraryEntries) {
    const candidate = candidateFromEntry(entry);
    const score = Math.max(
      matchScore(ref, candidate),
      swapped ? matchScore(swapped, candidate) : 0
    );
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore >= threshold ? { entry: best, score: bestScore } : null;
}
