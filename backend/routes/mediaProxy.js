import express from "express";

const router = express.Router();

// ── Proxy média RaveDJ (correctif Content-Type, juillet 2026) ────────────
// Bug root-causé en conditions réelles : le rendu final RaveDJ (URL du type
// https://assets2.rave.dj/videos/<id>.mp4) est servi par leur CDN avec
// l'en-tête "Content-Type: binary/octet-stream" (vérifié via une requête
// HEAD directe) au lieu de "video/mp4" — le fichier lui-même est un .mp4
// tout à fait valide (lu et lançable via ffprobe/lecteur externe), mais un
// <video> HTML ne tente même pas de le décoder avec ce Content-Type
// générique (sécurité navigateur contre la confusion de type MIME) : la
// vidéo restait indéfiniment "en chargement", jamais d'erreur explicite —
// c'est ce que l'utilisateur observait ("il ne charge pas le fichier").
// Solution : ce backend récupère le fichier lui-même (même origine que le
// frontend du point de vue du navigateur, donc plus de souci de type MIME
// détecté) et le resert avec "Content-Type: video/mp4" forcé. Supporte les
// requêtes "Range" (transmises à l'amont) pour permettre de chercher dans la
// vidéo sans la retélécharger entièrement à chaque déplacement du curseur.
//
// Sécurité : n'accepte QUE des URLs dont l'hôte est rave.dj ou un de ses
// sous-domaines — jamais un proxy ouvert vers une URL arbitraire fournie par
// le client (risque SSRF sinon).
const isAllowedHost = (hostname) => hostname === "rave.dj" || hostname.endsWith(".rave.dj");

router.get("/", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Paramètre 'url' requis" });

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "URL invalide" });
  }
  if (!isAllowedHost(parsed.hostname)) {
    return res.status(403).json({ error: `Domaine non autorisé pour ce proxy (uniquement rave.dj) : ${parsed.hostname}` });
  }

  try {
    const upstreamHeaders = {};
    if (req.headers.range) upstreamHeaders.range = req.headers.range;

    const upstream = await fetch(url, { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: `RaveDJ a répondu ${upstream.status}` });
    }

    res.status(upstream.status);
    // Le cœur du correctif : ignorer le Content-Type d'origine (générique,
    // non lisible par <video>) et forcer celui attendu pour un .mp4.
    res.setHeader("Content-Type", "video/mp4");
    ["content-length", "content-range", "cache-control"].forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    res.setHeader("Accept-Ranges", "bytes");

    if (!upstream.body) return res.end();
    // Copie manuelle chunk par chunk plutôt que Readable.fromWeb(...).pipe(res) :
    // constaté en conditions réelles que .pipe() sur un ReadableStream Web
    // converti reste bloqué après le tout premier chunk pour ce fichier de
    // 37 Mo (le <video> restait indéfiniment "en chargement", 0 octet de plus
    // jamais reçu) — gère nous-mêmes le contre-pression (`write`/`drain`),
    // comportement plus prévisible.
    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const ok = res.write(Buffer.from(value));
        if (!ok) await new Promise((resolve) => res.once("drain", resolve));
      }
      res.end();
    } catch (e) {
      console.error("[mediaProxy] Erreur pendant le streaming :", e.message);
      res.end();
    }
  } catch (e) {
    res.status(502).json({ error: `Proxy média impossible : ${e.message}` });
  }
});

export default router;
