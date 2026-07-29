// ── Historique persistant des macheups générés (juillet 2026) ──────────────
// Bug corrigé : le panneau "Mes macheups" (frontend, MashupsBar.jsx) ne
// vivait QUE dans le state React de MashupStudio.jsx (`useState([])`) —
// jamais lu depuis le disque, jamais sauvegardé nulle part côté serveur.
// Résultat observé lors de l'audit du 2026-07-26 : après plusieurs
// générations réussies (fichiers bien présents sur le disque, vérifié
// directement), le panneau n'en affichait jamais qu'une seule — parce que
// CHAQUE rechargement de page (ou changement de vue) réinitialisait ce state
// à vide, et le bouton "↺ ACTUALISER" n'avait même pas de onClick (no-op).
//
// Ce module ajoute la persistance minimale qui manquait : un simple fichier
// JSON (pas besoin d'une table SQLite pour une liste d'URLs) mis à jour à
// CHAQUE mashup terminé avec succès (routes/mashup.js et
// routes/mashupMulti.js, sur le "status: done"), lu par une nouvelle route
// GET /api/mashups pour que le panneau retrouve tout son historique après un
// rechargement — et permettant aussi un vrai bouton de suppression (par
// entrée, ou "vider tout" pour l'utilisateur qui veut nettoyer le disque).
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../data");
const HISTORY_FILE = join(DATA_DIR, "mashups-history.json");
const outputsDir = join(__dirname, "../data/outputs");

mkdirSync(DATA_DIR, { recursive: true });

// Lecture tolérante : fichier absent, vide ou corrompu → liste vide plutôt
// que de faire planter le serveur (cet historique est un confort, jamais une
// source de vérité indispensable — les fichiers eux-mêmes sur le disque
// restent l'unique source fiable).
export const loadMashupHistory = () => {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const raw = readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("[mashupHistory] lecture impossible, historique repart vide :", e.message);
    return [];
  }
};

const saveMashupHistory = (list) => {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.warn("[mashupHistory] écriture impossible :", e.message);
  }
};

// Appelé juste après updateJob(jobId, { status: "done", ... }) dans
// routes/mashup.js (2 decks) et routes/mashupMulti.js (3-5 decks) — ajoute
// l'entrée EN TÊTE de liste (plus récent en premier, même ordre que
// l'ancien state React local qu'il remplace).
export const addMashupToHistory = ({ id, title, flacUrl, mp4Url, silentUrl }) => {
  const list = loadMashupHistory();
  const entry = { id, title: title || "MacheUp", flacUrl: flacUrl || null, mp4Url: mp4Url || null, silentUrl: silentUrl || null, createdAt: Date.now() };
  saveMashupHistory([entry, ...list.filter(m => m.id !== id)]);
  return entry;
};

// Résout une URL "/outputs/xxx.flac" en chemin absolu sûr (même garde
// anti-traversée que routes/mashup.js POST /cleanup) et supprime le fichier
// s'il existe — silencieux si déjà absent (jamais bloquant).
const deleteOutputFile = (url) => {
  if (!url) return;
  try {
    const filePath = join(outputsDir, basename(url));
    if (filePath.startsWith(outputsDir) && existsSync(filePath)) unlinkSync(filePath);
  } catch (e) {
    console.warn("[mashupHistory] échec suppression fichier :", url, e.message);
  }
};

// Supprime UNE entrée (bouton ✕ par carte, MashupsBar.jsx) : retire du JSON
// ET supprime réellement les fichiers FLAC/MP4/MP4 muet du disque — avant ce
// correctif, le bouton ✕ ne faisait que masquer la carte côté React, les
// fichiers restaient orphelins sur le disque indéfiniment.
export const removeMashupFromHistory = (id) => {
  const list = loadMashupHistory();
  const entry = list.find(m => m.id === id);
  if (entry) {
    deleteOutputFile(entry.flacUrl);
    deleteOutputFile(entry.mp4Url);
    deleteOutputFile(entry.silentUrl);
  }
  saveMashupHistory(list.filter(m => m.id !== id));
  return entry || null;
};

// Vide tout l'historique (nouveau bouton "🧹 Vider l'historique", retour
// utilisateur juillet 2026 : "prévoir un bouton nettoyage au cas où
// l'utilisateur veut effacer l'historique et le contenu") : supprime tous
// les fichiers listés puis vide le JSON.
export const clearMashupHistory = () => {
  const list = loadMashupHistory();
  for (const entry of list) {
    deleteOutputFile(entry.flacUrl);
    deleteOutputFile(entry.mp4Url);
    deleteOutputFile(entry.silentUrl);
  }
  saveMashupHistory([]);
  return list.length;
};
