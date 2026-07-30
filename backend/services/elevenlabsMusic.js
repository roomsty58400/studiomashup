// ── INUTILISÉ (30/07) ───────────────────────────────────────────────────
// Ancienne intégration ElevenLabs Music (vraie génération audio IA par genre,
// cadre FadrMacheUp). Abandonnée sur retour utilisateur : ~0,15$/minute
// générée, trop cher pour un usage perso régulier. Remplacée par de vrais
// effets audio ffmpeg gratuits (EQ/compression/saturation/écho/pitch selon le
// genre) appliqués au mix des stems existants — cf. GENRE_DSP_PRESETS et
// applyGenreEffect dans services/ffmpeg.js, branchés sur la route
// POST /:id/genre-effect de routes/clipEditor.js.
//
// Fichier conservé (pas supprimable depuis ce sandbox, cf. contrainte
// filesystem documentée ailleurs dans le repo) mais plus importé nulle part
// — si une vraie génération IA redevient pertinente un jour (budget dédié,
// API moins chère), la fonction composeMusic() ci-dessous reste réutilisable
// telle quelle (POST https://api.elevenlabs.io/v1/music, header xi-api-key,
// body { prompt, music_length_ms, force_instrumental }).
