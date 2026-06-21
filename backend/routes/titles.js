import express from "express";
import dotenv from "dotenv";
import { bestArtistSong } from "../utils/videoTitle.js";
dotenv.config();

const router = express.Router();

// Même logique que prompt.js (qui fonctionne)
async function listGeminiModels(apiKey) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?key=" + apiKey,
    { signal: AbortSignal.timeout(8000) }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
    .map(m => m.name.replace("models/", ""))
    .sort((a, b) => {
      const score = s => s.includes("flash") ? 0 : s.includes("pro") ? 1 : 2;
      return score(a) - score(b);
    });
}

async function callGemini(apiKey, prompt) {
  const models = await listGeminiModels(apiKey);
  if (!models.length) throw new Error("Aucun modèle Gemini disponible");
  let lastErr = "";
  for (const model of models) {
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 768, temperature: 1.1 },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      const data = await res.json();
      if (data.error) { lastErr = model + ": " + data.error.message; console.warn("[titles]", lastErr); continue; }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) { lastErr = model + ": réponse vide"; continue; }
      console.log("[titles] succès avec", model);
      return text.trim();
    } catch(e) { lastErr = model + ": " + e.message; console.warn("[titles]", lastErr); }
  }
  throw new Error("Tous les modèles ont échoué. Dernier: " + lastErr);
}

router.post("/", async (req, res) => {
  const { titleA, artistA, titleB, artistB } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY manquante" });

  // titleA/titleB sont les titres BRUTS de la vidéo YouTube (ex: "CARLOS -
  // Big Bisous (Clip officiel)", "Annie Cordy - Tata Yoyo (Archive INA)") —
  // les envoyer tels quels à l'IA donnait des titres de mashup incohérents
  // (l'IA reprenait des bouts de "Clip officiel", "Archive INA", ou le nom
  // d'artiste collé dans le titre brut). On extrait le VRAI titre de chanson
  // (sans artiste, sans bruit "officiel/HD/VEVO/etc.") via la même logique
  // déjà utilisée pour les paroles et la pochette IA (utils/videoTitle.js),
  // pour donner à l'IA une matière première propre.
  const parsedA = bestArtistSong(titleA, artistA);
  const parsedB = bestArtistSong(titleB, artistB);
  const songA = parsedA.song || titleA || "Track A";
  const songB = parsedB.song || titleB || "Track B";

  const prompt = `Tu es un DJ créatif et producteur de mashups. Génère exactement 10 titres pour un mashup entre les morceaux "${songA}" et "${songB}".

Règle la plus importante : chaque titre doit rester compréhensible comme la fusion de CES DEUX morceaux précis — pas un titre abstrait déconnecté des originaux. Pour ça, base-toi UNIQUEMENT sur les mots des deux titres de chanson ci-dessus ("${songA}" et "${songB}") :
- reprendre un mot ou bout de phrase de chaque titre original et les combiner ("${songA}" + "${songB}" → mélange des deux)
- ou juxtaposer les deux titres avec un connecteur ("x", "vs", "meets", "×", "/")
- ou un jeu de mots (calembour) qui fusionne les deux titres en un seul mot/expression
- varie les 10 entre ces techniques (pas 10 fois le même procédé)

Interdiction stricte : n'utilise JAMAIS les noms des artistes/chanteurs dans les titres générés, même s'ils sont connus — seuls les mots des TITRES DE CHANSON eux-mêmes doivent apparaître, pour que le résultat sonne comme un vrai titre de chanson cohérent (et pas comme une affiche de concert "Artiste A x Artiste B").

Autres règles :
- Chaque titre : 2 à 6 mots maximum
- En français ou en anglais selon ce qui sonne le mieux
- Pas d'explication, juste les titres
- Réponds UNIQUEMENT avec un tableau JSON de 10 chaînes, exemple : ["Titre 1","Titre 2","Titre 3","Titre 4","Titre 5","Titre 6","Titre 7","Titre 8","Titre 9","Titre 10"]`;

  try {
    const raw = await callGemini(apiKey, prompt);
    console.log("[titles] réponse brute:", raw.substring(0, 300));
    let titles = parseTitles(raw);
    if (!titles.length) throw new Error("Aucun titre exploitable dans la réponse de l'IA");

    // Filet de sécurité : le prompt interdit déjà les noms d'artistes, mais
    // au cas où l'IA n'obéit pas, on retire quand même tout titre qui en
    // laisserait passer un — pour ne jamais afficher "Artiste A x Artiste B"
    // à la place d'un vrai titre de chanson cohérent.
    const artistNames = [parsedA.artist, parsedB.artist, artistA, artistB]
      .filter(Boolean).map(a => a.trim()).filter(a => a.length > 1);
    if (artistNames.length) {
      const artistRegex = new RegExp(artistNames.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
      const filtered = titles.filter(t => !artistRegex.test(t));
      if (filtered.length) titles = filtered;
    }

    res.json({ titles: titles.slice(0, 10) });
  } catch(err) {
    console.error("[titles]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Gemini ne respecte pas toujours à 100% la consigne "tableau JSON pur" —
// parfois il entoure la réponse de balises markdown (```json ... ```),
// parfois il glisse vers une liste numérotée/à puces. On essaie plusieurs
// stratégies dans l'ordre, de la plus stricte à la plus tolérante, pour ne
// jamais laisser passer des artefacts bruts (fences, virgules de fin de
// ligne, guillemets échappés...) jusqu'à l'utilisateur — c'est exactement ce
// qui se produisait avant ("```json" ou des lignes type `"Titre",` affichés
// tels quels dans les suggestions).
function parseTitles(raw) {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();

  // 1) Le texte nettoyé est déjà (ou contient) un tableau JSON valide.
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return arr.map(String).map(s => s.trim()).filter(Boolean);
  } catch {}

  // 2) Extraire le 1er bloc [...] du texte nettoyé et le parser en JSON.
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return arr.map(String).map(s => s.trim()).filter(Boolean);
    } catch {}
  }

  // 3) Repli : parser ligne par ligne (numérotation "1.", puces "-"/"*",
  // guillemets ouvrants/fermants, virgule de fin de ligne JSON mal fermé,
  // guillemets échappés \" ) — et on exclut les lignes vides, les fences
  // ([ ou ] isolés) et tout ce qui n'a pas la forme d'un titre.
  return cleaned
    .split("\n")
    .map(l => l
      .replace(/^[\s\-*\d.)]+/, "")
      .replace(/^["']+/, "")
      .replace(/\\"/g, '"')
      .replace(/["']?\s*,?\s*$/, "")
      .trim())
    .filter(l => l.length > 2 && l.length < 60 && !/^[[\]]+$/.test(l));
}

export default router;
