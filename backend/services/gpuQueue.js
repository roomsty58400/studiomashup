// ── File d'attente GPU partagée (audit performance juillet 2026) ────────────
// Constat : Demucs (services/demucs.js) ET le dé-reverb (services/dereverb.js,
// désormais lui aussi sur CUDA) sollicitent tous les deux le même GPU. Un
// commentaire historique de routes/mashup.js documentait déjà le problème :
// "2 process Demucs (GPU ou CPU) simultanés se marchent dessus (contention
// CPU/RAM/VRAM...)" — la seule protection en place jusqu'ici était d'appeler
// prepareTrack(A) PUIS prepareTrack(B) en SÉQUENCE COMPLÈTE (téléchargement +
// extraction + analyse + séparation), ce qui évite bien la contention GPU mais
// sérialise AUSSI tout le reste (téléchargement réseau, extraction ffmpeg,
// analyse Librosa) qui n'a pourtant aucune raison de ne pas tourner en
// parallèle pour les 2 pistes — ces étapes ne touchent ni le GPU ni la même
// ressource contended.
//
// Solution : au lieu de sérialiser des FONCTIONS ENTIÈRES (prepareTrack),
// on sérialise UNIQUEMENT les appels GPU eux-mêmes (Demucs, dé-reverb) via
// cette file d'attente partagée — une simple chaîne de promesses (mutex
// coopératif, pas besoin de librairie externe). Le reste de prepareTrack
// (téléchargement, extraction, Librosa) peut alors tourner librement en
// parallèle pour les pistes A et B (cf. Promise.all dans routes/mashup.js),
// tandis que les 2 appels GPU, eux, continuent à s'exécuter l'un après
// l'autre — jamais simultanément, quel que soit le nombre de jobs en cours
// (mashup.js ET analyze.js partagent cette même file).
let queueTail = Promise.resolve();

// Exécute `fn` une fois que tous les appels GPU précédemment enfilés se sont
// terminés (succès ou échec — un échec ne doit jamais bloquer la file pour
// les appels suivants). Renvoie une promesse qui résout/rejette comme `fn`.
export const runGpuExclusive = (fn) => {
  const result = queueTail.then(fn, fn);
  // Le "tampon" de la file avale toujours les erreurs : sinon un appel GPU en
  // échec (OOM, timeout...) romprait la chaîne et bloquerait indéfiniment
  // tous les appels suivants enfilés après lui.
  queueTail = result.catch(() => {});
  return result;
};
