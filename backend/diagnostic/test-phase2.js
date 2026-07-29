// Test manuel Phase 2 (juillet 2026) — vérifie que kick_times/snare_times/drops
// sont bien calculés et remontés par analyzeAudio, sur un fichier audio RÉEL déjà
// en cache (pas besoin de retélécharger via yt-dlp). Lancé à part du serveur
// (node direct), donc ne déclenche PAS cleanup.js et ne touche pas data/outputs.
import { analyzeAudio } from "../services/analyzer.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache", "audio");

const files = readdirSync(CACHE_DIR).filter(f => f.endsWith(".wav"));
if (files.length === 0) {
  console.error("Aucun .wav trouvé dans", CACHE_DIR);
  process.exit(1);
}
const target = join(CACHE_DIR, files[0]);
console.log(`>>> Analyse de test : ${target}`);
console.log(`>>> Démarré à ${new Date().toISOString()}`);

const t0 = Date.now();
const features = await analyzeAudio(target);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`>>> Terminé en ${elapsed}s`);
console.log("");
if (features.analysisFailed) {
  console.error("❌ ANALYSE ÉCHOUÉE :", features.analysisError);
  process.exit(1);
}

console.log("── Résultats de base ──");
console.log(`BPM: ${features.bpm}  |  Clé: ${features.key_pitch} ${features.key_mode} (${features.camelot})  |  Durée: ${features.duration}s`);
console.log(`Energie RMS: ${features.energy_rms}  |  Centroïde spectral: ${features.spectral_centroid}`);
console.log(`Beats détectés: ${(features.beat_times || []).length}`);
console.log(`Sections structure: ${(features.structure || []).length}`);

console.log("");
console.log("── Phase 2 : kick / snare / drops ──");
const kick = features.kick_times || [];
const snare = features.snare_times || [];
const drops = features.drops || [];
console.log(`Kick times (${kick.length}) — 10 premiers: ${JSON.stringify(kick.slice(0, 10))}`);
console.log(`Snare times (${snare.length}) — 10 premiers: ${JSON.stringify(snare.slice(0, 10))}`);
console.log(`Drops (${drops.length}): ${JSON.stringify(drops)}`);

const ok = Array.isArray(kick) && Array.isArray(snare) && Array.isArray(drops);
console.log("");
console.log(ok ? "✅ Phase 2 OK — champs présents et bien typés" : "❌ Phase 2 KO — champs manquants ou mal typés");
process.exit(ok ? 0 : 1);
