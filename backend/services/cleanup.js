import { readdirSync, unlinkSync } from "fs";
import { join, extname } from "path";

// ── Nettoyage média (démarrage + fermeture) ──────────────────────────────
//
// Supprime tout fichier .mp3/.flac/.mp4/.wav sous les dossiers donnés, de
// façon récursive. Volontairement radical : ces fichiers sont tous des
// sorties ou des caches régénérables (mashups FLAC/MP4, stems Demucs
// dérivés, vidéos/audio yt-dlp mis en cache, WAV intermédiaires
// d'extraction/mixage) — jamais une source qu'on ne pourrait pas reproduire.
// .wav ajouté (juillet 2026) : c'était le seul format intermédiaire non
// couvert alors qu'il transite par tmp/ à chaque analyse/séparation/mashup
// (extractAudio, mixage) — pouvait s'accumuler silencieusement si un job
// s'interrompait avant son propre nettoyage local (finally/rm(jobTmp)).
// Objectif : éviter que data/outputs et cache/ grossissent sans limite au
// fil des sessions de test (des dizaines de morceaux analysés finissent par
// représenter plusieurs Go).
//
// Sans risque de plantage même si le cache SQLite (db/index.js) référence
// encore ces fichiers après coup : routes/stems.js et routes/mashup.js
// vérifient désormais l'existence réelle des fichiers avant de faire
// confiance au cache, et retombent sur une re-séparation Demucs complète si
// besoin (cf. fix "cache SQLite périmé" du 2026-07-03).
//
// Synchrone à dessein : appelé au démarrage (avant que le serveur n'accepte
// des requêtes) et dans un handler de signal d'arrêt (SIGINT/SIGTERM), où on
// veut que le nettoyage soit terminé avant que le process ne se termine —
// pas de risque de laisser une promesse en vol au moment de l'exit.
const TARGET_EXTENSIONS = new Set([".mp3", ".flac", ".mp4", ".wav"]);

// node_modules exclu explicitement : jamais scanné, gain de temps énorme et
// aucun risque de toucher aux dépendances.
// "radio-recordings" exclu aussi : contrairement aux mashups/stems/vidéos
// (tous régénérables à la demande), un enregistrement radio capture un
// moment LIVE qui ne repassera jamais — le supprimer au démarrage/à la
// fermeture ferait perdre le fichier définitivement, pas juste du temps de
// retraitement (cf. routes/radio.js, bouton ⏺ Enregistrer).
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "radio-recordings"]);

function walkAndDelete(dir, stats, extensions) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dossier inexistant/inaccessible : rien à faire, pas bloquant
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkAndDelete(join(dir, entry.name), stats, extensions);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!extensions.has(extname(entry.name).toLowerCase())) continue;
    try {
      unlinkSync(join(dir, entry.name));
      stats.deleted++;
    } catch (e) {
      stats.errors++;
      console.warn(`⚠️ [cleanup] échec suppression ${join(dir, entry.name)} :`, e.message);
    }
  }
}

// rootDirs : chemins absolus des dossiers à nettoyer (récursivement).
// label : juste pour le message de log ("démarrage" / "fermeture" / etc).
// extensions (optionnel) : par défaut TARGET_EXTENSIONS (.mp3/.flac/.mp4/
// .wav — le grand nettoyage complet, bouton 🧹 + démarrage/fermeture).
// Permet aussi un balayage SCOPÉ à un sous-ensemble d'extensions/dossiers —
// utilisé par l'interrupteur ON/OFF du Mixer (routes/mashup.js, POST
// /cleanup) pour ne purger QUE les .wav orphelins de tmp/ sans toucher aux
// stems/mashups FLAC déjà en cache pour d'autres morceaux.
export function cleanupMediaFiles(rootDirs, label = "", extensions = TARGET_EXTENSIONS) {
  const stats = { deleted: 0, errors: 0 };
  for (const dir of rootDirs) walkAndDelete(dir, stats, extensions);
  const suffix = label ? ` (${label})` : "";
  const extList = [...extensions].join("/");
  console.log(
    stats.deleted > 0 || stats.errors > 0
      ? `🧹 [cleanup${suffix}] ${stats.deleted} fichier(s) ${extList} supprimé(s)${stats.errors ? `, ${stats.errors} échec(s)` : ""}`
      : `🧹 [cleanup${suffix}] rien à nettoyer`
  );
  return stats;
}
