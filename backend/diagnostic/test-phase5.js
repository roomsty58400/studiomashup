// Test manuel Phase 5 (juillet 2026) — vérifie en conditions réelles :
//  1) que routes/mashup.js charge toujours correctement après l'extraction
//     de trackPreparation.js (non-régression du chemin le plus utilisé),
//  2) que la nouvelle route POST /api/mashup-multi fonctionne de bout en
//     bout sur au moins 3 morceaux DÉJÀ analysés/séparés en cache SQLite.
// Lancé à part du serveur (process Node indépendant, comme test-phase2/3.js),
// avec son propre mini-serveur Express éphémère sur un port libre — ne
// touche PAS au serveur "npm run dev" déjà en cours.
import { listAnalyzedTracks } from "../db/index.js";
import express from "express";
import mashupRoutes from "../routes/mashup.js";
import mashupMultiRoutes from "../routes/mashupMulti.js";

console.log(">>> 1) routes/mashup.js + routes/mashupMulti.js importés sans erreur — non-régression OK");

// ── Recherche de pistes déjà analysées/séparées (mode 4 stems), via le même
// helper que le reste de l'app (db/index.js::listAnalyzedTracks) plutôt
// qu'une requête SQL ad hoc dupliquée. ──────────────────────────────────────
const rows = listAnalyzedTracks()
  .filter(r => String(r.stem_mode) === "4" && r.vocals_path && r.drums_path && r.bass_path && r.other_path)
  .slice(0, 5);

console.log(`>>> 2) ${rows.length} piste(s) en cache mode 4 stems, analyse valide :`, rows.map(r => `${r.id} (BPM ${r.bpm})`));

if (rows.length < 3) {
  console.error("❌ Pas assez de pistes en cache (mode 4 stems) pour tester le multi-sources — besoin d'au moins 3.");
  process.exit(1);
}

const trackIds = rows.slice(0, 3).map(r => r.id);

// ── Mini-serveur Express éphémère ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api/mashup", mashupRoutes);
app.use("/api/mashup-multi", mashupMultiRoutes);
const server = app.listen(0);
const port = server.address().port;
console.log(`>>> 3) Serveur de test démarré sur http://localhost:${port}`);

const body = {
  tracks: trackIds,
  stemMode: 4,
  stemSelection: { vocals: 0, drums: 1, bass: 2, other: 1 },
  crossfade: 0.5,
  title: "test-phase5",
};
console.log(">>> 4) POST /api/mashup-multi avec :", JSON.stringify(body));

const t0 = Date.now();
const postRes = await fetch(`http://localhost:${port}/api/mashup-multi`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const postJson = await postRes.json();
console.log(">>> réponse POST :", postRes.status, postJson);

if (!postJson.jobId) {
  console.error("❌ Pas de jobId retourné.");
  process.exit(1);
}

// ── Poll du statut jusqu'à done/error (timeout 18 min — relevé après un 1er
// essai réel : cette machine n'a ni décodage CUDA ni NVENC fonctionnels
// (constaté aussi sur le chemin 2-sources existant, pas spécifique à cette
// route), donc l'encodage vidéo à 3 sources retombe sur libx264 CPU pur,
// nettement plus lent que le budget initial de 6 min) ─────────────────────
const TIMEOUT_MS = 18 * 60 * 1000;
let job = null;
while (Date.now() - t0 < TIMEOUT_MS) {
  await new Promise(r => setTimeout(r, 3000));
  const statusRes = await fetch(`http://localhost:${port}/api/mashup-multi/${postJson.jobId}/status`);
  job = await statusRes.json();
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] status=${job.status} step=${job.step} label=${job.label || ""}`);
  if (job.status === "done" || job.status === "error") break;
}

server.close();

console.log("");
if (job?.status === "done") {
  console.log("✅ Phase 5 (mashup-multi) OK —", JSON.stringify(job));
  process.exit(0);
} else {
  console.error("❌ Phase 5 (mashup-multi) KO —", JSON.stringify(job));
  process.exit(1);
}
