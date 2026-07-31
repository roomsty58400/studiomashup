import express from "express";
import dotenv from "dotenv";
import { generateText } from "../services/geminiText.js";
dotenv.config();

const router = express.Router();

// ── Assistant IA "prompt → playlist de référence" pour DJPLAYLIST (31/07) ──
// L'utilisateur décrit en langage libre l'ambiance/soirée voulue ; l'IA
// (Gemini, même infra que le Prompt Suno de routes/prompt.js) propose un
// thème, un style, une durée cible et une vingtaine de titres RÉELS et
// connus correspondant à la demande. Ce résultat est injecté côté frontend
// comme une playlist de référence "ordinaire" (cf. addBatch dans
// DjPlaylist.jsx) — il repasse donc par tout le pipeline déjà en place
// (comparaison à la bibliothèque locale, élargissement par artiste, pacing
// par phases, export) sans rien dupliquer : l'IA ne fait ici QUE proposer
// une liste de titres de départ, exactement comme les presets codés en dur
// (data/djPlaylistPresets.js), mais sur mesure pour la demande plutôt que
// sur 4 combos figées.

router.post("/", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "prompt requis" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY manquante dans backend/.env" });
  }

  const userPrompt = `Tu es un DJ professionnel et animateur de soirées (mariages, anniversaires, soirées club) avec une culture musicale très large (toutes époques, tous styles).

Un utilisateur décrit l'ambiance/soirée qu'il veut préparer :
"""
${prompt.trim()}
"""

Réponds UNIQUEMENT avec un objet JSON strict (pas de markdown, pas de texte autour), au format exact suivant :

{
  "theme": "court nom de thème (2-4 mots, ex: Mariage, Anniversaire 40 ans, Soirée Club)",
  "style": "court nom de sous-style/ambiance (2-4 mots, ex: Bohème romantique, Latino festif, House énergique)",
  "targetMinutes": nombre de minutes cible (déduit de la demande si mentionné, sinon 120 par défaut),
  "tracks": [
    { "title": "titre exact de la chanson", "artist": "nom exact de l'artiste" }
  ]
}

Règles impératives :
- "tracks" doit contenir au moins 20 titres et jusqu'à 30.
- Uniquement des morceaux RÉELS qui existent vraiment (pas d'inventions), avec titre et artiste orthographiés correctement.
- Diversifie les artistes (jamais plus de 2 titres du même artiste).
- Adapte le choix des morceaux à TOUTE la demande (thème, ambiance, énergie, époque suggérée, contraintes éventuelles).
- Si la demande mentionne plusieurs phases d'ambiance (ex: "chill puis dansant"), mélange des morceaux couvrant ces différentes énergies — le tri par phase est fait automatiquement ensuite, pas la peine de les ordonner toi-même.
- "style" ne doit PAS être identique à "theme".
- Réponds en français pour theme/style, mais garde les titres/artistes dans leur langue/orthographe d'origine.`;

  try {
    const raw = await generateText(apiKey, userPrompt, { responseMimeType: "application/json" });
    const parsed = parsePlaylistJson(raw);
    res.json(parsed);
  } catch (err) {
    console.error("[PlaylistPrompt] Erreur:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function parsePlaylistJson(raw) {
  let text = raw.trim();
  // Au cas où le modèle encadre quand même sa réponse de ```json ... ```
  // malgré la consigne (arrive parfois selon le modèle de repli utilisé).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Réponse IA illisible (pas un JSON valide) — réessaie, ou reformule ta demande.");
  }

  const tracks = Array.isArray(data.tracks)
    ? data.tracks
        .filter(t => t && t.title && t.artist)
        .map(t => ({ title: String(t.title).trim(), artist: String(t.artist).trim() }))
    : [];

  if (tracks.length === 0) {
    throw new Error("L'IA n'a proposé aucun titre exploitable — réessaie, ou reformule ta demande.");
  }

  const targetMinutes = Number(data.targetMinutes);
  return {
    theme: (data.theme && String(data.theme).trim()) || "Soirée",
    style: (data.style && String(data.style).trim()) || "IA",
    targetMinutes: Number.isFinite(targetMinutes) && targetMinutes > 0 ? Math.round(targetMinutes) : 120,
    tracks,
  };
}

export default router;
