import express from "express";
import { v4 as uuidv4 } from "uuid";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { fetchNowPlayingTitle } from "../services/icyMetadata.js";
import { assertPublicHttpUrl, assertResolvesToPublicIp } from "../services/urlSafety.js";
import { registerJobCleanup } from "../services/jobCleanup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Cache court par flux — évite d'ouvrir une nouvelle connexion ICY à
// chaque tick du carrousel frontend (polling ~15s) si plusieurs onglets/decks
// interrogent la même station en même temps.
const CACHE_TTL = 12 * 1000;
const cache = new Map(); // url -> { title, ts }

// ── "Dernier titre connu" avec une fenêtre de grâce plus large que le cache
// ci-dessus ──
// Beaucoup de serveurs ICY (Icecast/Shoutcast) n'annoncent le StreamTitle
// QU'UNE FOIS au moment du changement de morceau, puis renvoient des blocs
// meta vides jusqu'au morceau suivant. Notre parsing ICY ouvre une NOUVELLE
// connexion à chaque sondage (cf. services/icyMetadata.js) — si cette
// connexion démarre en plein milieu d'un morceau (le cas le plus fréquent),
// elle ne recevra jamais l'annonce déjà passée, même si le morceau n'a pas
// changé. Résultat observé : le titre apparaît puis disparaît sans raison
// ("ne s'affiche pas systématiquement"), alors que rien n'a réellement
// changé côté radio. On lisse ça en gardant le dernier titre RÉELLEMENT
// obtenu pendant 90s : un sondage qui échoue entre-temps réutilise ce
// dernier titre connu plutôt que d'afficher/cacher le carrousel pour rien.
const STICKY_TTL = 90 * 1000;
const lastGood = new Map(); // url -> { title, ts }

router.get("/now-playing", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Paramètre url manquant." });
  // Garde-fou anti-SSRF (audit juillet 2026) : cette route accepte une URL
  // de flux radio arbitraire et fait une requête HTTP sortante avec —
  // n'importe quelle page web ouverte dans le même navigateur pourrait
  // sinon déclencher un scan du réseau local via une simple <img src=...>.
  // Cf. services/urlSafety.js pour le détail du raisonnement. 2 contrôles :
  // la chaîne d'URL (synchrone) puis la résolution DNS réelle (2e passe,
  // anti-rebinding statique).
  try {
    assertPublicHttpUrl(url);
    await assertResolvesToPublicIp(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ title: cached.title });
  }

  const stickyTitle = () => {
    const sticky = lastGood.get(url);
    return sticky && Date.now() - sticky.ts < STICKY_TTL ? sticky.title : null;
  };

  try {
    // Essaie dans l'ordre : API laut.fm (si applicable) → status-json.xsl
    // Icecast → parsing ICY brut en dernier recours. Cf.
    // services/icyMetadata.js pour le détail — le brut ICY est le plus
    // fragile des 3 (en-têtes souvent filtrées par un CDN/reverse-proxy, ET
    // sujet au problème d'annonce unique décrit ci-dessus).
    const title = await fetchNowPlayingTitle(url, 10000);
    if (title) {
      cache.set(url, { title, ts: Date.now() });
      lastGood.set(url, { title, ts: Date.now() });
      return res.json({ title });
    }
    const fallback = stickyTitle();
    cache.set(url, { title: fallback, ts: Date.now() });
    res.json({ title: fallback });
  } catch (e) {
    // Pas grave si une station ne supporte aucune des 3 méthodes — on
    // répond juste "pas de titre" plutôt qu'une erreur bruyante côté UI,
    // mais on logue la vraie raison ici (terminal backend) pour pouvoir
    // diagnostiquer au cas par cas quelle station pose problème et pourquoi.
    console.warn(`[radio] titre indisponible pour ${url} : ${e.message}`);
    const fallback = stickyTitle();
    cache.set(url, { title: fallback, ts: Date.now() });
    res.json({ title: fallback, reason: e.message });
  }
});

// ── Enregistrement du morceau en cours (bouton ⏺ à côté du carrousel) ──────
//
// Capture le flux radio LIVE tel quel (-c copy, aucun ré-encodage : le flux
// Icecast/Shoutcast est déjà en MP3, on ne fait que l'écrire sur disque) vers
// un fichier .mp3, démarré/arrêté manuellement par l'utilisateur — il n'existe
// aucun moyen fiable de détecter automatiquement le DÉBUT exact d'un morceau
// déjà en cours de diffusion, donc "enregistrer le morceau qui passe" se fait
// comme sur un vrai poste radio : on appuie sur enregistrer pendant qu'il
// joue, on arrête quand on veut.
const RECORD_DIR = join(__dirname, "../data/outputs/radio-recordings");
mkdirSync(RECORD_DIR, { recursive: true });

