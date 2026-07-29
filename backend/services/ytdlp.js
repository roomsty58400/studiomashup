import { exec, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { copyFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);

// ── Cache disque par ID vidéo YouTube ──
// Remixer deux fois le même titre ne devrait pas retélécharger depuis YouTube :
// on garde une copie persistante (hors des dossiers tmp/<job> qui sont nettoyés
// après chaque job) indexée par videoId, réutilisée pour les jobs suivants.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "../cache");
const AUDIO_EXTS = [".wav", ".opus", ".webm", ".m4a", ".mp3", ".ogg", ".flac", ".aac"];

const findWithExt = (base, exts) => exts.map(e => base + e).find(p => existsSync(p));

// ── Garde-fou sécurité (audit juillet 2026) ─────────────────────────────
// downloadAudio/downloadVideo interpolent `videoId` DIRECTEMENT dans une
// commande shell (execAsync) ET dans un chemin de cache disque
// (join(cacheDir, videoId)). Le frontend ne fournit normalement que des ids
// YouTube valides (résultats de recherche déjà validés côté API, ou lien
// collé filtré par une regex 11 caractères — cf. Ext.jsx/Deck.jsx
// extractYoutubeId), mais RIEN ne garantit ça côté serveur : ces routes
// acceptent `videoId` tel quel depuis le corps de la requête HTTP. Un id
// contenant des métacaractères shell (`"`, `;`, `` ` ``, `$(...)`) pourrait
// exécuter une commande arbitraire ; un id du type `../../x` pourrait écrire
// en dehors du dossier de cache. Un id YouTube valide est TOUJOURS
// exactement 11 caractères alphanumériques/_/- (format documenté YouTube) —
// on le vérifie ici, au point d'usage, pour protéger l'opération dangereuse
// quel que soit l'appelant (défense en profondeur, plutôt que de compter sur
// chaque route à valider elle-même).
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const assertValidVideoId = (videoId) => {
  if (!YOUTUBE_ID_RE.test(videoId || "")) {
    throw new Error(`videoId invalide : "${videoId}"`);
  }
};

// YouTube renvoie régulièrement des 403 Forbidden / "Requested format is not
// available" sur certains formats/itags selon le "player client" utilisé :
// PO token manquant, ou expérience "SABR-only streaming" déployée côté
// YouTube qui retire les formats progressifs habituels pour un client donné
// (ça a touché "web", puis aussi "android" — cf. yt-dlp issues #12482/#15689).
// On essaie donc plusieurs clients dans l'ordre, en se rabattant sur le
// suivant si le précédent échoue pour une raison liée au format/streaming.
const CLIENT_FALLBACKS = ["android", "ios", "tv", "mweb", "web"];

const runWithClientFallback = async (buildCmd, timeout) => {
  let lastErr;
  for (const client of CLIENT_FALLBACKS) {
    const cmd = buildCmd(client);
    try {
      await execAsync(cmd, { timeout });
      return;
    } catch (err) {
      lastErr = err;
      // Si ce n'est pas un 403/format/SABR/signature, pas la peine d'essayer
      // un autre client : c'est probablement une autre cause (vidéo privée,
      // supprimée, géo-bloquée...).
      if (!/403|Forbidden|signature|SABR|[Ff]ormat is not available|missing a URL/i.test(err.message)) break;
    }
  }
  throw lastErr;
};

export const downloadAudio = async (videoId, outputPath) => {
  assertValidVideoId(videoId);
  const cacheDir = join(CACHE_DIR, "audio");
  mkdirSync(cacheDir, { recursive: true });
  const cacheBase = join(cacheDir, videoId);

  const cached = findWithExt(cacheBase, AUDIO_EXTS);
  if (cached) {
    const ext = cached.slice(cached.lastIndexOf("."));
    await copyFile(cached, outputPath + ext);
    console.log(`[ytdlp] audio servie depuis le cache : ${videoId}`);
    return outputPath + ext;
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    await runWithClientFallback(
      // "bestaudio" seul peut être absent pour un client/vidéo donné (SABR) ;
      // se rabattre sur "best" (audio+vidéo combinés) permet à --extract-audio
      // d'en extraire la piste audio plutôt que d'échouer immédiatement.
      // --postprocessor-args : force directement 44.1kHz/stéréo dans LA MÊME
      // passe ffmpeg que yt-dlp utilise déjà pour produire le WAV (YouTube
      // sert très souvent de l'Opus à 48kHz) — évite qu'une 2e passe ffmpeg
      // complète (services/ffmpeg.js:extractAudio, appelée juste après par
      // tous les routes/*.js) doive redécoder/ré-encoder tout le fichier une
      // 2e fois pour la même normalisation. extractAudio garde un garde-fou
      // (vérifie le format réel avant de sauter sa propre passe) au cas où
      // ces args échoueraient silencieusement sur une combinaison de
      // versions yt-dlp/ffmpeg imprévue.
      (client) => `yt-dlp --remote-components ejs:github --extractor-args "youtube:player_client=${client}" -f "bestaudio/best" --extract-audio --audio-format wav --postprocessor-args "ffmpeg:-ar 44100 -ac 2" -o "${outputPath}" "${url}"`,
      120000
    );
  } catch (err) {
    throw new Error(`yt-dlp failed: ${err.message}`);
  }

  const downloaded = findWithExt(outputPath, AUDIO_EXTS);
  if (downloaded) {
    const ext = downloaded.slice(downloaded.lastIndexOf("."));
    try { await copyFile(downloaded, cacheBase + ext); } catch (e) { console.warn("[ytdlp] cache audio échoué:", e.message); }
  }
  return outputPath;
};

// maxHeight (perf audit — optimisation Demucs/vidéo) : optionnel, borne la
// résolution TÉLÉCHARGÉE. Utilisé UNIQUEMENT par le pipeline mashup
// (routes/mashup.js), dont le montage final (exportMP4_916) downscale de
// toute façon tout à 1920x1080 — télécharger une source 4K/2K pour la
// rescaler immédiatement après gaspille à la fois la bande passante ET le
// temps de décodage/filtrage ffmpeg (bien plus de pixels à traiter par frame
// pour un résultat visuel identique une fois réduit à 1080p). Laissé à null
// (résolution native, comportement inchangé) pour routes/clipEditor.js, où la
// vidéo est livrée à l'utilisateur en stream-copy SANS ré-encodage — la
// résolution téléchargée ICI est celle reçue par l'utilisateur, donc jamais
// plafonnée par défaut.
// Suffixe de cache dépendant de maxHeight : évite qu'un appel plafonné
// (mashup) et un appel plein résolution (clip editor) sur LA MÊME vidéo ne se
// marchent dessus via un cache partagé — chaque variante a son propre fichier.
export const downloadVideo = async (videoId, outputPath, maxHeight = null) => {
  assertValidVideoId(videoId);
  const cacheDir = join(CACHE_DIR, "video");
  mkdirSync(cacheDir, { recursive: true });
  const cacheSuffix = maxHeight ? `_${maxHeight}p` : "";
  const cachePath = join(cacheDir, `${videoId}${cacheSuffix}.mp4`);

  if (existsSync(cachePath)) {
    await copyFile(cachePath, outputPath);
    console.log(`[ytdlp] vidéo servie depuis le cache : ${videoId}${cacheSuffix}`);
    return outputPath;
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const hf = maxHeight ? `[height<=${maxHeight}]` : "";
  try {
    // vcodec^=avc1 (H.264) EXIGÉ explicitement, pas juste "ext=mp4" : YouTube
    // sert de plus en plus de flux "mp4" encodés en AV1 (itags récents haute
    // qualité) — un conteneur .mp4 valide, mais dont le codec vidéo n'est lu
    // par aucun lecteur vidéo un peu ancien/basique (Windows, TV, etc.).
    // Toute la suite du pipeline "clip editor" (stripAudio/recomposeReplace
    // dans services/clipEditor.js) fait un stream-copy (-c:v copy) SANS
    // jamais ré-encoder la vidéo — le codec choisi ICI est donc celui qui
    // finit tel quel dans le fichier livré à l'utilisateur. On force H.264,
    // universellement compatible, avec repli progressif si indisponible.
    await runWithClientFallback(
      (client) => `yt-dlp --remote-components ejs:github --extractor-args "youtube:player_client=${client}" -f "bestvideo${hf}[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best${hf}[vcodec^=avc1][ext=mp4]/bestvideo${hf}[ext=mp4]+bestaudio[ext=m4a]/best${hf}[ext=mp4]/best${hf}/best" -o "${outputPath}" "${url}"`,
      180000
    );
  } catch (err) {
    throw new Error(`yt-dlp video failed: ${err.message}`);
  }

  if (existsSync(outputPath)) {
    try { await copyFile(outputPath, cachePath); } catch (e) { console.warn("[ytdlp] cache vidéo échoué:", e.message); }
  }
  return outputPath;
};

// ── Recherche YouTube via yt-dlp (sans quota API) ──
// Repli utilisé par routes/youtube.js quand l'API Data v3 renvoie
// "quotaExceeded" sur search.list (quota très bas : 100 unités/requête sur
// un quota par défaut de 10 000/jour — vite épuisé avec 3 champs de
// recherche dans l'app). yt-dlp interroge directement YouTube comme pour un
// téléchargement, sans clé ni quota Google. Moins riche en métadonnées (pas
// de filtrage "musique uniquement" possible sans l'API), mais continue de
// fonctionner même quota épuisé.
//
// "spawn" avec un tableau d'arguments (pas "exec" + chaîne interpolée) :
// la requête tapée par l'utilisateur peut contenir des apostrophes,
// guillemets, etc. (titres de morceaux) — un argv passé directement au
// process, sans interprétation shell, évite tout souci d'échappement ou
// d'injection.
export const searchYouTube = (query, maxResults = 25) => new Promise((resolve, reject) => {
  const args = [
    `ytsearch${maxResults}:${query}`,
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
  ];
  const proc = spawn("yt-dlp", args);
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (d) => { stdout += d; });
  proc.stderr.on("data", (d) => { stderr += d; });

  const timer = setTimeout(() => {
    proc.kill();
    reject(new Error("yt-dlp search timeout (20s)"));
  }, 20000);

  proc.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0 && !stdout.trim()) {
      return reject(new Error(`yt-dlp search failed (code ${code}): ${stderr.slice(-300)}`));
    }
    const MAX_DURATION_SEC = 7 * 60; // même règle que routes/youtube.js (API officielle)
    const results = stdout.trim().split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .map((item) => {
        const title = item.title || "Sans titre";
        const channel = item.channel || item.uploader || "";
        // "--flat-playlist" ne garantit pas toujours la durée (selon la page
        // de résultats YouTube) — null si absente, traité comme "durée
        // inconnue" (jamais marqué indisponible dans ce cas, pour ne pas
        // bloquer des résultats valides par manque de métadonnée).
        const durationSec = typeof item.duration === "number" ? item.duration : null;
        return {
          videoId: item.id,
          title,
          channel,
          thumbnail: item.thumbnails?.length
            ? item.thumbnails[item.thumbnails.length - 1].url
            : `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
          durationSec,
          // Cf. commentaire détaillé dans routes/youtube.js — même heuristique,
          // "- Topic" inclus (chaînes auto-générées YouTube depuis l'audio
          // officiel/Content ID d'un label).
          isOfficial: /\bofficial\b|\bvevo\b|clip officiel/i.test(title)
            || /\bofficial\b|\bvevo\b/i.test(channel)
            || /- topic$/i.test(channel.trim()),
          unavailable: durationSec != null && durationSec > MAX_DURATION_SEC,
          unavailableReason: durationSec != null && durationSec > MAX_DURATION_SEC
            ? `Trop long (${Math.round(durationSec / 60)} min, max 7 min)` : null,
        };
      })
      .sort((a, b) => (b.isOfficial ? 1 : 0) - (a.isOfficial ? 1 : 0));
    resolve(results);
  });

  proc.on("error", (err) => {
    clearTimeout(timer);
    reject(new Error(`yt-dlp search spawn error: ${err.message}`));
  });
});
