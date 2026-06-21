import express from "express";
import { load } from "cheerio";
import { parseVideoTitle } from "../utils/videoTitle.js";

const router = express.Router();

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function cleanLyrics(text) {
  return (text || "")
    .replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "")
    .replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isValidLyrics(text) {
  return typeof text === "string" && text.trim().length > 30;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    headers: { ...BROWSER_HEADERS, ...options.headers },
    signal: AbortSignal.timeout(options.timeout || 10000),
    ...options,
  });
}

/** Cherche récursivement une clé dans un objet imbriqué */
function findDeep(obj, key, depth = 0) {
  if (depth > 12 || obj === null || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const r = findDeep(obj[k], key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

// ─── Source principale : Musixmatch ──────────────────────────────────────────

async function tryMusixmatch(artist, song) {
  const query = `${artist} ${song}`.trim();

  // ── Étape 1 : Recherche ──
  const searchUrl = `https://www.musixmatch.com/search/${encodeURIComponent(query)}/tracks`;
  const searchRes = await fetchWithTimeout(searchUrl, { timeout: 10000 });
  if (!searchRes.ok) throw new Error(`musixmatch search: HTTP ${searchRes.status}`);

  const searchHtml = await searchRes.text();
  const $s = load(searchHtml);
  const rawNextData = $s("#__NEXT_DATA__").text();
  if (!rawNextData) throw new Error("musixmatch: pas de __NEXT_DATA__ sur la page de recherche");

  const searchData = JSON.parse(rawNextData);
  const trackList = findDeep(searchData, "track_list");
  if (!Array.isArray(trackList) || trackList.length === 0) {
    throw new Error("musixmatch: aucun résultat pour cette recherche");
  }

  const firstTrack = trackList[0]?.track || trackList[0];
  const trackShareUrl = firstTrack?.track_share_url;
  const trackName = firstTrack?.track_name || song;
  const artistName = firstTrack?.artist_name || artist;

  if (!trackShareUrl) throw new Error("musixmatch: URL de la chanson introuvable");
  console.log(`[musixmatch] Trouvé : "${trackName}" – ${artistName} → ${trackShareUrl}`);

  // ── Étape 2 : Page paroles ──
  const lyricsRes = await fetchWithTimeout(trackShareUrl, { timeout: 10000 });
  if (!lyricsRes.ok) throw new Error(`musixmatch lyrics page: HTTP ${lyricsRes.status}`);

  const lyricsHtml = await lyricsRes.text();
  const $l = load(lyricsHtml);

  // Tentative 1 : extraire depuis __NEXT_DATA__
  const rawLyricsData = $l("#__NEXT_DATA__").text();
  if (rawLyricsData) {
    const lyricsData = JSON.parse(rawLyricsData);
    const lyricsBody = findDeep(lyricsData, "lyrics_body");
    if (isValidLyrics(lyricsBody)) {
      return {
        lyrics: cleanLyrics(lyricsBody.replace(/\*{3,}.*$/s, "").trim()),
        source: "musixmatch.com",
        parsedArtist: artistName,
        parsedSong: trackName,
      };
    }
  }

  // Tentative 2 : scraper le HTML directement (sélecteurs CSS Musixmatch)
  const lyricsLines = [];
  $l(".lyrics__content__ok span, .mxm-lyrics span, [class*='Lyrics__Content'] span, .mxm-lyrics__content span, p.mxm-lyrics__content span").each((_, el) => {
    const line = $l(el).text().trim();
    if (line) lyricsLines.push(line);
  });

  if (lyricsLines.length > 0) {
    const lyrics = lyricsLines.join("\n");
    if (isValidLyrics(lyrics)) {
      return {
        lyrics: cleanLyrics(lyrics),
        source: "musixmatch.com",
        parsedArtist: artistName,
        parsedSong: trackName,
      };
    }
  }

  // Tentative 3 : extraire tout texte dans les blocs lyrics
  const allLyricsText = $l("[class*='lyrics'], [class*='Lyrics']").text().trim();
  if (isValidLyrics(allLyricsText)) {
    return {
      lyrics: cleanLyrics(allLyricsText),
      source: "musixmatch.com",
      parsedArtist: artistName,
      parsedSong: trackName,
    };
  }

  throw new Error("musixmatch: paroles non extraites depuis la page (protection copyright ?)");
}

// ─── Sources de fallback ──────────────────────────────────────────────────────

async function tryLyricsOvh(artist, song) {
  if (!artist || !song) throw new Error("ovh: need artist+song");
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(song)}`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": "StudioMashup/1.0" } });
  if (!res.ok) throw new Error(`ovh: HTTP ${res.status}`);
  const data = await res.json();
  if (!isValidLyrics(data.lyrics)) throw new Error("ovh: empty");
  return { lyrics: cleanLyrics(data.lyrics), source: "lyrics.ovh" };
}

async function tryLrclib(artist, song) {
  const params = new URLSearchParams({ q: `${artist} ${song}`.trim() });
  const url = `https://lrclib.net/api/search?${params}`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": "StudioMashup/1.0" } });
  if (!res.ok) throw new Error(`lrclib: HTTP ${res.status}`);
  const data = await res.json();
  const hit = Array.isArray(data) && data.find(r => r.plainLyrics);
  if (!hit) throw new Error("lrclib: no result");
  return { lyrics: cleanLyrics(hit.plainLyrics), source: "lrclib.net" };
}

async function tryTextyl(artist, song) {
  const q = encodeURIComponent(`${song} ${artist}`.trim());
  const res = await fetchWithTimeout(`https://api.textyl.co/api/lyrics?q=${q}`, { headers: { "User-Agent": "StudioMashup/1.0" } });
  if (!res.ok) throw new Error(`textyl: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error("textyl: empty");
  const lyrics = data.map(l => l.lyrics).filter(Boolean).join("\n");
  if (!isValidLyrics(lyrics)) throw new Error("textyl: too short");
  return { lyrics: cleanLyrics(lyrics), source: "textyl.co" };
}

// ─── Stratégie : Musixmatch en priorité, fallbacks ensuite ───────────────────

async function searchLyrics(candidates) {
  for (const { artist, song } of candidates) {
    if (!song) continue;

    // 1. Musixmatch en priorité
    try {
      const result = await tryMusixmatch(artist, song);
      if (result) return result;
    } catch (e) {
      console.log(`[musixmatch] "${artist}" / "${song}" → ${e.message}`);
    }

    // 2. Fallbacks en parallèle
    const fallbacks = await Promise.allSettled([
      tryLyricsOvh(artist, song),
      tryLrclib(artist, song),
      tryTextyl(artist, song),
    ]);
    const ok = fallbacks.find(r => r.status === "fulfilled");
    if (ok) return { ...ok.value, parsedArtist: artist, parsedSong: song };
  }
  return null;
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const { title, artist, channel } = req.query;
  if (!title && !artist) return res.status(400).json({ error: "Missing title" });

  const manualCandidate = artist && title
    ? [{ artist, song: title, confidence: 10 }]
    : [];
  const parsedCandidates = parseVideoTitle(title || "", channel || "");
  const candidates = [...manualCandidate, ...parsedCandidates];

  console.log("[lyrics] candidates:", candidates.slice(0, 3).map(c => `"${c.artist}" / "${c.song}"`).join(" | "));

  const result = await searchLyrics(candidates);
  if (result) return res.json(result);

  res.status(404).json({
    error: "Paroles introuvables",
    tried: candidates.slice(0, 3),
  });
});

export default router;
