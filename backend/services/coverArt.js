// ─── Récupération de pochette d'album/EP (base de données internationale) ──
// Retour utilisateur (31/07) : remplacer la miniature YouTube (souvent une
// capture d'écran de clip, pas la vraie pochette) par la véritable pochette
// d'album/EP du morceau quand elle existe, via une base de données musicale.
//
// Source choisie : iTunes Search API (Apple) — gratuite, sans clé, sans
// inscription, couverture internationale très large (labels majors ET indés),
// et taillable jusqu'à 600x600 en changeant simplement l'URL retournée. Pas
// besoin d'OAuth ni de quota à gérer contrairement à Spotify/Discogs.
//
// Le texte de recherche est construit à partir du couple {artist, song} déjà
// extrait par bestArtistSong() (utils/videoTitle.js — même logique que pour
// les paroles et la pochette IA), plutôt que le titre brut de la vidéo qui
// contient souvent du bruit ("(Official Video)", "ft.", etc.) qui dégrade la
// pertinence de la recherche.

const cache = new Map(); // clé "artist|song" → { url, ts }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — les pochettes ne changent pas

// Force une résolution plus grande que le 100x100 par défaut d'iTunes.
function upscaleArtwork(url) {
  if (!url) return null;
  return url.replace(/\d+x\d+bb\.(jpg|png)$/i, "600x600bb.$1");
}

export const fetchAlbumArt = async (artist, song) => {
  const query = `${artist || ""} ${song || ""}`.trim();
  if (!query) return null;
  const key = query.toLowerCase();

  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.url;

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`iTunes API ${res.status}`);
    const data = await res.json();
    const result = data.results?.[0];
    const artUrl = upscaleArtwork(result?.artworkUrl100);
    cache.set(key, { url: artUrl, ts: Date.now() });
    return artUrl;
  } catch (err) {
    console.error(`⚠ [coverArt] échec recherche pochette pour "${query}" :`, err.message);
    // On met aussi le résultat null en cache (courte durée implicite via la
    // même TTL) pour éviter de re-frapper l'API en boucle sur un échec répété
    // (ex: réseau coupé) tant que l'utilisateur reste sur la même page.
    cache.set(key, { url: null, ts: Date.now() });
    return null;
  }
};
