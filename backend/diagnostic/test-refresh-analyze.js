// Regénère les stems (mode 4) de 3 pistes réelles en tapant directement sur
// le VRAI serveur déjà en cours (npm run dev, port 3001) — PAS un serveur
// éphémère comme test-phase5.js, pour que les fichiers produits survivent
// (jusqu'au prochain redémarrage du serveur, qui les videra via cleanup.js).
// But : réparer le cache de test pour rejouer test-phase5.js (mashup multi-
// sources) avec des stems réellement présents sur le disque.
import { listAnalyzedTracks } from "../db/index.js";

const BASE = "http://localhost:3001";

const candidates = listAnalyzedTracks()
  .filter(r => r.bpm != null)
  .slice(0, 3);

if (candidates.length < 3) {
  console.error("❌ Pas assez de pistes déjà connues en base pour ce test.");
  process.exit(1);
}

console.log(">>> Pistes ciblées :", candidates.map(t => `${t.id} — ${t.title || "?"}`));

const waitForJob = async (jobId, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 4000));
    const res = await fetch(`${BASE}/api/analyze/${jobId}/status`);
    const job = await res.json();
    console.log(`[${label}] [${((Date.now() - t0) / 1000).toFixed(0)}s] step=${job.step} status=${job.status || ""}`);
    if (job.status === "done" || job.status === "error") return job;
    if (job.step === "done") return job; // certains jobs n'ont pas de champ "status" explicite à la fin
  }
  throw new Error(`timeout en attendant le job ${jobId}`);
};

for (const track of candidates) {
  console.log(`\n>>> Analyse (mode 4 stems) : ${track.id} — ${track.title || "?"}`);
  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId: track.id, title: track.title || track.id, stemMode: 4 }),
  });
  const json = await res.json();
  if (json.cached) {
    console.log(`>>> déjà en cache et utilisable (rien à refaire) :`, json.track.id);
    continue;
  }
  if (!json.jobId) {
    console.error("❌ Pas de jobId :", json);
    continue;
  }
  const job = await waitForJob(json.jobId, track.id);
  console.log(`>>> résultat ${track.id} :`, job.status || job.step, job.message || "");
}

console.log("\n✅ Rafraîchissement terminé — relance run-test-phase5.bat pour rejouer le test multi-sources.");
