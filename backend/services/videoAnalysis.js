// ── Analyse vidéo par filtres ffmpeg natifs (Phase 3, juillet 2026) ─────────
// Roadmap : architecture-moteur-mashup-roadmap.md, section "Phase 3 — Module
// d'analyse vidéo". Volontairement SANS aucune dépendance IA/GPU vidéo — tout
// repose sur des filtres ffmpeg déjà présents dans l'installation existante
// (select/scene, showinfo, freezedetect), au même titre que buildAlternating-
// Filter/buildSilentVideoMontage plus bas dans ffmpeg.js. Rapport effort/
// impact jugé le plus favorable du cahier des charges (cf. roadmap §3).
//
// Toutes les fonctions de ce module sont des ENRICHISSEMENTS, jamais des
// dépendances bloquantes : un échec (vidéo corrompue, ffmpeg qui timeout sur
// une source inhabituelle...) ne doit jamais faire échouer tout un mashup —
// seulement priver le planner de coupes (videoCutPlanner.js) de cette
// information, qui retombe alors sur son comportement par défaut (durée
// fixe, cf. buildAlternatingFilter). Chaque fonction publique attrape donc
// ses propres erreurs et retourne une valeur de repli neutre plutôt que de
// lancer une exception.

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// maxBuffer relevé (défaut Node ~1 Mo) : sur une vidéo de plusieurs minutes
// avec beaucoup de coupes, la sortie showinfo/freezedetect (une ligne par
// frame retenue) peut dépasser cette limite par défaut et faire échouer
// execAsync avec "stdout maxBuffer exceeded" avant même d'avoir pu parser le
// résultat.
const EXEC_OPTS = (timeoutMs) => ({ timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });

// ── Détection de coupes/scènes ──────────────────────────────────────────────
// select='gt(scene,threshold)' : ffmpeg calcule en interne un score de
// différence entre trames consécutives (0-1) et ne laisse passer QUE les
// trames où ce score dépasse le seuil — showinfo loggue alors le pts_time de
// chacune, sur stderr (pas stdout, comportement standard de ffmpeg pour les
// filtres de diagnostic). threshold=0.4 est la valeur usuelle documentée par
// ffmpeg pour repérer des changements de plan francs sans se déclencher sur
// un simple mouvement de caméra/zoom.
export const detectSceneCuts = async (videoPath, { threshold = 0.4, timeoutMs = 90000 } = {}) => {
  try {
    const cmd = `ffmpeg -i "${videoPath}" -vf "select='gt(scene,${threshold})',showinfo" -f null -`;
    const { stderr } = await execAsync(cmd, EXEC_OPTS(timeoutMs));
    const times = [];
    const re = /pts_time:([0-9.]+)/g;
    let m;
    while ((m = re.exec(stderr)) !== null) times.push(parseFloat(m[1]));
    return [...new Set(times.map(t => Math.round(t * 100) / 100))].sort((a, b) => a - b);
  } catch (err) {
    // execAsync rejette dès que ffmpeg sort avec un code non-nul OU dépasse
    // timeoutMs — mais err.stderr contient quand même la sortie déjà produite
    // (Node fournit stdout/stderr partiels sur les erreurs d'exec). On tente
    // de récupérer ce qu'on peut plutôt que d'abandonner sur un simple
    // timeout dû à une vidéo longue.
    if (err && typeof err.stderr === "string" && err.stderr.includes("pts_time:")) {
      const times = [];
      const re = /pts_time:([0-9.]+)/g;
      let m;
      while ((m = re.exec(err.stderr)) !== null) times.push(parseFloat(m[1]));
      if (times.length > 0) {
        return [...new Set(times.map(t => Math.round(t * 100) / 100))].sort((a, b) => a - b);
      }
    }
    console.warn(`[videoAnalysis] détection de scènes impossible sur ${videoPath} : ${err.message}`);
    return [];
  }
};

// ── Rythme visuel ────────────────────────────────────────────────────────────
// Dérivé trivialement des coupes détectées — indicateur de "dynamisme" d'une
// vidéo source directement comparable au BPM du morceau (cf. roadmap §3.2) :
// un clip très cut (plans courts, cutsPerSecond élevé) convient mieux à un
// passage musical énergique, un clip posé (avgShotLength élevé) à une intro.
export const visualRhythm = (sceneCuts, durationSec) => {
  const cutCount = Array.isArray(sceneCuts) ? sceneCuts.length : 0;
  const duration = durationSec > 0 ? durationSec : 0;
  return {
    cutCount,
    cutsPerSecond: duration > 0 ? cutCount / duration : 0,
    avgShotLength: duration > 0 ? duration / (cutCount + 1) : 0,
  };
};

// ── Segments figés/statiques (freezedetect) ─────────────────────────────────
// Repère les plages où l'image reste quasi identique pendant au moins
// minFreezeDuration secondes (écran figé, image fixe, source de mauvaise
// qualité...) — utile pour le planner de coupes (videoCutPlanner.js) afin
// d'ÉVITER de piocher un segment de montage dans une zone figée, qui
// produirait un extrait visuellement plat malgré une musique dynamique.
// noiseTolerance=0.001 et minFreezeDuration=1.0s reprennent les valeurs par
// défaut documentées du filtre freezedetect de ffmpeg — pas de réglage
// spécifique nécessaire pour cet usage (simple filtre d'exclusion, pas une
// mesure fine).
export const detectFrozenSegments = async (videoPath, { noiseTolerance = 0.001, minFreezeDuration = 1.0, timeoutMs = 90000 } = {}) => {
  try {
    const cmd = `ffmpeg -i "${videoPath}" -vf "freezedetect=n=${noiseTolerance}:d=${minFreezeDuration}" -f null -`;
    const { stderr } = await execAsync(cmd, EXEC_OPTS(timeoutMs));
    return parseFreezeIntervals(stderr);
  } catch (err) {
    if (err && typeof err.stderr === "string") {
      const parsed = parseFreezeIntervals(err.stderr);
      if (parsed.length > 0) return parsed;
    }
    console.warn(`[videoAnalysis] détection de segments figés impossible sur ${videoPath} : ${err.message}`);
    return [];
  }
};

// freezedetect loggue "lavfi.freezedetect.freeze_start: X" à l'entrée d'un
// gel puis "lavfi.freezedetect.freeze_end: Y" à sa fin, en lignes séparées et
// dans cet ordre garanti (le filtre ne peut pas fermer un intervalle qu'il
// n'a pas ouvert) — on les apparie donc simplement dans l'ordre d'apparition.
const parseFreezeIntervals = (stderrText) => {
  const starts = [...stderrText.matchAll(/freeze_start:\s*([0-9.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...stderrText.matchAll(/freeze_end:\s*([0-9.]+)/g)].map(m => parseFloat(m[1]));
  const intervals = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    intervals.push({ start: starts[i], end: ends[i] });
  }
  return intervals;
};
