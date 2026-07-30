// ── Génération musicale IA (ElevenLabs Music) ──────────────────────────────
// Utilisé par le cadre FadrMacheUp (ClipEditor) : contrairement au reste de
// l'app (Suno/Udio via routes/prompt.js), qui ne fait que RÉDIGER un prompt à
// coller manuellement dans un outil externe, cette fonction appelle une vraie
// API de génération audio et renvoie directement le fichier généré.
//
// Choix d'ElevenLabs (audit juillet 2026, cf. discussion avec l'utilisateur) :
// Suno n'a pas d'API publique en libre-service (accès développeur en cours
// d'exploration mi-2026, partenaires triés sur le volet uniquement) ; Udio
// n'en a aucune. ElevenLabs Music est la seule option avec une API officielle
// documentée et des licences propres (pas de procès en cours, contrairement à
// Suno/Udio). Contrepartie assumée : ça génère un morceau NEUF inspiré du
// genre/de l'ambiance de la piste d'origine (cf. le prompt écrit par Gemini
// dans routes/clipEditor.js), pas une transformation audio-to-audio de la
// piste elle-même — ElevenLabs Music ne prend pas d'audio en entrée pour ça.
const ELEVEN_MUSIC_URL = "https://api.elevenlabs.io/v1/music";

// Génère un morceau à partir d'un prompt texte et renvoie le buffer audio
// (mp3 par défaut, cf. output_format="auto" côté API). `durationMs` doit
// rester dans la fenêtre acceptée par l'API (3000-600000) ; volontairement
// pas de valeur par défaut ici — c'est à l'appelant de décider (cf.
// GENRE_PREVIEW_DURATION_MS dans routes/clipEditor.js, pensé pour un aperçu
// rapide et pas une piste complète, question de coût/latence).
export const composeMusic = async ({ prompt, durationMs, forceInstrumental = false }) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY manquante dans backend/.env — crée un compte sur elevenlabs.io, " +
      "génère une clé (elevenlabs.io/app/settings/api-keys) et colle-la dans backend/.env " +
      "(facturé à l'usage, ~0,15$/minute générée)."
    );
  }
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt de génération vide.");
  }

  const body = { prompt: prompt.trim(), force_instrumental: !!forceInstrumental };
  if (durationMs) {
    body.music_length_ms = Math.max(3000, Math.min(600000, Math.round(durationMs)));
  }

  const res = await fetch(ELEVEN_MUSIC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify(body),
    // La génération peut prendre 30s à plusieurs minutes selon la charge du
    // service — timeout généreux plutôt qu'un échec prématuré sur un appel
    // qui aurait fini par réussir.
    signal: AbortSignal.timeout(240000),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.detail?.message || errJson?.detail || JSON.stringify(errJson);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`ElevenLabs Music a refusé la génération (HTTP ${res.status}) : ${String(detail).slice(0, 300)}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
};
