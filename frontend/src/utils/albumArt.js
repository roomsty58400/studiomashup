// ─── Récupération de pochette d'album/EP réelle (base de données musicale
// internationale, cf. backend/services/coverArt.js — iTunes Search API) ────
// Remplace la miniature YouTube (souvent une capture d'écran de clip) par la
// vraie pochette du morceau quand elle existe. Petit cache mémoire côté
// front en plus du cache serveur, pour éviter un aller-retour réseau à
// chaque re-rendu d'une même carte (ex: liste de résultats qui se re-rend
// pendant qu'on tape dans le champ de recherche).

const API = "http://localhost:3001";
const cache = new Map(); // "title|channel" → Promise<url|null>

export function fetchAlbumArtUrl(title, channel) {
  const key = `${title || ""}|${channel || ""}`.trim().toLowerCase();
  if (!title) return Promise.resolve(null);
  if (cache.has(key)) return cache.get(key);

  const params = new URLSearchParams({ title: title || "", channel: channel || "" });
  const p = fetch(`${API}/api/album-art?${params.toString()}`)
    .then(r => (r.ok ? r.json() : { url: null }))
    .then(d => d.url || null)
    .catch(() => null);

  cache.set(key, p);
  return p;
}
