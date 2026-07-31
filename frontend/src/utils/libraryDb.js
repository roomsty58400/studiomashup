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

// Liste volontairement large — un scan qui rate un format présent chez
// l'utilisateur est un vrai bug silencieux (retour utilisateur : "il ne
// trouve pas le même nombre de morceaux"), alors qu'inclure un format rare
// ne coûte rien. Note : .wma/.ape/.wv passent très bien dans le pipeline
// d'analyse serveur (ffmpeg), mais PAS forcément dans decodeAudioData côté
// navigateur pour la lecture live dans MACHEUPDJ (Chrome ne décode pas le
// WMA) — DJPLAYLIST (comparaison/génération/export) n'en a pas besoin, la
// lecture live gère déjà son propre message d'erreur si un format ne passe pas.
const AUDIO_EXT = new Set([
  ".mp3", ".wav", ".flac", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus",
  ".wma", ".aiff", ".aif", ".ape", ".wv",
]);
const isAudioFile = (name) => AUDIO_EXT.has(name.slice(name.lastIndexOf(".")).toLowerCase());

// ── Scan récursif de TOUT le dossier bibliothèque (contrairement au
// composant MacheupDjLibrary, qui ne liste qu'un dossier à la fois pour
// rester léger dans les decks) — nécessaire à DJPLAYLIST pour comparer une
// playlist importée contre l'ensemble de la collection, pas juste un
// sous-dossier. Les tags sont lus depuis le cache IndexedDB quand possible
// (quasi instantané), sinon lus en local via jsmediatags et mis en cache
// pour la prochaine fois. onProgress(scanned, path) permet d'afficher une
// barre de progression pendant le scan d'une grosse bibliothèque.
//
// Renvoie { entries, stats } plutôt qu'un simple tableau : stats permet
// d'afficher "X fichiers vus, Y ignorés (non-audio), Z illisibles" pour que
// l'écart avec le nombre de fichiers du dossier (vu dans l'Explorateur
// Windows par ex.) s'explique clairement plutôt que de rester "un chiffre
// bizarre" sans explication.
export async function scanLibraryRecursive(rootHandle, onProgress) {
  const results = [];
  const stats = { totalFiles: 0, audioFound: 0, nonAudioSkipped: 0, unreadable: 0, foldersUnreadable: 0 };
  let scanned = 0;

  async function walk(dirHandle, path) {
    const entries = [];
    try {
      for await (const [name, handle] of dirHandle.entries()) entries.push({ name, handle });
    } catch {
      stats.foldersUnreadable++; // dossier illisible (permission retirée, lien cassé, etc.)
      return;
    }

    for (const { name, handle } of entries) {
      const childPath = path ? `${path}/${name}` : name;
      if (handle.kind === "directory") {
        await walk(handle, childPath);
      } else {
        stats.totalFiles++;
        if (!isAudioFile(name)) { stats.nonAudioSkipped++; continue; }
        try {
          const file = await handle.getFile();
          let tags = await getCachedTags(childPath, file).catch(() => null);
          if (!tags) {
            tags = await readAudioTags(file);
            await setCachedTags(childPath, file, tags).catch(() => {});
          }
          scanned++;
          stats.audioFound++;
          onProgress?.(scanned, childPath);
          results.push({ name, handle, relPath: childPath, tags });
        } catch {
          // Fichier illisible : permission refusée, ou — cas fréquent sur un
          // dossier synchronisé cloud (OneDrive "Fichiers à la demande" etc.)
          // — un fichier "placeholder" pas encore vraiment téléchargé sur
          // le disque, que getFile() ne peut pas ouvrir.
          stats.unreadable++;
        }
      }
    }
  }

  await walk(rootHandle, "");
  return { entries: results, stats };
}
