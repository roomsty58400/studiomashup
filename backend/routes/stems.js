import express from "express";
import { v4 as uuidv4 } from "uuid";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { copyFile, rename, rm } from "fs/promises";
import { downloadAudio } from "../services/ytdlp.js";
import { extractAudio, getCachedInstrumental, normalizeStemLoudness } from "../services/ffmpeg.js";
import { separateStems } from "../services/demucs.js";
import { getTrack } from "../db/index.js";
import { registerJobCleanup } from "../services/jobCleanup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TMP_DIR = join(__dirname, "../tmp");
const OUT_DIR = join(__dirname, "../data/outputs/stems");
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ── Jobs en mémoire (même pattern que routes/mashup.js et routes/clipEditor.js) ──
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });
registerJobCleanup(jobs, { label: "[stems]" });

// ── Verrou anti-doublon (généralisé lors de l'audit de juillet 2026, même
// principe que routes/mashup.js/analyze.js) — chaque job écrit dans son
// propre dossier (OUT_DIR/<jobId>/), donc pas de collision d'ÉCRITURE
// possible, mais sans verrou un double-clic sur "Extraire voix"/"Extraire
// instru" relance quand même une 2e séparation Demucs COMPLÈTE en parallèle
// pour le même morceau (GPU gaspillé en double) le temps que la 1ère finisse.
const activeStems = new Map(); // videoId -> jobId
const isJobActive = (id) => {
  const job = jobs.get(id);
  return !!job && job.status !== "done" && job.status !== "error";
};

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

