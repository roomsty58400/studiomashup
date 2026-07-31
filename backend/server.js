import "./loadEnv.js"; // DOIT rester le tout premier import — cf. commentaire dans ce fichier
import express from "express";
import cors from "cors";
import session from "express-session";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { randomBytes } from "crypto";

import youtubeRoutes from "./routes/youtube.js";
import mashupRoutes from "./routes/mashup.js";
import authRoutes, { passport } from "./routes/auth.js";
import promptRoutes from "./routes/prompt.js";
import lyricsRoutes from "./routes/lyrics.js";
import coverRoutes from "./routes/cover.js";
import titlesRoutes from "./routes/titles.js";
import recognizeRoutes from "./routes/recognize.js";
import clipEditorRoutes from "./routes/clipEditor.js";
import stemsRoutes from "./routes/stems.js";
import analyzeRoutes from "./routes/analyze.js";
import radioRoutes from "./routes/radio.js";
import mashupWheelRoutes from "./routes/mashupWheel.js";
// Phase 5 (juillet 2026) : mashup multi-sources (3-5 morceaux), route
// backend "d'abord" (pas encore d'interface) — cf. en-tête de
// routes/mashupMulti.js. Préfixe dédié "/api/mashup-multi", volontairement
// PAS "/api/mashup", pour zéro risque de collision avec les routes
// existantes de routes/mashup.js (cf. commentaire détaillé là-bas).
import mashupMultiRoutes from "./routes/mashupMulti.js";
import extRoutes from "./routes/ext.js";
import diagRoutes from "./routes/diag.js";
import ravedjAutoRoutes from "./routes/ravedjAuto.js";
import mediaProxyRoutes from "./routes/mediaProxy.js";
import mashupsHistoryRoutes from "./routes/mashups.js";
import macheupdjRoutes from "./routes/macheupdj.js";
import albumArtRoutes from "./routes/coverart.js";
import pdfTextRoutes from "./routes/pdfText.js";
import playlistPromptRoutes from "./routes/playlistPrompt.js";
import { cleanupMediaFiles } from "./services/cleanup.js";
import { shutdownAllWorkers } from "./services/workerPool.js";

if (!process.env.AUDD_API_KEY) {
  console.warn(
    "⚠️  AUDD_API_KEY manquante dans backend/.env — la reconnaissance Shazam tournera sur le quota anonyme d'AudD (très limité, vite épuisé : \"authorization failed: no api_token passed and the limit was reached\"). Clé gratuite sur https://dashboard.audd.io puis ajouter AUDD_API_KEY=... dans .env."
  );
}

// ── Secret de session (audit juillet 2026) ────────────────────────────────
// Utilisé par express-session pour signer le cookie de session (login Google
// via Passport). Auparavant : repli silencieux sur une valeur codée en dur
// ("studiomashup-secret-local") si SESSION_SECRET absent de .env — un secret
// connu de quiconque lit le code n'apporte aucune protection réelle au cookie
// signé. Génère désormais un secret aléatoire à CHAQUE démarrage du process
// si SESSION_SECRET n'est pas défini : les sessions ne survivent plus à un
// redémarrage (re-login Google nécessaire), mais le cookie émis pendant la
// durée de vie du process est correctement protégé. Pour des sessions qui
// survivent aux redémarrages, définir SESSION_SECRET=<chaîne aléatoire
// longue> dans backend/.env (ex: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET manquante dans backend/.env — secret aléatoire généré pour cette session serveur uniquement (toutes les connexions Google seront invalidées au prochain redémarrage). Pour éviter ça, ajouter SESSION_SECRET=<chaîne aléatoire longue> dans .env."
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Créer les dossiers nécessaires au démarrage
["tmp", "tmp/a", "tmp/b", "tmp/mixed", "data/outputs", "data/outputs/clip-editor", "data/outputs/stems", "data/outputs/analyze", "data/outputs/macheupdj"].forEach(d =>
  mkdirSync(join(__dirname, d), { recursive: true })
);

