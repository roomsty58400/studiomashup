// ─── Parseur de titre YouTube (artiste + chanson) ───────────────────────────
// Extrait à partir d'un titre de vidéo YouTube et de son nom de chaîne, le
// VRAI nom de la chanson + de l'artiste — par exemple "Stromae - Papaoutai
// (Official Video)" / chaîne "StromaeVEVO" → {artist: "Stromae", song:
// "Papaoutai"}, plutôt que de se reposer sur le nom de la chaîne brut
// ("StromaeVEVO" au lieu de "Stromae", ou un nom de chaîne qui ne correspond
// pas du tout à l'artiste sur des chaînes de compilation/fan).
// Utilisé par routes/lyrics.js (recherche de paroles) ET services/coverAI.js
// (texte affiché sur la pochette générée par IA) pour partager exactement la
// même logique d'extraction.

const NOISE_PATTERNS = [
  /\(official\s*(music\s*)?video\)/gi,
  /\[official\s*(music\s*)?video\]/gi,
  /\(official\s*audio\)/gi, /\[official\s*audio\]/gi,
  /\(official\s*lyric\s*video\)/gi, /\[official\s*lyric\s*video\]/gi,
  /\(lyrics?\s*(video)?\)/gi, /\[lyrics?\s*(video)?\]/gi,
  /\(audio\)/gi, /\[audio\]/gi,
  /\(hd\)/gi, /\[hd\]/gi, /\(hq\)/gi, /\[hq\]/gi,
  /\(4k\)/gi, /\[4k\]/gi,
  /\(remaster(ed)?\)/gi, /\[remaster(ed)?\]/gi,
  /\(visualizer\)/gi, /\(clip officiel\)/gi,
  /\(music video\)/gi, /\[music video\]/gi,
  /\bvevo\b/gi, /\bofficial\b/gi, /\blyrics\b/gi,
  // Reposts d'archives (ex: vieux clips français déposés par l'INA) — vu en
  // pratique : "Tata Yoyo (Archive INA)" laissait passer "(Archive INA)"
  // jusque dans le titre de mashup généré par l'IA, faute de motif dédié.
  /\(archives?\s*(ina)?\s*\)/gi, /\[archives?\s*(ina)?\s*\]/gi,
  /\(live\)/gi, /\[live\]/gi,
  /\(audio officiel\)/gi, /\[audio officiel\]/gi,
  /\(vidéo officielle\)/gi, /\[vidéo officielle\]/gi,
];

function cleanString(str) {
  let s = str || "";
  for (const p of NOISE_PATTERNS) s = s.replace(p, " ");
  return s.trim().replace(/\s{2,}/g, " ");
}

function cleanChannel(channel) {
  return (channel || "")
    .replace(/\bVEVO\b/gi, "").replace(/\bOfficial\b/gi, "")
    .replace(/\bTV\b/gi, "").replace(/\bMusic\b/gi, "")
    .replace(/[-_]/g, " ").trim();
}

export function parseVideoTitle(rawTitle, rawChannel) {
  const title = cleanString(rawTitle);
  const channel = cleanChannel(rawChannel);
  const candidates = [];

  const dashMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    const a = dashMatch[1].trim();
    const s = dashMatch[2].replace(/\s*[\(\[]feat\..*?[\)\]]/gi, "").trim();
    candidates.push({ artist: a, song: s, confidence: 4 });
    if (channel && a.toLowerCase() !== channel.toLowerCase()) {
      candidates.push({ artist: channel, song: s, confidence: 3 });
    }
    candidates.push({ artist: a, song: title, confidence: 2 });
  }
  if (channel) candidates.push({ artist: channel, song: title, confidence: 2 });
  candidates.push({ artist: "", song: title, confidence: 1 });

  const seen = new Set();
  return candidates
    .filter(c => { const k = `${c.artist}|${c.song}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.confidence - a.confidence);
}

// Raccourci : renvoie directement le MEILLEUR candidat {artist, song}.
export function bestArtistSong(rawTitle, rawChannel) {
  const [best] = parseVideoTitle(rawTitle, rawChannel);
  return best || { artist: cleanChannel(rawChannel), song: cleanString(rawTitle) };
}
