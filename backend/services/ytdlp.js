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
      (client) => `yt-dlp --remote-components ejs:github --extractor-args "youtube:player_client=${client}" -f "bestaudio/best" --extract-audio --audio-format wav -o "${outputPath}" "${url}"`,
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

export const downloadVideo = async (videoId, outputPath) => {
  const cacheDir = join(CACHE_DIR, "video");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `${videoId}.mp4`);

  if (existsSync(cachePath)) {
    await copyFile(cachePath, outputPath);
    console.log(`[ytdlp] vidéo servie depuis le cache : ${videoId}`);
    return outputPath;
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    await runWithClientFallback(
      (client) => `yt-dlp --remote-components ejs:github --extractor-args "youtube:player_client=${client}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${outputPath}" "${url}"`,
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
          isOfficial: /\bofficial\b|\bvevo\b|clip officiel/i.test(title) || /\bofficial\b|\bvevo\b/i.test(channel),
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
