// SQLite via le module NATIF de Node ("node:sqlite") plutôt que le paquet
// npm "better-sqlite3" : ce dernier nécessite une compilation native (gyp/
// MSBuild) qui échoue facilement sur Windows si aucun binaire précompilé
// n'existe pour la version de Node installée (cas rencontré : Node 26, trop
// récent pour les binaires prêts à l'emploi de better-sqlite3 à ce jour).
// "node:sqlite" est intégré directement à Node (v22.5+) — aucune dépendance
// à installer, donc aucun risque de ce type d'échec.
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../data");
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = join(DB_DIR, "macheup.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;"); // écritures concurrentes sans bloquer les lectures

db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));

// ── Migration : ajout de colonnes au fil des versions ──
// ALTER TABLE ADD COLUMN est idempotent en SQLite (pas de IF NOT EXISTS natif,
// mais on vérifie via PRAGMA table_info avant d'exécuter).
const existingCols = new Set(db.prepare("PRAGMA table_info(tracks)").all().map(r => r.name));
if (!existingCols.has("beat_times_json")) {
  db.exec("ALTER TABLE tracks ADD COLUMN beat_times_json TEXT");
}
if (!existingCols.has("key_confidence")) {
  db.exec("ALTER TABLE tracks ADD COLUMN key_confidence REAL");
}
// Sélecteur 2/4/6 stems (juillet 2026, cf. services/demucs.js) : stem_mode
// mémorise le mode utilisé pour LA DERNIÈRE séparation de ce morceau (une
// seule version des stems conservée par morceau, pas une par mode — cf.
// routes/analyze.js, qui force une ré-analyse si le mode demandé diffère).
if (!existingCols.has("stem_mode")) {
  db.exec("ALTER TABLE tracks ADD COLUMN stem_mode TEXT DEFAULT '4'");
}
if (!existingCols.has("instrumental_path")) {
  db.exec("ALTER TABLE tracks ADD COLUMN instrumental_path TEXT");
}
if (!existingCols.has("guitar_path")) {
  db.exec("ALTER TABLE tracks ADD COLUMN guitar_path TEXT");
}
if (!existingCols.has("piano_path")) {
  db.exec("ALTER TABLE tracks ADD COLUMN piano_path TEXT");
}
// Phase 2 (juillet 2026, cf. services/analyzer.js) : kick/snare (onsets par
// bande de fréquence) + drops (montées d'énergie brutales).
if (!existingCols.has("kick_times_json")) {
  db.exec("ALTER TABLE tracks ADD COLUMN kick_times_json TEXT");
}
if (!existingCols.has("snare_times_json")) {
  db.exec("ALTER TABLE tracks ADD COLUMN snare_times_json TEXT");
}
if (!existingCols.has("drops_json")) {
  db.exec("ALTER TABLE tracks ADD COLUMN drops_json TEXT");
}

