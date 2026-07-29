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
  key_confidence   REAL,                    -- corrélation du profil gagnant (Krumhansl-Schmuckler), 0-1 : fiabilité de key_pitch/key_mode/camelot
  camelot          TEXT,                    -- ex: '8B' (notation roue de Camelot)
  energy_rms       REAL,                    -- RMS moyen (0-1)
  energy_std       REAL,                    -- écart-type RMS (dynamique du morceau)
  spectral_centroid REAL,                   -- timbre moyen (Hz)
  mfcc_json        TEXT,                    -- vecteur MFCC moyen (JSON array) — empreinte spectrale pour la similarité
  structure_json   TEXT,                    -- sections détectées (JSON array de {start,end,energy,label})
  beat_times_json  TEXT,                    -- positions des 1ers beats < 12s (JSON array de float, secondes) — alignement de mesure
  kick_times_json  TEXT,                    -- Phase 2 (juillet 2026) : onsets détectés dans la bande ~20-150Hz (JSON array de float, secondes)
  snare_times_json TEXT,                    -- Phase 2 : onsets détectés dans la bande ~150Hz-6kHz (caisse claire/hi-hat, JSON array de float, secondes)
  drops_json       TEXT,                    -- Phase 2 : instants de montée d'énergie brutale détectés (JSON array de float, secondes)

  -- Stems Demucs (services/demucs.js → separateStemsFull ou separateStems),
  -- selon le mode choisi au moment de l'analyse (stem_mode ci-dessous) :
  --  - mode "2" : vocals_path + instrumental_path seulement.
  --  - mode "4" : vocals_path/drums_path/bass_path/other_path.
  --  - mode "6" : les 4 précédents + guitar_path/piano_path.
  -- Les colonnes non pertinentes pour le mode courant restent NULL — un
  -- changement de mode ré-analyse le morceau et écrase ces colonnes (une
  -- seule "version" des stems conservée par morceau, pas une par mode).
  stem_mode        TEXT DEFAULT '4',        -- '2' | '4' | '6'
  vocals_path      TEXT,
  instrumental_path TEXT,                   -- mode "2" uniquement (instru complet combiné)
  drums_path       TEXT,
  bass_path        TEXT,
  guitar_path      TEXT,                    -- mode "6" uniquement
  piano_path       TEXT,                    -- mode "6" uniquement
  other_path       TEXT,

  analyzed_at      INTEGER NOT NULL          -- epoch ms
);
