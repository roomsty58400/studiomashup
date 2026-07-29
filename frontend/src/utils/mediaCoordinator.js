// ── Coordinateur de lecture audio/vidéo global ───────────────────────────
// Retour utilisateur récurrent : "superposition des vocals" sur le mashup
// final — déjà corrigé une fois (Deck A/B restait audible pendant la lecture
// du mashup final du Mixer, cf. onPauseDecks). Mais le site a en réalité
// PLUSIEURS lecteurs indépendants qui ignorent totalement les autres :
//   - Deck A / Deck B (iframe YouTube, pause pilotée par onPauseDecks)
//   - les 4 mini players de préécoute des combos (ComboPanel.jsx)
//   - le player du mashup personnalisé (ComboPanel.jsx)
//   - le player du mashup final (Mixer.jsx)
// Chacun ne gère que son propre état "playing" local. Dès que 2 lecteurs
// contenant de la voix jouent EN MÊME TEMPS (ex: un combo resté en lecture +
// le mashup final qu'on vient de lancer), ça sonne exactement comme une
// "superposition de voix" — mais ce n'est PAS un bug d'encodage, juste 2
// sources audio du navigateur actives simultanément. Ce module centralise la
// règle une bonne fois pour toutes les paires de lecteurs plutôt que de
// corriger au cas par cas à chaque nouveau lecteur ajouté : dès qu'un lecteur
// commence à jouer, TOUS les autres lecteurs enregistrés sont mis en pause.
const players = new Map(); // id -> pauseFn

// Enregistre un lecteur avec sa fonction de pause — appelé au montage du
// composant (useEffect), renvoie une fonction de nettoyage (à retourner tel
// quel dans le cleanup du useEffect) pour se désinscrire au démontage.
export const registerPlayer = (id, pauseFn) => {
  players.set(id, pauseFn);
  return () => {
    // Ne retire QUE si c'est toujours la même fonction (évite qu'un
    // useEffect qui se redéclenche rapidement n'efface l'enregistrement
    // d'un composant plus récent avec le même id).
    if (players.get(id) === pauseFn) players.delete(id);
  };
};

// Appelé par un lecteur dès qu'IL commence à jouer (son propre onPlay) —
// met en pause tous les autres lecteurs enregistrés, jamais lui-même.
export const notifyPlaying = (id) => {
  for (const [otherId, pause] of players) {
    if (otherId === id) continue;
    try { pause(); } catch (e) { /* lecteur déjà démonté — ignoré, pas bloquant */ }
  }
};