// ── Nettoyage média : fermeture UNIQUEMENT (plus au démarrage) ───────────
// Supprime tout .mp3/.flac/.mp4 sous tmp/, data/outputs/ et cache/ (mashups
// générés, stems dérivés, vidéos/audio yt-dlp en cache) — tout est
// régénérable, rien n'est une source. But : éviter l'accumulation de Go de
// fichiers au fil des sessions de test (cf. services/cleanup.js).
//
// RETIRÉ du démarrage (2026-07-05) : un nettoyage à ce moment-là supprime les
// stems/instrumentaux/vidéos déjà séparés lors de la session précédente —
// exactement ce dont la base SQLite (db/index.js) pense encore disposer
// (bpm/camelot/vocals_path... restent en base, seuls les FICHIERS
// disparaissent). Sur Windows, fermer la fenêtre du backend au lieu de faire
// Ctrl+C ne délivre pas toujours SIGINT (cf. note plus bas) — le nettoyage de
// FERMETURE ne s'exécute donc pas systématiquement, et c'était alors celui du
// DÉMARRAGE SUIVANT qui finissait par tout supprimer, juste au moment où
// l'utilisateur relance l'app pour reprendre son travail (ex: recharger un
// morceau déjà analysé depuis Mashup Wheel vers MacheUp) — un aller-retour
// qui redevenait lent/bloqué (re-séparation Demucs complète) alors qu'il
// aurait dû être instantané. Le nettoyage à la FERMETURE (ci-dessous) reste
// en place : il s'exécute au bon moment (fin de session), pas au pire.
const MEDIA_CLEANUP_DIRS = ["tmp", "data/outputs", "cache"].map(d => join(__dirname, d));

// NOTE Windows : un Ctrl+C dans la fenêtre du backend déclenche bien SIGINT
// (nettoyage garanti). Fermer directement la fenêtre (croix) ne délivre pas
// toujours ce signal au process Node — limite de la plateforme, pas de ce
// code — auquel cas seul le nettoyage du PROCHAIN démarrage s'appliquera.
// BUG CORRIGÉ (2026-07-25) : le nettoyage ci-dessous s'exécutait aussi bien
// sur SIGINT (Ctrl+C, arrêt VOULU) que sur SIGTERM — sauf que `npm run dev`
// tourne avec `node --watch`, qui envoie justement un SIGTERM au process pour
// le redémarrer À CHAQUE sauvegarde d'un fichier backend (server.js/routes/
// services/db/api). Résultat en conditions réelles : chaque édition faite
// pendant cette session de dev déclenchait un redémarrage silencieux qui
// effaçait TOUS les stems Demucs déjà séparés et mashups déjà générés (cf.
// cleanupMediaFiles sur tmp/data/outputs/cache), alors que la base SQLite
// (db/index.js) gardait les anciens chemins en cache — d'où l'aperçu stems
// (ComboPanel) qui se met soudain à échouer ("fichier manquant ou périmé")
// sur des morceaux pourtant déjà "analysés" côté interface. Un vrai arrêt
// volontaire (Ctrl+C) reste couvert par SIGINT ; SIGTERM se contente
// désormais d'arrêter proprement les workers Python (nécessaire à chaque
// redémarrage --watch, sans quoi ils s'accumuleraient en zombies) SANS
// supprimer aucun média.
let cleaningUp = false;
const cleanupAndExit = (signal, { wipeMedia }) => {
  if (cleaningUp) return;
  cleaningUp = true;
  if (wipeMedia) {
    console.log(`\n🧹 Arrêt (${signal}) — nettoyage des fichiers .mp3/.flac/.mp4...`);
    cleanupMediaFiles(MEDIA_CLEANUP_DIRS, "fermeture");
  } else {
    console.log(`\n↻ Redémarrage (${signal}) — arrêt des workers sans purge média...`);
  }
  // Arrête proprement les workers Python persistants (Demucs, etc. — cf.
  // services/workerPool.js) : ce sont des process ENFANTS indépendants du
  // process Node, ils ne se terminent pas tout seuls avec lui sur Windows.
  shutdownAllWorkers();
  process.exit(0);
};
process.on("SIGINT", () => cleanupAndExit("SIGINT", { wipeMedia: true }));
process.on("SIGTERM", () => cleanupAndExit("SIGTERM", { wipeMedia: false }));

