import express from "express";
import dotenv from "dotenv";
import { generateText } from "../services/geminiText.js";
dotenv.config();

const router = express.Router();

// callGemini() historique — la logique de repli entre modèles vit maintenant
// dans services/geminiText.js (generateText), réutilisée aussi par l'assistant
// IA de génération de playlist DJPLAYLIST (cf. routes/playlistPrompt.js).
const callGemini = generateText;

router.post("/suno", async (req, res) => {
  const { title, channel } = req.body;
  if (!title) return res.status(400).json({ error: "title requis" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY manquante dans backend/.env" });
  }

  const userPrompt = `You are a world-class music producer and Suno AI prompt engineer. Your prompts are known for producing highly accurate, professional-quality AI-generated music.

Based on the following song, generate a detailed and precise Suno AI prompt:
Title: ${title}
Artist / Channel: ${channel || "unknown"}

Your prompt MUST follow this exact structure (write each section on its own line):

Genre: [list 2-4 specific subgenres, e.g. "darkwave, synth-pop, new wave, cinematic pop"]
Mood: [3-5 precise emotional descriptors, e.g. "melancholic, epic, introspective, bittersweet, nostalgic"]
Instruments: [list every audible instrument, e.g. "electric guitar, synthesizer pads, driving bass, orchestral strings, electronic drums, piano"]
Tempo: [exact BPM or range, e.g. "120 BPM, mid-tempo, driving pulse"]
Vocals: [gender, style, texture, e.g. "male baritone, dramatic delivery, reverb-heavy, layered harmonies, breathy whispers in verses"]
Production: [5-7 specific production details, e.g. "dense reverb, side-chain compression on bass, gated snare, analog warmth, wide stereo field, cinematic build-ups, sudden dynamic drops"]
Structure: [song structure, e.g. "slow atmospheric intro, building verse, explosive chorus, stripped bridge, grand finale"]
References: [2-3 artist references for style, e.g. "sounds like The Cure meets Massive Attack with Coldplay production"]

[suno tags: tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8]

Rules:
- Be highly specific. Never use vague terms like "energetic" alone — add context.
- The tags line must have 6-10 lowercase tags including genre, mood, tempo descriptor, vocal style.
- Write in English for maximum Suno accuracy.
- Output ONLY the prompt, no intro, no explanation, no markdown formatting.`;

  try {
    const text = await callGemini(apiKey, userPrompt);
    res.json({ prompt: text });
  } catch (err) {
    console.error("[Prompt] Erreur finale:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route B : remix / changement de style (audio-to-audio Suno/Udio) ──
// Contrairement à /suno (qui décrit un morceau pour en générer un "à la
// manière de"), ici l'utilisateur a déjà extrait l'audio du clip et va
// l'uploader directement dans Suno ("Upload Audio") ou Udio ("Audio" /
// extend) comme référence/seed. Le prompt généré doit donc décrire le
// STYLE CIBLE (pas le style d'origine), tout en indiquant ce qu'il faut
// garder de l'original pour que le remix reste reconnaissable.
router.post("/remix", async (req, res) => {
  const { title, channel, targetStyle } = req.body;
  if (!title) return res.status(400).json({ error: "title requis" });
  if (!targetStyle) return res.status(400).json({ error: "targetStyle requis" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY manquante dans backend/.env" });
  }

  const userPrompt = `You are a world-class music producer specialized in AI audio-to-audio remixing (Suno "Upload Audio" feature, Udio "Audio Prompt" / extend feature).

A user has extracted the audio from an existing track and is about to upload that audio file directly into Suno or Udio as a reference/seed, then apply a text prompt to restyle it. Your job is to write that text prompt.

Original track:
Title: ${title}
Artist / Channel: ${channel || "unknown"}

Desired new style: ${targetStyle}

Generate a precise audio-to-audio remix prompt, structured like this (write each section on its own line):

Style Transfer: [one-line summary, e.g. "from melancholic indie-pop to high-energy cyberpunk synthwave"]
Genre: [2-4 specific subgenres for the TARGET style]
Mood: [3-5 descriptors for the TARGET mood]
Instruments: [instruments that should now be audible, fitting the target style]
Tempo: [suggested BPM/feel for the target style — keep close to the original tempo unless the target style clearly implies a different one]
Vocals: [how vocals should be treated/processed/replaced in the target style, or "instrumental only" if the style implies no vocals]
Production: [5-7 production techniques typical of the target style]
Keep from original: [2-3 elements of the original track — melody, rhythm, structure, hook — that should stay recognizable through the remix]

[suno tags: tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8]

Practical instructions: [one short sentence reminding the user to upload their extracted audio file as the audio reference in Suno's "Upload Audio" or Udio's audio/extend feature, then paste this prompt as the style description]

Rules:
- Be highly specific about the TARGET style, not the original style.
- Never use vague terms like "energetic" alone — add context.
- The tags line must have 6-10 lowercase tags mixing target genre, mood and tempo descriptors.
- Write in English for maximum Suno/Udio accuracy.
- Output ONLY the prompt, no intro, no explanation, no markdown formatting.`;

  try {
    const text = await callGemini(apiKey, userPrompt);
    res.json({ prompt: text });
  } catch (err) {
    console.error("[Prompt remix] Erreur finale:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
