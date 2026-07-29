import http from "http";
import https from "https";
import { assertPublicHttpUrl } from "./urlSafety.js";

// ── Lecture du titre en cours via les métadonnées ICY (Shoutcast/Icecast) ──
// La plupart des flux radio embarquent, tous les N octets ("icy-metaint",
// annoncé dans les en-têtes de la réponse), un petit bloc texte contenant
// "StreamTitle='Artiste - Morceau';" — c'est ce que Winamp/VLC affichent
// nativement. Le <audio> HTML natif n'expose PAS cette info (pas d'API
// standard côté navigateur), donc on la récupère ici côté serveur en se
// connectant brièvement au flux avec l'en-tête "Icy-MetaData: 1", puis on
// coupe la connexion dès qu'un bloc de métadonnées a été lu — pas besoin de
// continuer à streamer l'audio, juste le titre.
export const fetchIcyTitle = (streamUrl, timeoutMs = 6000) => new Promise((resolve, reject) => {
  let settled = false;
  const settle = (fn, val) => { if (settled) return; settled = true; fn(val); };

  let mod;
  try {
    mod = new URL(streamUrl).protocol === "https:" ? https : http;
  } catch {
    return reject(new Error("URL de flux invalide."));
  }

  const req = mod.get(streamUrl, {
    headers: { "Icy-MetaData": "1", "User-Agent": "MacheUpStudio/1.0" },
  }, (res) => {
    // Suit les redirections (302 fréquent sur les relais de flux radio).
    // Revalidation anti-SSRF à CHAQUE redirection (audit juillet 2026) : une
    // URL de départ publique et légitime pourrait rediriger vers une adresse
    // interne (volontairement, ou via un relais compromis) — la vérification
    // faite une seule fois côté route (routes/radio.js) ne couvrirait pas ce
    // cas sans ce contrôle supplémentaire ici, à chaque saut.
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.destroy();
      let nextUrl;
      try {
        nextUrl = new URL(res.headers.location, streamUrl).toString();
        assertPublicHttpUrl(nextUrl);
      } catch (e) {
        settle(reject, new Error(`Redirection refusée : ${e.message}`));
        return;
      }
      fetchIcyTitle(nextUrl, timeoutMs).then(v => settle(resolve, v), e => settle(reject, e));
      return;
    }

    const metaInt = parseInt(res.headers["icy-metaint"], 10);
    if (!metaInt || metaInt <= 0) {
      res.destroy();
      settle(reject, new Error("Ce flux ne fournit pas de métadonnées ICY."));
      return;
    }

    let bytesRead = 0;      // octets audio consommés depuis le dernier bloc meta
    let collecting = false; // en train de lire le bloc meta courant
    let metaLength = 0;     // taille annoncée du bloc meta (0-255 * 16)
    let metaBuffer = Buffer.alloc(0);

    const onData = (chunk) => {
      let i = 0;
      while (i < chunk.length) {
        if (!collecting) {
          const remaining = metaInt - bytesRead;
          if (chunk.length - i < remaining) {
            bytesRead += chunk.length - i;
            i = chunk.length;
          } else {
            i += remaining;
            bytesRead = metaInt;
            if (i >= chunk.length) break; // l'octet de longueur meta arrivera au prochain chunk
            metaLength = chunk[i] * 16;
            i += 1;
            if (metaLength === 0) {
              // Pas de nouveau titre à ce cycle (fréquent entre 2 changements
              // de morceau) — on repart pour un cycle audio complet.
              bytesRead = 0;
              continue;
            }
            collecting = true;
            metaBuffer = Buffer.alloc(0);
          }
        } else {
          const need = metaLength - metaBuffer.length;
          const avail = chunk.length - i;
          const take = Math.min(need, avail);
          metaBuffer = Buffer.concat([metaBuffer, chunk.slice(i, i + take)]);
          i += take;
          if (metaBuffer.length >= metaLength) {
            res.removeListener("data", onData);
            res.destroy();
            const text = metaBuffer.toString("utf8").replace(/\0+$/, "");
            const match = text.match(/StreamTitle=['"]([^'"]*)['"]/);
            settle(resolve, match ? match[1].trim() || null : null);
            return;
          }
        }
      }
    };

    res.on("data", onData);
    res.on("error", (e) => settle(reject, e));
    res.on("end", () => settle(reject, new Error("Flux terminé avant réception des métadonnées.")));
  });

  req.on("error", (e) => settle(reject, e));
  req.setTimeout(timeoutMs, () => {
    req.destroy();
    settle(reject, new Error("Délai dépassé pour lire les métadonnées du flux."));
  });
});

