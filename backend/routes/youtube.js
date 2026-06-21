import express from "express";
import dotenv from "dotenv";
import { searchYouTube as searchYouTubeYtdlp } from "../services/ytdlp.js";
dotenv.config();

const router = express.Router();
const API_KEY = process.env.YT_API_KEY;

if (!API_KEY) {
  console.warn("⚠️  YT_API_KEY manquante dans backend/.env — toutes les recherches YouTube (Decks A/B + Clip Editor) échoueront silencieusement (résultats vides).");
}

// ── Cache court (5 min) par requête ──
// search.list coûte 100 unités de quota Google par appel (quota par défaut :
// 10 000/jour, soit ~100 recherches/jour pour TOUTE l'app — Decks A, B et
// Clip Editor partagent la même clé). Sans cache, retaper une requête déjà
// vue (très fréquent : préfixes similaires, le même artiste cherché dans 2
// decks...) consomme à nouveau 100 unités et ajoute 1-2 aller-retours réseau
// à chaque fois. Avec le cache : résultat instantané (0ms, 0 quota) sur les
// requêtes déjà vues récemment.
const CACHE_TTL = 5 * 60 * 1000;
const searchCache = new Map(); // q (normalisée) -> { data, ts }

// ── fetch avec timeout explicite ──
// Sans ça, un appel Google anormalement lent (ou qui ne répond jamais) bloque
// la recherche indéfiniment côté utilisateur ("temps long pour afficher").
const fetchWithTimeout = async (url, ms) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// Convertit une durée ISO 8601 YouTube ("PT4M13S") en secondes.
const parseIsoDuration = (iso) => {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const [, h, mi, s] = m;
  return (Number(h || 0) * 3600) + (Number(mi || 0) * 60) + Number(s || 0);
};

