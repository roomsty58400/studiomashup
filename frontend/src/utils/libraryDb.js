// ─── Persistance de la bibliothèque MACHEUPDJ (IndexedDB) ──────────────────
// Mémorise le FileSystemDirectoryHandle du dossier choisi une fois (File
// System Access API) pour ne pas avoir à le re-sélectionner à chaque
// session, + un petit cache des résultats d'analyse BPM/clé déjà obtenus
// (évite un aller-retour serveur à chaque réouverture de la page, même si
// le serveur a lui-même déjà tout en cache SQLite — cf. backend/analyze.js).
// localStorage ne peut PAS stocker un FileSystemDirectoryHandle (ce n'est
// pas une valeur sérialisable en JSON) — IndexedDB, lui, sait stocker des
// objets structurés-clonables, ce qui inclut ces handles.

const DB_NAME = "macheupdj-library";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const ANALYSIS_STORE = "analysis";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      if (!db.objectStoreNames.contains(ANALYSIS_STORE)) db.createObjectStore(ANALYSIS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(store, key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const saveLibraryHandle = (handle) => idbSet(HANDLE_STORE, "root", handle);
export const loadLibraryHandle = () => idbGet(HANDLE_STORE, "root");

// Clé = chemin relatif + taille + date de modification — assez stable pour
// éviter un faux cache-hit si le fichier a changé sur le disque, sans avoir
// à hasher tout le contenu côté navigateur (le serveur, lui, hashe déjà le
// contenu pour SON propre cache — ceci n'est qu'un raccourci local pour
// éviter même l'aller-retour réseau).
const analysisKey = (relPath, file) => `${relPath}|${file.size}|${file.lastModified}`;
export const getCachedAnalysis = (relPath, file) => idbGet(ANALYSIS_STORE, analysisKey(relPath, file));
export const setCachedAnalysis = (relPath, file, data) => idbSet(ANALYSIS_STORE, analysisKey(relPath, file), data);