// Garde-fou : coupe automatiquement au bout de 20 min si l'utilisateur oublie
// d'arrêter — évite un fichier/processus qui grossit indéfiniment.
const MAX_RECORD_SEC = 20 * 60;

const recordings = new Map(); // id -> { proc, status, filePath, fileName, title, startedAt, error }
// Purge des enregistrements terminés (done/error) — cette Map n'a pas de champ
// "updatedAt" (contrairement au pattern jobs/updateJob des autres routes) :
// on retombe sur "startedAt", suffisant ici (un enregistrement dure au plus
// MAX_RECORD_SEC = 20 min, largement sous le délai de grâce de purge).
registerJobCleanup(recordings, { label: "[radio-recordings]", getUpdatedAt: (job) => job.startedAt });

router.post("/record/start", async (req, res) => {
  const { url, title } = req.body || {};
  if (!url) return res.status(400).json({ error: "url requise" });
  // Même garde-fou anti-SSRF que /now-playing — d'autant plus important ici
  // puisque cette route lance un vrai processus ffmpeg qui écrit sur le
  // disque local le contenu de l'URL fournie. 2 contrôles : la chaîne d'URL
  // (synchrone) puis la résolution DNS réelle (2e passe, anti-rebinding
  // statique).
  try {
    assertPublicHttpUrl(url);
    await assertResolvesToPublicIp(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const id = uuidv4();
  const safeTitle = (title || "radio").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "radio";
  const fileName = `${safeTitle} - ${id.slice(0, 8)}.mp3`;
  const filePath = join(RECORD_DIR, fileName);

  // -c copy : pas de ré-encodage (le flux est déjà en MP3) — écriture quasi
  // instantanée, aucune perte de qualité, aucune charge CPU. -t en garde-fou
  // dur si jamais l'arrêt manuel (ci-dessous) échouait pour une raison ou une
  // autre.
  const args = ["-y", "-i", url, "-c", "copy", "-t", String(MAX_RECORD_SEC), filePath];
  const proc = spawn("ffmpeg", args);
  let stderrTail = "";
  proc.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-500); });

  const rec = { proc, status: "recording", filePath, fileName, title: safeTitle, startedAt: Date.now(), error: null };
  recordings.set(id, rec);

  proc.on("close", (code) => {
    const r = recordings.get(id);
    if (!r) return;
    // Un arrêt demandé via /stop (statut déjà passé à "stopping") est
    // toujours traité comme un succès, quel que soit le code de sortie —
    // ffmpeg renvoie souvent un code non-nul quand on met fin au flux
    // d'entrée nous-mêmes, sans que ce soit une vraie erreur.
    if (r.status === "stopping" || code === 0) {
      r.status = existsSync(filePath) ? "done" : "error";
      if (r.status === "error") r.error = "Fichier introuvable après l'enregistrement.";
    } else {
      r.status = "error";
      r.error = stderrTail || `ffmpeg a quitté avec le code ${code}`;
    }
  });
  proc.on("error", (e) => {
    const r = recordings.get(id);
    if (r) { r.status = "error"; r.error = e.message; }
  });

  res.json({ recordingId: id });
});

router.post("/record/:id/stop", (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "Enregistrement introuvable." });
  if (rec.status === "recording") {
    rec.status = "stopping";
    // "q" sur stdin : façon propre de demander à ffmpeg de finaliser le
    // fichier de sortie (mux correct) plutôt qu'un kill brutal qui peut
    // laisser un .mp3 tronqué/invalide.
    try {
      rec.proc.stdin.write("q");
    } catch {
      rec.proc.kill("SIGINT");
    }
    // Filet de sécurité : si ffmpeg n'a pas réagi à "q" (cas rare), on force
    // l'arrêt après un court délai plutôt que de laisser l'enregistrement
    // bloqué indéfiniment sur "stopping".
    setTimeout(() => {
      const r = recordings.get(req.params.id);
      if (r && r.status === "stopping") r.proc.kill("SIGKILL");
    }, 5000);
  }
  res.json({ ok: true });
});

router.get("/record/:id/status", (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "Enregistrement introuvable." });
  res.json({
    status: rec.status,
    error: rec.error,
    elapsedSec: Math.round((Date.now() - rec.startedAt) / 1000),
  });
});

router.get("/record/:id/download", (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec || rec.status !== "done") return res.status(404).json({ error: "Enregistrement pas encore prêt." });
  if (!existsSync(rec.filePath)) return res.status(404).json({ error: "Fichier introuvable sur le serveur." });
  res.download(rec.filePath, `${rec.title} (radio).mp3`);
});

export default router;