const ANALYZE_OUT_DIR = join(__dirname, "../data/outputs");
const toAbsolute = (url) => join(ANALYZE_OUT_DIR, url.replace(/^\/outputs\//, ""));

// ── Égalisation de niveau voix/instru (export FLAC) ──
// Demucs ne garantit aucun équilibre de niveau entre stems séparés — sans
// ça, la voix exportée peut sonner nettement plus (ou moins) forte que
// l'instru une fois téléchargée séparément, selon le mix d'origine.
// normalizeStemLoudness (2-passes, cible -16 LUFS commune) appliqué aux DEUX
// fichiers : ffmpeg ne peut pas écrire dans son propre fichier d'entrée, donc
// on passe par un fichier temporaire puis on remplace l'original en place —
// même nom/URL, rien à changer côté frontend. Jamais bloquant : un échec
// (ffmpeg absent, etc.) laisse simplement le niveau d'origine.
const tryNormalizeLevel = async (filePath, jobTmp, label) => {
  const tmpOut = join(jobTmp, `normalized-${label}${extname(filePath)}`);
  try {
    await normalizeStemLoudness(filePath, tmpOut);
    await copyFile(tmpOut, filePath);
    console.log(`✅ [stems] niveau (${label}) normalisé à -16 LUFS`);
  } catch (err) {
    console.warn(`⚠️ [stems] normalisation de niveau (${label}) échouée, repli sur le niveau brut :`, err.message);
  } finally {
    await rm(tmpOut, { force: true }).catch(() => {});
  }
};

// ── Démarre l'extraction voix/instru (FLAC) d'une vidéo YouTube — utilisé
// par les 2 boutons "Extraire voix" / "Extraire instru" sous le lecteur des
// Decks A/B.
//
// Optimisation "gagner du temps" : si le morceau a déjà été analysé via
// /api/analyze (4 stems vocals/drums/bass/other, cf. db/index.js), on NE
// RELANCE PAS Demucs une 2e fois pour le même audio — la voix est déjà
// disponible telle quelle, et l'instrumental se déduit en recombinant
// drums+bass+other (un simple amix ffmpeg, ~1s, pas de GPU). Sinon
// (analyse pas encore faite/pas encore terminée), on retombe sur la
// séparation 2-stems indépendante comme avant.
router.post("/start", async (req, res) => {
  const { videoId, title = "track" } = req.body;
  if (!videoId) return res.status(400).json({ error: "videoId requis" });

  // Verrou anti-doublon — cf. commentaire sur activeStems plus haut.
  const runningJobId = activeStems.get(videoId);
  if (runningJobId && isJobActive(runningJobId)) {
    console.log(`[stems] ${videoId} : extraction déjà en cours (job ${runningJobId}) — pas de second lancement`);
    return res.json({ jobId: runningJobId });
  }

  const jobId = uuidv4();
  const jobTmp = join(TMP_DIR, `stems-${jobId}`);
  const jobOut = join(OUT_DIR, jobId);
  mkdirSync(jobTmp, { recursive: true });
  mkdirSync(jobOut, { recursive: true });

  activeStems.set(videoId, jobId);
  res.json({ jobId });
  updateJob(jobId, { status: "running", title });

  (async () => {
    try {
      // Vérifie que les fichiers stems référencés en base EXISTENT VRAIMENT
      // sur le disque avant de faire confiance au cache. Sans ce garde-fou,
      // une ligne SQLite qui pointe vers des fichiers disparus (nettoyage
      // manuel de data/outputs/analyze/, disque plein, etc.) fait planter
      // copyFile avec un ENOENT non récupérable — alors qu'un simple repli
      // sur la séparation Demucs complète (ci-dessous) aurait suffi. Le cache
      // sert à ÉVITER un re-traitement, pas à provoquer un échec dur quand
      // il est périmé.
      //
      // Dépend du mode de séparation utilisé pour ce morceau (cf. sélecteur
      // 2/4 stems, routes/analyze.js) : en mode "2", vocals_path +
      // instrumental_path sont DÉJÀ exactement voix+instru, rien à combiner.
      // En mode "4", l'instrumental se déduit en recombinant TOUS les stems
      // non-vocaux du mode (drums+bass+other) — un simple amix ffmpeg, pas
      // de GPU. (Le mode 6 stems, avec guitar/piano en plus, a été retiré en
      // juillet 2026 — cf. services/demucs.js.)
      const analyzed = getTrack(videoId);
      const stemMode = analyzed?.stem_mode ? Number(analyzed.stem_mode) : null;
      const nonVocalCols = stemMode === 2 ? null
        : ["drums_path", "bass_path", "other_path"]; // mode 4 (ou ancien cache sans stem_mode)

      let cacheUsable = false;
      if (analyzed?.vocals_path) {
        if (stemMode === 2 && analyzed.instrumental_path) {
          cacheUsable = existsSync(toAbsolute(analyzed.vocals_path)) && existsSync(toAbsolute(analyzed.instrumental_path));
        } else if (nonVocalCols && nonVocalCols.every(c => analyzed[c])) {
          cacheUsable = [analyzed.vocals_path, ...nonVocalCols.map(c => analyzed[c])].every(p => existsSync(toAbsolute(p)));
        }
      }
      if (analyzed?.vocals_path && !cacheUsable) {
        console.warn(`[stems] ${videoId} : cache SQLite présent mais fichier(s) manquant(s)/incomplet(s) sur le disque — repli sur une séparation Demucs complète`);
      }
      if (cacheUsable) {
        console.log(`[stems] ${videoId} déjà analysé (mode ${stemMode || 4} stems) — dérivation instantanée (pas de 2e Demucs)`);
        const vocalsSrc = toAbsolute(analyzed.vocals_path);
        const vocalsName = "vocals" + extname(vocalsSrc);
        const instruName = "instrumental.flac";
        await copyFile(vocalsSrc, join(jobOut, vocalsName));
        if (stemMode === 2) {
          // Déjà un instrumental complet, rien à combiner.
          await copyFile(toAbsolute(analyzed.instrumental_path), join(jobOut, instruName));
        } else {
          // getCachedInstrumental : ne relance l'amix ffmpeg que la 1ère fois
          // pour ce morceau — les appels suivants réutilisent le fichier déjà
          // combiné, mis en cache à côté des stems (cf. services/ffmpeg.js).
          const combinedInstru = await getCachedInstrumental(...nonVocalCols.map(c => toAbsolute(analyzed[c])));
          await copyFile(combinedInstru, join(jobOut, instruName));
        }
        await Promise.all([
          tryNormalizeLevel(join(jobOut, vocalsName), jobTmp, "voix"),
          tryNormalizeLevel(join(jobOut, instruName), jobTmp, "instru"),
        ]);
        updateJob(jobId, {
          status: "done",
          vocals: `/outputs/stems/${jobId}/${vocalsName}`,
          instrumental: `/outputs/stems/${jobId}/${instruName}`,
        });
        console.log(`✅ [stems] ${jobId} dérivé instantanément depuis l'analyse`);
        return;
      }

      const audioBase = join(jobTmp, "raw");
      await downloadAudio(videoId, audioBase);

      const exts = [".wav", ".opus", ".webm", ".m4a", ".mp3", ".ogg", ".flac", ".aac"];
      const rawAudio = exts.map(e => audioBase + e).find(p => existsSync(p));
      if (!rawAudio) throw new Error("Audio introuvable après téléchargement");

      const wav = join(jobTmp, "audio.wav");
      await extractAudio(rawAudio, wav);

      const stemsTmp = join(jobTmp, "stems");
      const { vocals, instrumental } = await separateStems(wav, stemsTmp);

      const vocalsName = "vocals" + extname(vocals);
      const instruName = "instrumental" + extname(instrumental);
      // rename() plutôt que copyFile() : la source vient d'un dossier tmp
      // jetable (stemsTmp, supprimé dans le "finally" plus bas) et n'est plus
      // utilisée après ce point — un déplacement (même disque) est quasi
      // instantané, contrairement à une copie qui réécrit tout le fichier
      // (potentiellement plusieurs dizaines de Mo en FLAC) sur le disque.
      await rename(vocals, join(jobOut, vocalsName));
      await rename(instrumental, join(jobOut, instruName));

      await Promise.all([
        tryNormalizeLevel(join(jobOut, vocalsName), jobTmp, "voix"),
        tryNormalizeLevel(join(jobOut, instruName), jobTmp, "instru"),
      ]);

      updateJob(jobId, {
        status: "done",
        vocals: `/outputs/stems/${jobId}/${vocalsName}`,
        instrumental: `/outputs/stems/${jobId}/${instruName}`,
      });
      console.log(`✅ [stems] séparation ${jobId} terminée`);
    } catch (err) {
      console.error(`❌ [stems] séparation ${jobId} échouée :`, err.message);
      updateJob(jobId, { status: "error", message: err.message });
    } finally {
      await rm(jobTmp, { recursive: true, force: true }).catch(() => {});
      // Libère le verrou (uniquement si c'est toujours CE job qui le détient).
      if (activeStems.get(videoId) === jobId) activeStems.delete(videoId);
    }
  })();
});

// ── Téléchargement forcé (Content-Disposition fixé côté serveur) ──
// L'attribut HTML "download" est ignoré par le navigateur en cross-origin
// (frontend Vite / backend Express sur des ports différents) — même
// solution que /:id/video-silent dans routes/clipEditor.js.
router.get("/:id/download/:which", (req, res) => {
  const { id, which } = req.params;
  const job = jobs.get(id);
  if (!job || job.status !== "done") return res.status(404).json({ error: "Stem introuvable ou pas encore prêt." });

  const url = which === "vocals" ? job.vocals : which === "instrumental" ? job.instrumental : null;
  if (!url) return res.status(400).json({ error: "Paramètre 'which' invalide (vocals|instrumental)." });

  const filePath = toAbsolute(url);
  if (!existsSync(filePath)) return res.status(404).json({ error: "Fichier introuvable sur le serveur." });

  const safeTitle = (job.title || "track").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "track";
  const label = which === "vocals" ? "voix" : "instru";
  const ext = filePath.slice(filePath.lastIndexOf("."));
  res.download(filePath, `${safeTitle} (${label})${ext}`);
});

export default router;
