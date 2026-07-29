import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Codec vidéo réel du fichier (via ffprobe) — permet de vérifier qu'un
// stream-copy ne va pas simplement recopier un codec exotique (VP9/AV1) tel
// quel dans le fichier livré à l'utilisateur.
const probeVideoCodec = async (path) => {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${path}"`
    );
    return stdout.trim().toLowerCase();
  } catch {
    return null; // ffprobe indisponible/échec — on suppose le pire (ré-encodage) par sécurité côté appelant.
  }
};

// ── Recomposition d'un clip : on associe une vidéo source SANS bande son
// (générée en tâche de fond à l'étape ① via stripAudio, cf. plus bas) à une
// nouvelle piste audio (transformée par un outil IA externe — voice swap,
// remix, réorchestration...). On ne mappe QUE l'audio fourni en 2e entrée :
// peu importe que la vidéo ait ou non une bande son, elle n'est jamais
// reprise. -shortest cale la durée sur la plus courte des deux sources pour
// éviter un flux noir/silence en fin de clip si les durées diffèrent
// légèrement après le traitement IA.
export const recomposeReplace = async (videoPath, audioPath, output) => {
  const cmd = `ffmpeg -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 \
-c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "${output}" -y`;
  await execAsync(cmd, { timeout: 240000 });
  return output;
};

// ── Recompose "intelligent" (voice swap / instrumental swap) ──
// Quand l'utilisateur n'a transformé qu'un seul stem (voix OU instrumental)
// avec son outil IA, on reconstitue une piste complète en additionnant ce
// stem transformé avec le stem ORIGINAL complémentaire (celui qui n'a pas
// été touché) — normalize=0 car les deux stems Demucs, sommés sans
// atténuation, reconstituent à peu près le niveau du mix d'origine.
export const combineStems = async (stemPathA, stemPathB, output) => {
  const cmd = `ffmpeg -i "${stemPathA}" -i "${stemPathB}" -filter_complex \
"amix=inputs=2:duration=longest:normalize=0" -ac 2 "${output}" -y`;
  await execAsync(cmd, { timeout: 240000 });
  return output;
};

// ── Copie SANS bande son du clip téléchargé à l'étape ① (en tâche de fond,
// masquée) — stream-copy (quasi instantané) si la vidéo est déjà en H.264,
// sinon ré-encodage forcé (cf. probeVideoCodec ci-dessus). Cette version sert
// de base vidéo pour la recomposition à l'étape ③ : on ne veut jamais que
// l'audio d'origine se glisse dans le clip final, qui n'utilise que la piste
// audio choisie.
export const stripAudio = async (videoPath, output) => {
  // Garde-fou compatibilité lecteur vidéo : certains flux YouTube "mp4"
  // (itags récents haute qualité) sont en réalité encodés en AV1 — un codec
  // que beaucoup de lecteurs (Windows, TV, lecteurs embarqués...) ne savent
  // pas décoder, même dans un conteneur .mp4 valide. ytdlp.js exige déjà
  // vcodec^=avc1 (H.264) en priorité, mais garde ce filet de sécurité au cas
  // où seul un format non-H.264 était disponible pour une vidéo donnée : on
  // ré-encode alors explicitement en H.264 au lieu de recopier tel quel un
  // codec qui se propagerait sans changement jusqu'au fichier final livré à
  // l'utilisateur (stripAudio → recomposeReplace ne ré-encodent jamais après
  // cette étape, cf. commentaires plus haut).
  const codec = await probeVideoCodec(videoPath);
  const isH264 = codec === "h264";
  const videoArgs = isH264
    ? "-c:v copy"
    : "-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p";
  if (!isH264) {
    console.warn(`[clip-editor] vidéo source en codec "${codec || "inconnu"}" (pas H.264) — ré-encodage forcé pour compatibilité lecteur.`);
  }
  const cmd = `ffmpeg -i "${videoPath}" -map 0:v:0 ${videoArgs} -an -movflags +faststart "${output}" -y`;
  await execAsync(cmd, { timeout: isH264 ? 120000 : 600000 });
  return output;
};
