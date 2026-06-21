-- MacheUp AI Engine — métadonnées musicales locales (SQLite)
--
-- Une seule table "tracks" : un morceau analysé une fois (par videoId YouTube
-- ou par hash de fichier local) n'est plus jamais ré-analysé ni re-séparé
-- (Demucs 4 stems) tant que la ligne existe — gain de temps énorme, Demucs
-- étant de loin l'étape la plus lente du pipeline (souvent 1-5 min/morceau).
--
-- "id" = videoId YouTube (ex: "dQw4w9WgXcQ") ou hash du fichier uploadé —
-- clé naturelle, pas d'auto-increment nécessaire pour un cache de ce type.
CREATE TABLE IF NOT EXISTS tracks (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,           -- 'youtube' | 'file'
  title            TEXT,
  duration         REAL,                    -- secondes

  -- Analyse musicale (services/analyzer.js)
  bpm              REAL,
  key_pitch        TEXT,                    -- 'C', 'C#', 'D', ...
  key_mode         TEXT,                    -- 'major' | 'minor'
  camelot          TEXT,                    -- ex: '8B' (notation roue de Camelot)
  energy_rms       REAL,                    -- RMS moyen (0-1)
  energy_std       REAL,                    -- écart-type RMS (dynamique du morceau)
  spectral_centroid REAL,                   -- timbre moyen (Hz)
  mfcc_json        TEXT,                    -- vecteur MFCC moyen (JSON array) — empreinte spectrale pour la similarité
  structure_json   TEXT,                    -- sections détectées (JSON array de {start,end,energy,label})

  -- Stems Demucs 4 pistes (services/demucs.js → separateStemsFull)
  vocals_path      TEXT,
  drums_path       TEXT,
  bass_path        TEXT,
  other_path       TEXT,

  analyzed_at      INTEGER NOT NULL          -- epoch ms
);
