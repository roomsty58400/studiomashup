// Cache mémoire pour les Lyrics et Prompts Suno.
// Permet de précharger en arrière-plan (dès qu'un morceau est identifié dans un Deck)
// pour que l'ouverture du modal Lyrics / Prompt Suno soit instantanée.

const API_BASE = "http://localhost:3001";

const lyricsCache = new Map();
const sunoCache = new Map();

// Décode les entités HTML (&#39; → ', &amp; → &, etc.) pour que la clé de cache
// soit la même peu importe d'où vient l'appel (préchargement vs modal).
function decodeHtml(str) {
  if (!str) return "";
  const txt = document.createElement("textarea");
  txt.innerHTML = str;
  return txt.value;
}

const keyFor = (title, channel) => `${(title || "").trim()}|||${(channel || "").trim()}`;

// ── Lyrics ──
export function fetchLyrics(rawTitle, rawChannel, { force = false } = {}) {
  const title = decodeHtml(rawTitle);
  const channel = decodeHtml(rawChannel);
  if (!title) return Promise.resolve(null);
  const key = keyFor(title, channel);

  if (!force && lyricsCache.has(key)) return lyricsCache.get(key);

  const params = new URLSearchParams({ title, channel: channel || "" });
  const promise = fetch(`${API_BASE}/api/lyrics?${params}`)
    .then((res) => res.json())
    .catch((err) => {
      lyricsCache.delete(key); // permet de réessayer plus tard
      throw err;
    });

  lyricsCache.set(key, promise);
  return promise;
}

// ── Prompt Suno ──
export function fetchSunoPrompt(rawTitle, rawChannel, { force = false } = {}) {
  const title = decodeHtml(rawTitle);
  const channel = decodeHtml(rawChannel);
  if (!title) return Promise.resolve(null);
  const key = keyFor(title, channel);

  if (!force && sunoCache.has(key)) return sunoCache.get(key);

  const promise = fetch(`${API_BASE}/api/prompt/suno`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, channel }),
  })
    .then((res) => res.json())
    .catch((err) => {
      sunoCache.delete(key);
      throw err;
    });

  sunoCache.set(key, promise);
  return promise;
}

// ── Préchargement silencieux des deux (appelé dès qu'un morceau est identifié) ──
export function prefetchMedia(title, channel) {
  if (!title) return;
  fetchLyrics(title, channel).catch(() => {});
  fetchSunoPrompt(title, channel).catch(() => {});
}