// ── Filet de sécurité process-wide (retour utilisateur juillet 2026) ────
// Constaté en test live : un mashup en mode "superposition complète" a fait
// disparaître TOUT l'état en mémoire (le job en cours ET tout autre job/deck
// en parallèle) — le serveur a répondu 503 puis 404 sur un jobId qui existait
// pourtant l'instant d'avant, signe d'un redémarrage complet du process. Le
// gros try/catch de chaque job (cf. routes/mashup.js, ligne "} catch (err)")
// protège déjà contre une erreur PRÉVISIBLE (ffmpeg qui échoue, fichier
// manquant...), mais Node tue immédiatement tout le process sur la moindre
// exception ou rejet de Promise qui s'échappe SANS être capturé nulle part
// (ex : un event "error" sur un enfant spawn() sans listener, un throw dans
// un .then() oublié...) — un seul job mal formé peut alors couper TOUS les
// autres en cours, avec node --watch qui relance ensuite un process tout
// neuf, jobs Map vidée, requêtes en vol perdues. Plutôt que de laisser Node
// planter tout le serveur pour la moindre fuite de ce genre (souvent dans une
// dépendance tierce difficile à auditer intégralement), on journalise ici et
// on laisse le serveur VIVRE — cohérent avec le principe déjà appliqué au
// niveau de chaque job (jamais bloquant les uns pour les autres) mais élevé
// ici au niveau du process entier. Rien n'est parfait (l'état interne peut
// être incohérent après une exception vraiment inattendue), mais pour cette
// appli (jobs indépendants, pas de transaction critique partagée), rester en
// vie et laisser CE job spécifique planter/timeout côté client vaut mieux que
// tout couper pour tout le monde.
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException (le serveur reste en vie) :", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection (le serveur reste en vie) :", reason);
});

const app = express();

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());

// Session (requis pour Passport)
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 jours
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Servir les fichiers générés
app.use("/outputs", express.static(join(__dirname, "data/outputs")));

app.use("/api/youtube", youtubeRoutes);
app.use("/api/mashup", mashupRoutes);
app.use("/api/mashups", mashupsHistoryRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/prompt", promptRoutes);
app.use("/api/lyrics", lyricsRoutes);
app.use("/api/cover", coverRoutes);
app.use("/api/titles", titlesRoutes);
app.use("/api/recognize", recognizeRoutes);
app.use("/api/clip-editor", clipEditorRoutes);
app.use("/api/stems", stemsRoutes);
app.use("/api/analyze", analyzeRoutes);
app.use("/api/radio", radioRoutes);
app.use("/api/mashup-wheel", mashupWheelRoutes);
app.use("/api/mashup-multi", mashupMultiRoutes);
app.use("/api/ext", extRoutes);
app.use("/api/diag", diagRoutes);
app.use("/api/ravedj-auto", ravedjAutoRoutes);
app.use("/api/media-proxy", mediaProxyRoutes);
app.use("/api/macheupdj", macheupdjRoutes);
app.use("/api/album-art", albumArtRoutes);
app.use("/api/pdf-text", pdfTextRoutes);
app.use("/api/playlist-prompt", playlistPromptRoutes);

app.get("/api/health", (_, res) => res.json({ status: "ok" }));

// ── Nettoyage manuel à la demande (bouton 🧹 du Mixer) ────────────────────
// Même balayage que le nettoyage de FERMETURE ci-dessus (mêmes dossiers,
// même fonction), mais déclenchable à tout moment par l'utilisateur — utile
// pour repartir sur une base propre entre 2 créations de mashup sans avoir à
// couper/relancer le serveur. Volontairement PAS branché sur l'interrupteur
// ON/OFF des Decks A/B (qui n'efface déjà que les fichiers du macheup EN
// COURS, cf. /api/mashup/cleanup) : un bouton séparé évite qu'une simple
// coupure de deck ne déclenche par surprise un balayage complet de
// data/outputs/analyze/ (le cache persistant BPM/clé/stems par morceau,
// cf. services/cleanup.js) et ne force une ré-analyse Demucs de TOUS les
// morceaux déjà traités, pas seulement la paire en cours.
app.post("/api/cleanup", (req, res) => {
  console.log("🧹 Nettoyage manuel demandé (bouton Mixer)...");
  const stats = cleanupMediaFiles(MEDIA_CLEANUP_DIRS, "manuel");
  res.json({ ok: true, ...stats });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
