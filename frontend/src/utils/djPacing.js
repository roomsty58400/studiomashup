// ─── Profil d'animation de soirée (DJPLAYLIST) ─────────────────────────────
// Construit l'ordre final d'une playlist à partir de pistes locales déjà
// analysées (BPM + energy_rms, cf. backend/services/analyzer.js) en suivant
// une courbe d'énergie de soirée classique : accueil modéré (~50-75%
// d'énergie), dîner en retrait, montée progressive, pic sur le dancefloor,
// clôture qui redescend. Basé sur la structure "ouverture/montée/pic/
// clôture" utilisée par les DJ pro (cf. recherche : phases alignées sur
// l'état réel de la salle plutôt qu'une progression figée).
//
// Première version volontairement simple (buckets par percentile d'énergie
// dans la sélection disponible, pas de règle harmonique/BPM fine) —
// affinable si le rendu à l'écoute ne convient pas.

const PHASES = [
  { key: "accueil", label: "Accueil / Cocktail", fraction: 0.15, energyRange: [0.45, 0.75] },
  { key: "diner",   label: "Dîner / Ambiance",    fraction: 0.20, energyRange: [0.05, 0.40] },
  { key: "montee",  label: "Montée",              fraction: 0.20, energyRange: [0.35, 0.70] },
  { key: "pic",     label: "Pic / Dancefloor",    fraction: 0.35, energyRange: [0.65, 1.00] },
  { key: "cloture", label: "Clôture",              fraction: 0.10, energyRange: [0.20, 0.55] },
];

// candidates: [{ relPath, title, artist, duration, energy_rms, bpm, style }]
// targetSeconds: durée totale visée (chaque phase s'arrête dès que sa part
// de la durée cible est atteinte — le total peut légèrement dépasser la
// cible, jamais beaucoup, jamais en dessous si assez de pistes disponibles).
export function buildAnimationPlaylist(candidates, targetSeconds) {
  const usable = candidates.filter(c => typeof c.energy_rms === "number" && c.duration > 0);
  if (usable.length === 0) return { phases: [], tracks: [] };

  const energies = usable.map(c => c.energy_rms).sort((a, b) => a - b);
  const percentileOf = (e) => {
    if (energies.length <= 1) return 0.5;
    let idx = energies.findIndex(x => x >= e);
    if (idx === -1) idx = energies.length - 1;
    return idx / (energies.length - 1);
  };
  const pool = usable.map(c => ({ ...c, _pct: percentileOf(c.energy_rms) }));

  // Groupes par sous-style — alterné en tourniquet si plusieurs sont
  // sélectionnés pour la génération, pour éviter qu'un seul sous-style
  // domine toute la playlist alors que 2-3 étaient demandés.
  const styleGroups = {};
  for (const c of pool) (styleGroups[c.style || "—"] ||= []).push(c);
  const styleKeys = Object.keys(styleGroups);

  const used = new Set();
  const result = [];
  const phaseResults = [];

  for (const phase of PHASES) {
    const phaseTarget = targetSeconds * phase.fraction;
    let phaseDuration = 0;
    const phaseTracks = [];
    let [lo, hi] = phase.energyRange;
    let styleCursor = 0;
    let guard = 0;

    while (phaseDuration < phaseTarget && guard < 500) {
      guard++;
      let found = null;
      for (let i = 0; i < styleKeys.length; i++) {
        const key = styleKeys[(styleCursor + i) % styleKeys.length];
        const group = styleGroups[key];
        const center = (lo + hi) / 2;
        let best = null, bestDist = Infinity;
        for (const c of group) {
          if (used.has(c.relPath)) continue;
          if (c._pct < lo || c._pct > hi) continue;
          const dist = Math.abs(c._pct - center);
          if (dist < bestDist) { bestDist = dist; best = c; }
        }
        if (best) { found = best; styleCursor = (styleCursor + i + 1) % styleKeys.length; break; }
      }
      if (!found) {
        // Élargit la fenêtre d'énergie plutôt que de laisser la phase vide
        // (utile si la bibliothèque n'a pas assez de variété d'énergie).
        if (lo <= 0 && hi >= 1) break; // tout le pool déjà exploré, rien de plus à trouver
        lo = Math.max(0, lo - 0.1); hi = Math.min(1, hi + 0.1);
        continue;
      }
      used.add(found.relPath);
      phaseTracks.push(found);
      phaseDuration += found.duration;
    }

    phaseResults.push({ ...phase, tracks: phaseTracks, duration: phaseDuration });
    result.push(...phaseTracks);
  }

  return { phases: phaseResults, tracks: result };
}
