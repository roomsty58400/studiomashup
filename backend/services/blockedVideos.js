import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

// Liste persistée (fichier JSON, pas besoin d'une table SQLite pour ça) des
// vidéos YouTube à ne plus jamais proposer dans les recherches (Decks A/B +
// Clip Editor) — alimentée quand le lecteur YouTube intégré rapporte une
// erreur d'intégration (101/150 : "lecture désactivée sur d'autres sites
// Web"), en complément du filtre status.embeddable de l'API (qui peut être
// erroné/périmé pour certaines vidéos, comme constaté en pratique).
const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "../data/blocked-videos.json");

let blocked = new Set();
try {
  if (existsSync(FILE)) blocked = new Set(JSON.parse(readFileSync(FILE, "utf-8")));
} catch (e) {
  console.warn("[blockedVideos] lecture échouée, on repart d'une liste vide :", e.message);
}

const persist = () => {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify([...blocked]), "utf-8");
  } catch (e) {
    console.warn("[blockedVideos] écriture échouée :", e.message);
  }
};

export const isBlocked = (videoId) => blocked.has(videoId);

export const blockVideo = (videoId) => {
  if (!videoId || blocked.has(videoId)) return;
  blocked.add(videoId);
  persist();
  console.log(`[blockedVideos] vidéo bloquée (ne sera plus suggérée) : ${videoId}`);
};

// Filtre un tableau de résultats de recherche (objets avec un champ videoId).
export const filterBlocked = (items) => items.filter(item => !blocked.has(item.videoId));
