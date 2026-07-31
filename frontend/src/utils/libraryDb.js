import { readAudioTags } from "./audioTags.js";

// ─── Persistance de la bibliothèque MACHEUPDJ / DJPLAYLIST (IndexedDB) ─────
// Mémorise le FileSystemDirectoryHandle du dossier choisi une fois (File
// System Access API) pour ne pas avoir à le re-sélectionner à chaque
// session, + 2 petits caches locaux : les tags lus (titre/artiste/pochette)
// et les résultats d'analyse BPM/clé déjà obtenus — évite de tout relire/
// ré-analyser à chaque réouverture de la page, même si le serveur a lui-même
// déjà tout en cache SQLite pour l'analyse (cf. backend/routes/analyze.js).
// localStorage ne peut PAS stocker un FileSystemDirectoryHandle (ce n'est
// pas une valeur sérialisable en JSON) — IndexedDB, lui, sait stocker des
// objets structurés-clonables, ce qui inclut ces handles.

const DB_NAME = "macheupdj-library";
const DB_VERSION = 2; // v2 : + TAGS_STORE (DJPLAYLIST, scan récursif)
const HANDLE_STORE = "handles";
const ANALYSIS_STORE = "analysis";
const TAGS_STORE = "tags";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      if (!db.objectStoreNames.contains(ANALYSIS_STORE)) db.createObjectStore(ANALYSIS_STORE);
      if (!db.objectStoreNames.contains(TAGS_STORE)) db.createObjectStore(TAGS_STORE);
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
const fileKey = (relPath, file) => `${relPath}|${file.size}|${file.lastModified}`;
export const getCachedAnalysis = (relPath, file) => idbGet(ANALYSIS_STORE, fileKey(relPath, file));
export const setCachedAnalysis = (relPath, file, data) => idbSet(ANALYSIS_STORE, fileKey(relPath, file), data);
export const getCachedTags = (relPath, file) => idbGet(TAGS_STORE, fileKey(relPath, file));
export const setCachedTags = (relPath, file, tags) => idbSet(TAGS_STORE, fileKey(relPath, file), tags);

const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"]);
const isAudioFile = (name) => AUDIO_EXT.has(name.slice(name.lastIndexOf(".")).toLowerCase());

// ── Scan récursif de TOUT le dossier bibliothèque (contrairement au
// composant MacheupDjLibrary, qui ne liste qu'un dossier à la fois pour
// rester léger dans les decks) — nécessaire à DJPLAYLIST pour comparer une
// playlist importée contre l'ensemble de la collection, pas juste un
// sous-dossier. Les tags sont lus depuis le cache IndexedDB quand possible
// (quasi instantané), sinon lus en local via jsmediatags et mis en cache
// pour la prochaine fois. onProgress(scanned, path) permet d'afficher une
// barre de progression pendant le scan d'une grosse bibliothèque.
export async function scanLibraryRecursive(rootHandle, onProgress) {
  const results = [];
  let scanned = 0;

  async function walk(dirHandle, path) {
    const entries = [];
    try {
      for await (const [name, handle] of dirHandle.entries()) entries.push({ name, handle });
    } catch { return; } // dossier illisible (permission retirée, lien cassé, etc.)

    for (const { name, handle } of entries) {
      const childPath = path ? `${path}/${name}` : name;
      if (handle.kind === "directory") {
        await walk(handle, childPath);
      } else if (isAudioFile(name)) {
        let tags = null;
        try {
          const file = await handle.getFile();
          tags = await getCachedTags(childPath, file).catch(() => null);
          if (!tags) {
            tags = await readAudioTags(file);
            await setCachedTags(childPath, file, tags).catch(() => {});
          }
          scanned++;
          onProgress?.(scanned, childPath);
          results.push({ name, handle, relPath: childPath, tags });
        } catch { /* fichier illisible, ignoré */ }
      }
    }
  }

  await walk(rootHandle, "");
  return results;
}
