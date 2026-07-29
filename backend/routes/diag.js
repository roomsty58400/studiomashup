import express from "express";
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { _diagnostics } from "../services/dereverb.js";
import { _findSystemBrowserDiag } from "../services/ravedjAutomation.js";
import { extractAudio } from "../services/ffmpeg.js";
import { analyzeAudio } from "../services/analyzer.js";

const router = express.Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Diagnostic dé-reverb (audit perf juillet 2026) ────────────────────────
// Lecture seule, aucun effet de bord — appelé une fois pour confirmer en
// conditions réelles ce que les logs serveur ne montrent qu'en passant :
// le venv Python utilisé, si CUDA y est réellement détecté, et si le modèle
// UVR-DeEcho-DeReverb est bien déjà en cache local (sinon le premier appel
// paie aussi son téléchargement, ~100 Mo, en plus du calcul).
router.get("/dereverb", (req, res) => {
  const diag = _diagnostics();
  let modelFiles = [];
  try {
    modelFiles = readdirSync(diag.modelDir);
  } catch (e) {
    modelFiles = [`(erreur lecture : ${e.message})`];
  }
  res.json({
    ...diag,
    pythonBinExists: existsSync(diag.pythonBin),
    modelFiles,
  });
});

// ── Diagnostic Puppeteer (audit installation navigateur masqué) ───────────
// Lecture seule — permet de voir, DEPUIS LE PROCESS NODE RÉEL DU BACKEND (pas
// depuis un terminal interactif séparé, dont le HOME/USERPROFILE peut
// différer), le chemin exact que Puppeteer va tenter d'utiliser pour lancer
// Chrome, et si un fichier existe réellement à cet endroit — pour distinguer
// un vrai exécutable manquant d'un simple décalage de chemin de cache entre
// l'installation (npx, terminal interactif) et le serveur (nodemon).
router.get("/puppeteer", async (req, res) => {
  try {
    const os = await import("os");
    const path = await import("path");
    const { default: puppeteer } = await import("puppeteer");
    let executablePath = null;
    let executablePathError = null;
    try {
      executablePath = puppeteer.executablePath();
    } catch (e) {
      executablePathError = e.message;
    }
    // Vérification directe, indépendante de la logique interne de Puppeteer :
    // liste vraiment ce qu'il y a sur le disque à l'endroit attendu, pour
    // distinguer "vraiment absent" de "présent mais Puppeteer ne le voit
    // pas" (permissions, sous-dossier inattendu, etc.).
    const chromeCacheDir = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
    let cacheTree = null;
    try {
      cacheTree = readdirSync(chromeCacheDir).map((versionDir) => {
        const versionPath = path.join(chromeCacheDir, versionDir);
        let inner = [];
        try { inner = readdirSync(versionPath); } catch (e) { inner = [`(erreur: ${e.message})`]; }
        const nested = inner.map((sub) => {
          const subPath = path.join(versionPath, sub);
          let deepFiles = [];
          try { deepFiles = readdirSync(subPath); } catch (e) { deepFiles = [`(erreur: ${e.message})`]; }
          return { sub, deepFiles };
        });
        return { versionDir, inner: nested };
      });
    } catch (e) {
      cacheTree = `(erreur lecture ${chromeCacheDir} : ${e.message})`;
    }
    const systemBrowser = await _findSystemBrowserDiag();
    res.json({
      homedir: os.homedir(),
      cacheDirEnv: process.env.PUPPETEER_CACHE_DIR || null,
      systemBrowser,
      executablePath,
      executablePathError,
      executableExists: executablePath ? existsSync(executablePath) : null,
      chromeCacheDir,
      cacheTree,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analyse d'un rendu RaveDJ avec le VRAI analyseur Python de MacheUp ────
// Demande explicite ("validation rigoureuse") : au lieu de deviner le BPM/la
// clé/la structure d'un rendu RaveDJ via un DSP JavaScript approximatif
// (fait précédemment dans le chat, précis mais pas fiable), on télécharge le
// rendu CÔTÉ SERVEUR et on le fait passer par exactement le même pipeline
// que n'importe quel morceau de MacheUp (extractAudio + analyzeAudio,
// Librosa) — mesure fiable, directement comparable à ce que l'app calcule
// pour ses propres morceaux.
// Sécurité : même restriction que mediaProxy.js — uniquement rave.dj et ses
// sous-domaines, jamais un proxy de téléchargement ouvert.
const isAllowedRaveHost = (hostname) => hostname === "rave.dj" || hostname.endsWith(".rave.dj");

router.post("/analyze-ravedj", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Paramètre 'url' requis" });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "URL invalide" });
  }
  if (!isAllowedRaveHost(parsed.hostname)) {
    return res.status(403).json({ error: `Domaine non autorisé (rave.dj uniquement) : ${parsed.hostname}` });
  }

  const tmpDir = join(__dirname, "../tmp", `ravedj-analyze-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const mp4Path = join(tmpDir, "input.mp4");
  const wavPath = join(tmpDir, "audio.wav");

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(502).json({ error: `Téléchargement du rendu RaveDJ échoué (HTTP ${upstream.status})` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    writeFileSync(mp4Path, buf);

    await extractAudio(mp4Path, wavPath);
    const analysis = await analyzeAudio(wavPath);
    res.json({ url, fileSizeBytes: buf.length, ...analysis });
  } catch (e) {
    res.status(500).json({ error: `Analyse impossible : ${e.message}` });
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

export default router;