// ── Purge du cache empoisonné par l'ancien repli silencieux d'analyzer.js ──
// Avant le correctif du 2026-07-03, un échec de l'analyse Librosa (dépendance
// manquante, timeout...) renvoyait des valeurs PLAUSIBLES (bpm=120,
// key_pitch='C', key_mode='major', camelot='8B') au lieu de faire échouer le
// job — et ce résultat inventé était mis en cache SQLite comme un vrai
// résultat. Constaté en pratique : la quasi-totalité des morceaux de la base
// portaient exactement cette signature. Sans cette purge, ces lignes
// continueraient à être servies indéfiniment comme "déjà analysées" (cf.
// routes/analyze.js, routes/mashup.js), bloquant chaque mashup sur un faux
// 120 BPM même après avoir corrigé la cause racine.
//
// On réinitialise UNIQUEMENT les champs d'analyse (bpm/clé/énergie/structure)
// pour forcer une VRAIE ré-analyse au prochain besoin — les stems Demucs
// déjà séparés (vocals_path etc.) sont volontairement conservés : ils ne
// dépendent pas de Librosa et restent valides, pas la peine de refaire
// tourner Demucs (l'étape la plus lente) pour ça.
//
// Signature très spécifique (bpm/clé/mode/camelot EXACTS + confiance nulle
// ou absente) : la probabilité qu'un vrai morceau tombe pile sur ces 4
// valeurs à la fois est negligeable, donc aucun risque de purger une analyse
// authentique. Idempotent : après la 1ère purge, ces lignes ont bpm=NULL et
// ne matchent plus la condition — ce bloc redevient un no-op aux démarrages
// suivants, pas besoin de le gater davantage.
const poisoned = db.prepare(`
  SELECT COUNT(*) AS n FROM tracks
  WHERE bpm = 120 AND key_pitch = 'C' AND key_mode = 'major' AND camelot = '8B'
    AND (key_confidence IS NULL OR key_confidence = 0)
`).get();
if (poisoned.n > 0) {
  db.exec(`
    UPDATE tracks
    SET bpm = NULL, key_pitch = NULL, key_mode = NULL, key_confidence = NULL, camelot = NULL,
        energy_rms = NULL, energy_std = NULL, spectral_centroid = NULL,
        mfcc_json = NULL, structure_json = NULL, beat_times_json = NULL
    WHERE bpm = 120 AND key_pitch = 'C' AND key_mode = 'major' AND camelot = '8B'
      AND (key_confidence IS NULL OR key_confidence = 0)
  `);
  console.warn(`⚠️  [db] ${poisoned.n} morceau(x) avaient un faux résultat d'analyse (bpm=120/camelot=8B, cf. ancien bug d'analyzer.js) — analyse réinitialisée, une vraie ré-analyse se déclenchera au prochain besoin (stems Demucs conservés).`);
}

// ── Helpers "tracks" ──
// Cache permanent des analyses (BPM/clé/énergie/structure/spectral) + chemins
// des stems Demucs 4 pistes, indexé par videoId YouTube ou hash de fichier.
// Évite de ré-analyser/re-séparer un morceau déjà traité (Demucs = l'étape la
// plus lente du pipeline, souvent plusieurs minutes).

export const getTrack = (id) => db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);

export const hasTrack = (id) => !!getTrack(id);

// ── Liste des morceaux déjà analysés (pour Mashup Wheel) ──
// bpm IS NOT NULL : exclut les lignes jamais abouties (ou purgées, cf. la
// purge du cache empoisonné plus haut) — mêmes garde-fous que getTrack/cached
// dans routes/analyze.js. Limité à 300 lignes les plus récentes : largement
// suffisant comme bassin de candidats et évite de charger toute une base qui
// grossira avec l'usage (mfcc_json/structure_json peuvent être volumineux).
export const listAnalyzedTracks = (excludeId) =>
  db.prepare("SELECT * FROM tracks WHERE bpm IS NOT NULL AND id != ? ORDER BY analyzed_at DESC LIMIT 300").all(excludeId || "");

// "track" doit contenir TOUTES les colonnes de la table (id inclus) — c'est
// l'appelant (routes/analyze.js) qui construit la ligne complète avant
// d'appeler upsertTrack, pour garder ce helper simple et sans valeurs
// implicites surprenantes.
const TRACK_COLUMNS = [
  "id", "source", "title", "duration",
  "bpm", "key_pitch", "key_mode", "key_confidence", "camelot",
  "energy_rms", "energy_std", "spectral_centroid", "mfcc_json", "structure_json", "beat_times_json",
  "kick_times_json", "snare_times_json", "drops_json",
  "stem_mode", "vocals_path", "instrumental_path", "drums_path", "bass_path", "guitar_path", "piano_path", "other_path",
  "analyzed_at",
];

export const upsertTrack = (track) => {
  const row = {};
  for (const col of TRACK_COLUMNS) row[col] = track[col] ?? null;

  const placeholders = TRACK_COLUMNS.map(c => `@${c}`).join(", ");
  const updates = TRACK_COLUMNS.filter(c => c !== "id").map(c => `${c} = @${c}`).join(", ");

  db.prepare(`
    INSERT INTO tracks (${TRACK_COLUMNS.join(", ")}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updates}
  `).run(row);

  return getTrack(track.id);
};

export default db;