router.get("/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query" });
  if (!API_KEY) return res.status(500).json({ error: "Clé API YouTube manquante côté serveur (YT_API_KEY)." });

  const cacheKey = q.trim().toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    // NOTE : le paramètre videoCategoryId sur search.list est connu pour être
    // peu fiable côté API YouTube (combiné à "q", il renvoie souvent 0
    // résultat) — c'est ce qui a cassé la recherche (plus aucun clip affiché).
    // On revient à une recherche standard (fiable), puis on filtre les
    // résultats À POSTERIORI sur la vraie catégorie (10 = Musique) via
    // videos.list, qui supporte categoryId sans ce problème.
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=25&q=${encodeURIComponent(q)}&key=${API_KEY}`;
    const searchRes = await fetchWithTimeout(searchUrl, 8000);
    const searchData = await searchRes.json();

    // L'API Google renvoie un statut 200 même en cas d'erreur applicative
    // (quota dépassé, clé invalide...) avec un champ "error" dans le corps —
    // avant, ce cas n'était jamais détecté : "items" devenait silencieusement
    // [] et l'utilisateur voyait juste "aucun résultat" sans explication.
    if (searchData.error) {
      console.error("YT SEARCH API ERROR:", JSON.stringify(searchData.error));
      const reason = searchData.error.errors?.[0]?.reason;
      // Google a 2 formats d'erreur de quota selon l'API/le moment :
      // l'ancien (errors[0].reason === "quotaExceeded") et le nouveau
      // (status: "RESOURCE_EXHAUSTED" + message texte "Quota exceeded...").
      // Le 1er test seul ne suffisait plus → la détection passait à côté et
      // tombait dans le message d'erreur générique au lieu du repli yt-dlp.
      const isQuotaExceeded =
        reason === "quotaExceeded" ||
        searchData.error.status === "RESOURCE_EXHAUSTED" ||
        /quota exceeded/i.test(searchData.error.message || "");

      // Quota search.list dépassé : on bascule sur yt-dlp (recherche directe,
      // sans clé ni quota API) plutôt que de renvoyer une erreur — moins riche
      // (pas de filtrage "musique uniquement" possible ici), mais ça continue
      // de fonctionner même quota épuisé pour la journée.
      if (isQuotaExceeded) {
        console.warn("[youtube] quota search.list dépassé — repli sur yt-dlp pour :", q);
        try {
          const fallbackResults = await searchYouTubeYtdlp(q, 25);
          searchCache.set(cacheKey, { data: fallbackResults, ts: Date.now() });
          return res.json(fallbackResults);
        } catch (e) {
          console.error("[youtube] repli yt-dlp échoué :", e.message);
          return res.status(502).json({ error: "Quota YouTube API dépassé pour aujourd'hui, et la recherche de secours (yt-dlp) a aussi échoué." });
        }
      }

      const msg = `Erreur API YouTube : ${searchData.error.message || reason || "inconnue"}`;
      return res.status(502).json({ error: msg });
    }

    const decodeHtml = s => s
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");

    const items = searchData.items || [];
    const videoIds = items.map(item => item.id.videoId).filter(Boolean);

    // Catégorie réelle (10 = Musique) + durée de chaque vidéo — un seul appel
    // groupé (snippet+contentDetails), best-effort avec timeout court : si
    // Google répond lentement sur CET appel précis, on préfère afficher les
    // résultats bruts tout de suite plutôt que de faire attendre l'utilisateur
    // pour un filtre/enrichissement "bonus".
    let musicIds = new Set(videoIds); // par défaut : tout garder si l'appel échoue/expire
    const durationById = new Map();
    if (videoIds.length) {
      try {
        const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(",")}&key=${API_KEY}`;
        const detailsRes = await fetchWithTimeout(detailsUrl, 3000);
        const detailsData = await detailsRes.json();
        if (detailsData.error) {
          console.warn("YT DETAILS API error (ignoré, résultats non filtrés/enrichis) :", JSON.stringify(detailsData.error));
        } else {
          const musicOnly = (detailsData.items || [])
            .filter(v => v.snippet?.categoryId === "10")
            .map(v => v.id);
          // Si le filtrage musique élimine TOUT (ex: requête hors-musique
          // légitime), on préfère afficher les résultats bruts plutôt que rien.
          if (musicOnly.length) musicIds = new Set(musicOnly);
          for (const v of (detailsData.items || [])) {
            durationById.set(v.id, parseIsoDuration(v.contentDetails?.duration));
          }
        }
      } catch (e) {
        console.warn("YT DETAILS skipped (timeout/réseau) :", e.message);
      }
    }

    const MAX_DURATION_SEC = 7 * 60; // au-delà : "indisponible" (trop long à traiter)

    const results = items
      .filter(item => musicIds.has(item.id.videoId))
      .map(item => {
        const title = decodeHtml(item.snippet.title);
        const channel = decodeHtml(item.snippet.channelTitle);
        const durationSec = durationById.get(item.id.videoId) ?? null;
        return {
          videoId: item.id.videoId,
          title,
          channel,
          thumbnail: item.snippet.thumbnails.medium.url,
          durationSec,
          // Heuristique "vidéo officielle" : marqueur "officiel/VEVO" dans le
          // titre ou le nom de chaîne — signal standard pour repérer le clip
          // posté par l'artiste/le label plutôt qu'un re-upload/fan-made.
          isOfficial: /\bofficial\b|\bvevo\b|clip officiel/i.test(title) || /\bofficial\b|\bvevo\b/i.test(channel),
          unavailable: durationSec != null && durationSec > MAX_DURATION_SEC,
          unavailableReason: durationSec != null && durationSec > MAX_DURATION_SEC
            ? `Trop long (${Math.round(durationSec / 60)} min, max 7 min)` : null,
        };
      })
      // Vidéos officielles d'abord (tri stable : l'ordre de pertinence Google
      // est préservé à l'intérieur de chaque groupe officiel/non-officiel).
      .sort((a, b) => (b.isOfficial ? 1 : 0) - (a.isOfficial ? 1 : 0));

    searchCache.set(cacheKey, { data: results, ts: Date.now() });
    res.json(results);
  } catch (err) {
    const timedOut = err.name === "AbortError";
    console.error("YT SEARCH ERROR:", timedOut ? "timeout (8s)" : err.message);
    res.status(502).json({ error: timedOut ? "L'API YouTube ne répond pas (timeout)." : "YouTube search failed" });
  }
});

export default router;
