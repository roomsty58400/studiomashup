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

// ── Helpers "tracks" ──
// Cache permanent des analyses (BPM/clé/énergie/structure/spectral) + chemins
// des stems Demucs 4 pistes, indexé par videoId YouTube ou hash de fichier.
// Évite de ré-analyser/re-séparer un morceau déjà traité (Demucs = l'étape la
// plus lente du pipeline, souvent plusieurs minutes).

export const getTrack = (id) => db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);

export const hasTrack = (id) => !!getTrack(id);

// "track" doit contenir TOUTES les colonnes de la table (id inclus) — c'est
// l'appelant (routes/analyze.js) qui construit la ligne complète avant
// d'appeler upsertTrack, pour garder ce helper simple et sans valeurs
// implicites surprenantes.
const TRACK_COLUMNS = [
  "id", "source", "title", "duration",
  "bpm", "key_pitch", "key_mode", "camelot",
  "energy_rms", "energy_std", "spectral_centroid", "mfcc_json", "structure_json",
  "vocals_path", "drums_path", "bass_path", "other_path",
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
