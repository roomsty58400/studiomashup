// Test manuel Phase 3 (juillet 2026) — vérifie detectSceneCuts/visualRhythm/
// detectFrozenSegments sur une vidéo RÉELLE du cache, puis planMusicSyncedCuts
// avec un vrai beatTimes issu de test-phase2.js. Ne touche PAS au serveur ni
// à data/outputs (process indépendant, comme test-phase2.js).
import { detectSceneCuts, visualRhythm, detectFrozenSegments } from "../services/videoAnalysis.js";
import { planMusicSyncedCuts } from "../services/videoCutPlanner.js";
import { getDuration } from "../services/ffmpeg.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache", "video");

const files = readdirSync(CACHE_DIR).filter(f => f.endsWith(".mp4"));
if (files.length === 0) {
  console.error("Aucun .mp4 trouvé dans", CACHE_DIR);
  process.exit(1);
}
const target = join(CACHE_DIR, files[0]);
console.log(`>>> Vidéo de test : ${target}`);

const duration = await getDuration(target);
console.log(`>>> Durée : ${duration.toFixed(1)}s`);

const t0 = Date.now();
const cuts = await detectSceneCuts(target);
console.log(`>>> detectSceneCuts en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`Coupures détectées (${cuts.length}) — 10 premières: ${JSON.stringify(cuts.slice(0, 10))}`);
console.log("Rythme visuel:", visualRhythm(cuts, duration));

const t1 = Date.now();
const frozen = await detectFrozenSegments(target);
console.log(`>>> detectFrozenSegments en ${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log(`Segments figés (${frozen.length}):`, JSON.stringify(frozen.slice(0, 5)));

// Beat grid synthétique (120 BPM) pour tester le planner sans dépendre d'une
// ré-analyse audio complète — le planner ne fait aucune hypothèse sur
// l'origine de beatTimes, seul l'espacement moyen compte.
const beatTimes = Array.from({ length: Math.floor(duration / 0.5) }, (_, i) => i * 0.5);
const { plan, segmentSec, beatSynced } = planMusicSyncedCuts({
  totalSec: Math.min(duration, 60),
  durA: duration, durB: duration,
  beatTimes, scenesA: cuts, scenesB: cuts,
  baseSegmentSec: 8, xfadeSec: 0.6,
});
console.log("");
console.log(`Plan calé musique : beatSynced=${beatSynced}, segmentSec=${segmentSec.toFixed(2)}, ${plan.length} segments`);
console.log(JSON.stringify(plan.slice(0, 6), null, 1));

const ok = Array.isArray(cuts) && Array.isArray(frozen) && Array.isArray(plan) && plan.length >= 2;
console.log("");
console.log(ok ? "✅ Phase 3 OK — détection scènes/gel + planner fonctionnels sur vidéo réelle" : "❌ Phase 3 KO");
process.exit(ok ? 0 : 1);
