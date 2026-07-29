// ── Purge périodique des jobs terminés en mémoire (audit juillet 2026) ─────
// Chaque route qui traite un travail asynchrone (mashup, mashup multi-
// sources, roue de correspondances, extraction stems, clip editor, RaveDJ
// auto, enregistrements radio...) garde son état dans une Map en mémoire
// (jobId -> { status, ..., updatedAt }), jamais vidée jusqu'ici : sur une
// session serveur qui tourne longtemps sans redémarrage, ces Maps grossissent
// indéfiniment — chaque job lancé depuis le démarrage y reste pour toujours,
// même des heures après avoir été consommé par le frontend. Impact mémoire
// limité pour un usage perso avec redémarrages fréquents (cf. audit du
// 29/07), mais un correctif simple et sans risque à généraliser.
//
// registerJobCleanup(map, options) démarre un balayage périodique sur UNE
// Map de jobs — appelé une fois par route, indépendant d'une route à
// l'autre (pas de registre global à maintenir). Ne supprime QUE les entrées
// dont le statut est considéré "terminé" (jamais un job en cours, même très
// ancien : un job long ne doit jamais disparaître sous les pieds du frontend
// qui le poll encore) et dont le dernier horodatage dépasse le délai de
// grâce (ttlMs).
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;   // 2h après la dernière mise à jour du job
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;  // vérifie toutes les 15 min
const DEFAULT_TERMINAL = new Set(["done", "error"]);

/**
 * @param {Map<string, object>} jobsMap - la Map à surveiller (mutée en place)
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] - âge (ms) au-delà duquel un job terminé est purgé
 * @param {number} [opts.intervalMs] - fréquence (ms) du balayage
 * @param {Set<string>|string[]} [opts.terminalStatuses] - valeurs de `status` considérées "terminées"
 * @param {(job: object) => number} [opts.getUpdatedAt] - accesseur d'horodatage (défaut: job.updatedAt), pour les maps qui utilisent un autre nom de champ (ex: startedAt)
 * @param {string} [opts.label] - préfixe des logs
 * @returns {() => void} - fonction pour arrêter le balayage (tests, arrêt propre)
 */
export const registerJobCleanup = (jobsMap, {
  ttlMs = DEFAULT_TTL_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  terminalStatuses = DEFAULT_TERMINAL,
  getUpdatedAt = (job) => job.updatedAt,
  label = "[jobs]",
} = {}) => {
  const terminal = terminalStatuses instanceof Set ? terminalStatuses : new Set(terminalStatuses);
  const sweep = () => {
    const now = Date.now();
    let purged = 0;
    for (const [id, job] of jobsMap) {
      if (!job || !terminal.has(job.status)) continue; // jamais un job actif
      const ts = getUpdatedAt(job) || 0;
      if (now - ts >= ttlMs) {
        jobsMap.delete(id);
        purged++;
      }
    }
    if (purged > 0) {
      console.log(`${label} purge mémoire : ${purged} job(s) terminé(s) depuis plus de ${Math.round(ttlMs / 60000)} min retiré(s) (${jobsMap.size} restant(s))`);
    }
  };
  const timer = setInterval(sweep, intervalMs);
  // N'empêche jamais le process de s'arrêter à cause de ce seul minuteur
  // (cohérent avec l'arrêt volontaire déjà géré dans server.js).
  timer.unref?.();
  return () => clearInterval(timer);
};
