// ── Téléchargement forcé cross-origin (audit juillet 2026) ─────────────────
// Le frontend (Vite, :5173) et le backend (:3001) sont deux origines
// différentes pour le navigateur. L'attribut HTML `download` sur un <a> et
// window.open() sont TOUS DEUX sans effet dès que l'URL cible est cross-
// origin : le navigateur ouvre/joue le fichier au lieu de le télécharger.
// Seul un en-tête Content-Disposition: attachment envoyé par le SERVEUR force
// le téléchargement quelle que soit l'origine — cf. res.download() déjà
// utilisé côté backend (routes/stems.js, routes/clipEditor.js, routes/radio.js)
// et la nouvelle route générique GET /api/mashup/download (services/
// trackPreparation.js::resolveOutputPath pour la résolution anti-traversée).
//
// buildDownloadUrl() convertit n'importe quelle URL de fichier généré
// ("/outputs/..." relative OU absolue http://localhost:3001/outputs/...) en
// URL passant par cette route de téléchargement forcé. Les URLs qui pointent
// déjà vers une route backend qui force elle-même Content-Disposition (ex:
// /api/clip-editor/:id/video-silent, /api/stems/:id/download/:which) sont
// laissées telles quelles — les re-router via /api/mashup/download casserait
// leur résolution (resolveOutputPath n'attend que des chemins "/outputs/...").
const API = "http://localhost:3001";

export const buildDownloadUrl = (fileUrl, name) => {
  if (!fileUrl) return null;
  let pathOnly = fileUrl;
  let isAbsolute = false;
  try {
    if (/^https?:\/\//i.test(fileUrl)) {
      const u = new URL(fileUrl);
      pathOnly = u.pathname + u.search;
      isAbsolute = true;
    }
  } catch {
    // URL invalide/relative — on continue avec la chaîne telle quelle.
  }
  if (!pathOnly.startsWith("/outputs/")) {
    // Déjà une route de téléchargement forcé côté serveur (res.download) —
    // rien à transformer.
    return isAbsolute ? fileUrl : `${API}${fileUrl}`;
  }
  const params = new URLSearchParams({ url: pathOnly, ...(name ? { name } : {}) });
  return `${API}/api/mashup/download?${params.toString()}`;
};

// Déclenche le téléchargement sans ouvrir d'onglet visible (même pattern que
// Deck.jsx/RadioPlayer.jsx) : un <a> caché cliqué programmatiquement.
export const triggerDownload = (url) => {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};
