// ── File d'attente CPU pour les rendus ffmpeg lourds (combos) ──────────────
// Diagnostic (capture terminal fournie par l'utilisateur) : le cadre "combos"
// (routes/mashup.js /combine-stems et /combine-stems-duo) lance 4 requêtes en
// PARALLÈLE dès que les 2 decks sont prêts (cf. MashupStudio.jsx, 4 IIFE
// indépendantes) — chacune déclenche mixFullRave/mixFullRaveDuo, qui exécute
// déjà 2-3 process ffmpeg (2 passes de mesure loudnorm + l'encodage final,
// chaîne multibande/sidechain/EQ assez lourde). 4 combos en parallèle, c'est
// donc jusqu'à une dizaine de process ffmpeg qui se disputent le CPU en même
// temps — la capture fournie montre un encodage à "speed=0.476x" (2x plus
// LENT que le temps réel) sur un fichier de ~4-5 minutes, largement de quoi
// dépasser le timeout de 3 minutes fixé sur ces appels (services/ffmpeg.js)
// une fois 4 jobs en concurrence plutôt qu'un seul.
//
// Contrairement à gpuQueue.js (sérialisation stricte, 1 seul job GPU à la
// fois — nécessaire pour la VRAM), ici on autorise un peu de parallélisme
// (CPU multi-coeurs, pas de VRAM à ménager) mais on plafonne le nombre de
// process ffmpeg lourds simultanés pour éviter la contention qui a fait
// échouer les 4 combos d'un coup.
const MAX_CONCURRENT = 2;
let active = 0;
const waiting = [];

const runNext = () => {
  if (active >= MAX_CONCURRENT || waiting.length === 0) return;
  active++;
  const { fn, resolve, reject } = waiting.shift();
  fn().then(
    (v) => { active--; resolve(v); runNext(); },
    (e) => { active--; reject(e); runNext(); },
  );
};

export const runCpuLimited = (fn) => new Promise((resolve, reject) => {
  waiting.push({ fn, resolve, reject });
  runNext();
});