// ── Repli #1 : API officielle laut.fm ────────────────────────────────────
// laut.fm expose une API JSON publique et fiable pour le titre en cours —
// bien plus robuste que le parsing ICY brut (pas de connexion persistante à
// maintenir/couper, pas de risque que le en-tête "Icy-MetaData" ou
// "icy-metaint" soit filtré par un CDN/reverse-proxy en amont). Utilisée en
// priorité pour toute URL de flux "*.laut.fm".
export const fetchLautFmTitle = async (streamUrl) => {
  const u = new URL(streamUrl);
  if (!/(^|\.)laut\.fm$/i.test(u.hostname)) return null;
  const slug = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!slug) return null;
  const res = await fetch(`https://api.laut.fm/station/${encodeURIComponent(slug)}/current_song`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`API laut.fm : HTTP ${res.status}`);
  const data = await res.json();
  const artist = data?.artist?.name?.trim();
  const title = data?.title?.trim();
  if (!artist && !title) return null;
  return [artist, title].filter(Boolean).join(" - ");
};

// ── Repli #2 : status-json.xsl (Icecast2) ────────────────────────────────
// Endpoint standard exposé par (presque) tout serveur Icecast2 sur son
// origine — une simple requête HTTP JSON classique, donc beaucoup plus
// susceptible de traverser un CDN/reverse-proxy sans encombre que la
// connexion persistante + en-tête custom qu'exige le parsing ICY brut
// ci-dessus. On y cherche la source dont "listenurl" correspond au flux
// demandé (ou l'unique source si le serveur n'en a qu'une).
export const fetchIcecastStatusTitle = async (streamUrl) => {
  const target = new URL(streamUrl);
  const statusUrl = `${target.protocol}//${target.host}/status-json.xsl`;
  const res = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`status-json.xsl : HTTP ${res.status}`);
  const data = await res.json();
  let sources = data?.icestats?.source;
  if (!sources) return null;
  if (!Array.isArray(sources)) sources = [sources]; // un seul mount → objet, pas tableau

  const targetPath = target.pathname.replace(/\/+$/, "");
  const match = sources.find(s => {
    try { return new URL(s.listenurl).pathname.replace(/\/+$/, "") === targetPath; }
    catch { return false; }
  }) || (sources.length === 1 ? sources[0] : null);

  if (!match) return null;
  // Icecast combine généralement artiste+titre dans le seul champ "title"
  // (ex: "Artiste - Morceau") ; certains encodeurs remplissent "artist" à
  // part — on gère les deux cas.
  const title = match.title?.trim();
  const artist = match.artist?.trim();
  if (title) return artist && !title.includes(artist) ? `${artist} - ${title}` : title;
  return artist || null;
};

// ── Point d'entrée unique : essaie les repils fiables avant le parsing ICY
// brut (dernier recours, le plus fragile derrière un CDN/reverse-proxy).
export const fetchNowPlayingTitle = async (streamUrl, timeoutMs = 6000) => {
  const attempts = [
    () => fetchLautFmTitle(streamUrl),
    () => fetchIcecastStatusTitle(streamUrl),
    () => fetchIcyTitle(streamUrl, timeoutMs),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const title = await attempt();
      if (title) return title;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return null;
};
