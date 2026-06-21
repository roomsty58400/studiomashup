import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
// masquée) — stream-copy uniquement (-c copy -an), donc quasi instantané,
// pas de ré-encodage. Cette version sert de base vidéo pour la recomposition
// à l'étape ③ : on ne veut jamais que l'audio d'origine se glisse dans le
// clip final, qui n'utilise que la piste audio choisie.
export const stripAudio = async (videoPath, output) => {
  const cmd = `ffmpeg -i "${videoPath}" -map 0:v:0 -c:v copy -an -movflags +faststart "${output}" -y`;
  await execAsync(cmd, { timeout: 120000 });
  return output;
};
