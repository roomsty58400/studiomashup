import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Durée d'un média (audio ou vidéo) en secondes, via ffprobe.
const getDuration = async (path) => {
  const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${path}"`);
  return parseFloat(stdout.trim()) || 0;
};

// Extraire l'audio en WAV PCM 44100Hz stéréo
export const extractAudio = async (input, output) => {
  const cmd = `ffmpeg -i "${input}" -vn -acodec pcm_s16le -ar 44100 -ac 2 "${output}" -y`;
  await execAsync(cmd, { timeout: 60000 });
  return output;
};

// Recombine N pistes déjà séparées (ex: drums+bass+other de Demucs 4 stems)
// en un seul fichier "instrumental" — un simple amix, quasi instantané (pas
// de GPU, pas de ré-analyse). Utilisé par routes/stems.js pour dériver la
// piste instrumentale 2-stems à partir d'une analyse 4-stems déjà faite
// (cf. /api/analyze) plutôt que de relancer Demucs une 2e fois pour le même
// morceau — ça évite de dupliquer le traitement le plus lent du pipeline.
export const combineTracks = async (inputPaths, output) => {
  const inputs = inputPaths.map(p => `-i "${p}"`).join(" ");
  const n = inputPaths.length;
  const cmd = `ffmpeg ${inputs} -filter_complex "amix=inputs=${n}:duration=longest:dropout_transition=0,alimiter=limit=0.95" "${output}" -y`;
  await execAsync(cmd, { timeout: 60000 });
  return output;
};

// Convertit le réglage crossfade (0-1, balance live) en durée réelle de transition (secondes).
// 0 → 3s (transition courte), 1 → 12s (transition longue/progressive)
const crossfadeToDuration = (crossfade) => Math.round(3 + Math.min(Math.max(crossfade, 0), 1) * 9);

// Mix QUICK : vraie transition DJ dans le temps (acrossfade) — A joue, fondu croisé vers B
// sur N secondes, puis B continue seul. Avant : amix superposait les 2 pistes en entier
// à volume fixe pendant toute la durée → c'est ça qui rendait le mix "pas bon".
export const mixQuick = async (wavA, wavB, crossfade, output) => {
  const dur = crossfadeToDuration(crossfade);
  const cmd = `ffmpeg -i "${wavA}" -i "${wavB}" -filter_complex \
"[0:a]dynaudnorm=f=150:g=15[a0];\
[1:a]dynaudnorm=f=150:g=15[a1];\
[a0][a1]acrossfade=d=${dur}:c1=tri:c2=tri[mixed];\
[mixed]alimiter=level_in=1:level_out=0.95:limit=0.95:attack=5:release=50[out]" \
-map "[out]" -ar 44100 "${output}" -y`;
  await execAsync(cmd, { timeout: 120000 });
  return output;
};

// Mix SMART : B est recalé au tempo de A avant la bascule (pas de saut de rythme au moment
// de la transition), puis vraie transition temporelle (acrossfade) + limiteur anti-saturation.
export const mixSmart = async (wavA, wavB, bpmA, bpmB, crossfade, output) => {
  const ratio = bpmA && bpmB && bpmA > 0 && bpmB > 0
    ? Math.min(Math.max(bpmA / bpmB, 0.5), 2.0).toFixed(4)
    : "1.0";
  const dur = crossfadeToDuration(crossfade);

  const cmd = `ffmpeg -i "${wavA}" -i "${wavB}" -filter_complex \
"[0:a]dynaudnorm=f=150:g=15[a0];\
[1:a]dynaudnorm=f=150:g=15,atempo=${ratio}[a1];\
[a0][a1]acrossfade=d=${dur}:c1=tri:c2=tri[mixed];\
[mixed]alimiter=level_in=1:level_out=0.95:limit=0.95:attack=5:release=50[out]" \
-map "[out]" -ar 44100 "${output}" -y`;
  await execAsync(cmd, { timeout: 180000 });
  return output;
};

// Mix FULL RAVE : voix A + instru B, style RaveDJ
//
// Avant : dynaudnorm (normalisation "relative", pas de cible précise) + un
// boost statique de la voix limité à +30% max + amix par défaut (qui divise
// automatiquement chaque piste par 2 pour éviter la saturation, ANNULANT une
// bonne partie de ce boost) → la voix ressortait noyée derrière l'instru dès
// que la piste B était naturellement plus dense/forte que la piste A.
//
// Maintenant :
// - loudnorm (EBU R128, cible de loudness ABSOLUE en LUFS) sur les deux stems
//   séparément, avec un léger écart en faveur de la voix (≈ 1 à 3 dB selon le
//   réglage crossfade) : assez pour qu'elle reste lisible, sans écraser
//   l'instru comme avec l'écart de ~7 dB de la première version (retour
//   utilisateur : la voix ressortait alors trop AU-DESSUS de l'instru).
// - EQ de présence (boost ~3kHz, modéré) sur la voix : la fait "percer" sans
//   avoir à pousser le volume brut, technique classique de mixage vocal.
// - Sidechain ducking lissé (attack/release allongés, ratio doux) : l'instru
//   descend et remonte progressivement plutôt que par à-coups façon "fader"
//   à chaque syllabe — retour utilisateur : les transitions étaient trop
//   marquées/saccadées, il fallait lisser pour que ça s'harmonise.
// - amix avec normalize=0 : on garde le contrôle exact du volume relatif
//   fixé ci-dessus, au lieu de laisser ffmpeg rediviser tout par 2.
// - Le réglage crossfade du Mixer pilote ici l'équilibre voix/instru (pas un
//   fondu temporel comme en mode QUICK) : à 0, priorité à la voix ; à 1,
//   plus de place pour l'instru.
// Calcule le ratio de calage tempo (instru B → tempo de A), avec 2 garde-fous
// contre le "rythme complètement cassé" / "son déformé" rapportés :
//   1) Correction d'octave : la détection de BPM (beat_track de Librosa) se
//      trompe régulièrement d'un facteur 2 (rapporte 70 au lieu de 140, ou
//      l'inverse) — un classique des algos de beat-tracking sur certains
//      genres. On teste le ratio direct ET son double/sa moitié, et on garde
//      celui qui demande le MOINS de correction (le plus proche de 1), ce qui
//      neutralise ce cas d'erreur sans avoir besoin de "deviner" laquelle des
//      2 BPM est fausse.
//   2) Fenêtre de qualité audio : le filtre "atempo" de ffmpeg dégrade
//      audiblement le son (artefacts métalliques/saturés) au-delà d'un
//      étirement d'environ ±30-40%. Au-delà de cette fenêtre, on préfère NE
//      PAS étirer du tout (ratio 1.0) — un léger décalage de tempo est moins
//      gênant à l'oreille qu'un instrumental déformé par un atempo extrême.
const safeTempoRatio = (bpmA, bpmB) => {
  if (!bpmA || !bpmB || bpmA <= 0 || bpmB <= 0) return 1.0;
  const raw = bpmA / bpmB;
  const candidates = [raw, raw * 2, raw / 2];
  const best = candidates.reduce((a, b) => Math.abs(Math.log2(b)) < Math.abs(Math.log2(a)) ? b : a);
  const SAFE_MIN = 0.72, SAFE_MAX = 1.4;
  if (best < SAFE_MIN || best > SAFE_MAX) {
    console.warn(`[mixFullRave] ratio tempo ${best.toFixed(3)} hors fenêtre qualité (BPM A=${bpmA}, B=${bpmB}) — pas d'étirement appliqué`);
    return 1.0;
  }
  return best;
};

export const mixFullRave = async (vocalsA, instrumentalB, bpmA, bpmB, crossfade, output) => {
  const ratio = safeTempoRatio(bpmA, bpmB).toFixed(4);
  console.log(`[mixFullRave] BPM A=${bpmA} B=${bpmB} → ratio tempo appliqué=${ratio}`);

  const cf = Math.min(Math.max(crossfade, 0), 1);
  // Retour utilisateur : la voix ressort encore "un chouilla" trop fort par
  // rapport à l'instru — on resserre l'écart de 1 dB de plus (voix -0.5 dB,
  // instru +0.5 dB autour d'un même pivot -15.5), sans changer le volume
  // global du mix (la baisse côté voix compense la hausse côté instru).
  const vocalsLUFS = (-15.5 + (1 - cf) * 1).toFixed(1);  // -15.5 (cf=1) → -14.5 (cf=0)
  const instruLUFS = (-15.5 - (1 - cf) * 1).toFixed(1);  // -15.5 (cf=1) → -16.5 (cf=0)

  const cmd = `ffmpeg -i "${vocalsA}" -i "${instrumentalB}" -filter_complex \
"[0:a]highpass=f=80,lowpass=f=16000,loudnorm=I=${vocalsLUFS}:TP=-1.5:LRA=11,equalizer=f=3000:width_type=o:width=2:g=2.5[vocals];\
[vocals]asplit=2[vocals_out][vocals_sc];\
[1:a]loudnorm=I=${instruLUFS}:TP=-1.5:LRA=11,atempo=${ratio}[instru_norm];\
[instru_norm]aformat=sample_fmts=fltp:channel_layouts=stereo[instru_fmt];\
[vocals_sc]aformat=sample_fmts=fltp:channel_layouts=stereo[vocals_scfmt];\
[instru_fmt][vocals_scfmt]sidechaincompress=threshold=0.06:ratio=2.5:attack=30:release=600:makeup=1[instru_ducked];\
[vocals_out][instru_ducked]amix=inputs=2:duration=longest:dropout_transition=4:normalize=0[mixed];\
[mixed]alimiter=level_in=1:level_out=0.97:limit=0.95:attack=5:release=50[out]" \
-map "[out]" -ar 44100 "${output}" -y`;
  await execAsync(cmd, { timeout: 180000 });
  return output;
};

// Export MP3 320k
// N.B. : pas d'équivalent CUDA possible ici — libmp3lame est un codec audio
// purement logiciel (mono-thread par conception), ffmpeg/NVIDIA n'offrent
// aucun encodeur MP3 accéléré GPU. L'encodage MP3 reste de toute façon quasi
// instantané (l'audio est ~1000x plus léger à encoder que la vidéo), donc il
// n'y a rien de significatif à gagner ici contrairement à l'export MP4.
export const exportMP3 = async (input, output) => {
  const cmd = `ffmpeg -i "${input}" -codec:a libmp3lame -b:a 320k -id3v2_version 3 "${output}" -y`;
  await execAsync(cmd, { timeout: 60000 });
  return output;
};

// Export FLAC — sans perte, pour ceux qui veulent garder toute la qualité du
// mashup (notamment utile en mode FULL RAVE où le mix repasse par Demucs +
// loudnorm : éviter une double perte de qualité MP3 sur un résultat déjà
// retravaillé). Même remarque que pour le MP3 : FLAC est un codec logiciel,
// pas d'accélération GPU disponible ni nécessaire (encodage quasi instantané).
export const exportFLAC = async (input, output) => {
  const cmd = `ffmpeg -i "${input}" -codec:a flac -compression_level 5 "${output}" -y`;
  await execAsync(cmd, { timeout: 60000 });
  return output;
};

// Rythme du montage vidéo alterné — réutilise le même réglage "crossfade" du
// Mixer que pour l'équilibre voix/instru audio (FULL RAVE), pour que le seul
// curseur existant pilote aussi le rythme des coupes vidéo : à 0, montage
// dynamique (coupes rapprochées) ; à 1, montage posé (segments plus longs).
const videoSegmentDuration = (cf) => 6 + Math.min(Math.max(cf, 0), 1) * 8;   // 6s → 14s
const videoXfadeDuration   = (cf) => 0.4 + Math.min(Math.max(cf, 0), 1) * 0.8; // 0.4s → 1.2s

// Construit le filter_complex d'un montage qui ALTERNE plein cadre entre la
// vidéo A et la vidéo B (au lieu d'un split-screen permanent), avec un fondu
// (xfade) à chaque coupe — plus cohérent à l'œil qu'un split-screen statique
// sur toute la durée, et façon montage clip plutôt que vidéoconférence.
//
// Chaque segment avance dans SA PROPRE vidéo source (segment 1 de A part de
// 0s, segment 2 de A part de {segmentSec}s, etc.) plutôt que de toujours
// rejouer le même extrait — avec un bouclage (modulo) sur la durée réelle de
// la source si elle est plus courte que ce qu'il faudrait pour couvrir toute
// la durée du montage.
// Plafond du nombre de segments/transitions de la chaîne xfade : un montage
// filter_complex avec BEAUCOUP de branches trim + de xfade séquentiels (ex:
// ~30 pour un morceau de 5 min avec des segments de 9s) fait exploser la
// mémoire de libavfilter ("Cannot allocate memory" en cours de filtrage) —
// chaque transition de la chaîne doit bufferiser ses frames en attendant que
// toute la chaîne en amont les consomme, et ce coût s'accumule avec la
// profondeur de la chaîne (nombre de xfade), pas avec la durée du morceau.
// On plafonne donc le nombre de segments en allongeant leur durée plutôt que
// d'allonger la chaîne — un montage à coupes plus espacées sur un titre long
// reste cohérent visuellement, et surtout ne fait plus planter l'export.
const MAX_SEGMENTS = 12;

const buildAlternatingFilter = (totalSec, durA, durB, segmentSec, xfadeSec, hwDecoded) => {
  const pre = hwDecoded ? "hwdownload,format=yuv420p," : "";
  let numSegments = Math.max(2, Math.ceil(totalSec / segmentSec));
  // Recalcule une durée de segment plus longue si on dépasse le plafond, au
  // lieu de garder des segments courts sur une chaîne de transitions énorme.
  if (numSegments > MAX_SEGMENTS) {
    numSegments = MAX_SEGMENTS;
    segmentSec = totalSec / numSegments;
  }

  const segments = [];
  let occA = 0, occB = 0;
  for (let i = 0; i < numSegments; i++) {
    const isA = i % 2 === 0;
    const srcIdx = isA ? 0 : 1;
    const srcDur = isA ? durA : durB;
    const occ = isA ? occA++ : occB++;
    const span = Math.max(srcDur - segmentSec, 1); // évite un trim qui dépasse la fin de la source
    const start = srcDur > 0 ? (occ * segmentSec) % span : 0;
    // fps=30 forcé explicitement : sans ça, xfade refuse de combiner deux
    // segments dont les sources ont des framerates/timebases différents
    // (ex: 29.97 fps vs 25 fps, vu en pratique) — "First input link main
    // timebase ... do not match ... xfade timebase", l'export plante net dès
    // la 1ère transition entre une vidéo A et une vidéo B. Aligner tous les
    // segments sur un même fps de sortie, quelle que soit leur source, règle
    // ça une fois pour toutes.
    // format=yuv420p forcé explicitement : sans ça, le mélange de deux
    // sources aux espaces colorimétriques légèrement différents (bt709 vs
    // smpte170m, vu en pratique) peut faire retomber libavfilter sur du
    // yuv444p en interne pour le xfade — environ 2x plus de mémoire par
    // frame à 1080x1920, ce qui aggrave encore le risque d'OOM ci-dessus.
    segments.push(
      `[${srcIdx}:v]${pre}trim=start=${start.toFixed(2)}:duration=${segmentSec.toFixed(2)},setpts=PTS-STARTPTS,` +
      `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[seg${i}]`
    );
  }

  const xfades = [];
  let prevLabel = "seg0";
  let runningDuration = segmentSec;
  for (let i = 1; i < numSegments; i++) {
    const outLabel = i === numSegments - 1 ? "v" : `x${i}`;
    const offset = Math.max(0, runningDuration - xfadeSec);
    xfades.push(`[${prevLabel}][seg${i}]xfade=transition=fade:duration=${xfadeSec.toFixed(2)}:offset=${offset.toFixed(2)}[${outLabel}]`);
    runningDuration += segmentSec - xfadeSec;
    prevLabel = outLabel;
  }

  return `"${segments.join(";")};${xfades.join(";")}"`;
};

const ENCODE_GPU = `-c:v h264_nvenc -preset p4 -tune hq -rc vbr -cq 22 -b:v 0 -c:a aac -b:a 192k -movflags +faststart -shortest`;
const ENCODE_CPU = `-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -movflags +faststart -shortest`;

// crossfade (0-1, même réglage que le Mixer) pilote le rythme du montage —
// cf. videoSegmentDuration/videoXfadeDuration ci-dessus.
export const exportMP4_916 = async (videoA, videoB, audioMix, output, crossfade = 0.5) => {
  const [totalSec, durA, durB] = await Promise.all([
    getDuration(audioMix), getDuration(videoA), getDuration(videoB),
  ]);
  const segmentSec = videoSegmentDuration(crossfade);
  const xfadeSec = videoXfadeDuration(crossfade);
  console.log(`[ffmpeg] montage alterné : segments ${segmentSec}s, fondus ${xfadeSec.toFixed(2)}s, durée totale ${totalSec.toFixed(1)}s`);

  const buildCmd = (hwDecode, encodeArgs, hwInputArgs) => {
    const filter = buildAlternatingFilter(totalSec, durA, durB, segmentSec, xfadeSec, hwDecode);
    return `ffmpeg ${hwInputArgs}-i "${videoA}" ${hwInputArgs}-i "${videoB}" -i "${audioMix}" ` +
      `-filter_complex ${filter} -map "[v]" -map 2:a ${encodeArgs} "${output}" -y`;
  };

  const cmdGpuFull = buildCmd(true, ENCODE_GPU, "-hwaccel cuda -hwaccel_output_format cuda ");
  const cmdGpuEncodeOnly = buildCmd(false, ENCODE_GPU, "");
  const cmdCPU = buildCmd(false, ENCODE_CPU, "");

  try {
    await execAsync(cmdGpuFull, { timeout: 300000 });
    console.log("[ffmpeg] export MP4 : décodage + encodage GPU (CUDA/NVENC)");
    return output;
  } catch (e) {
    console.warn("[ffmpeg] décodage CUDA indisponible, repli sur décodage CPU + encodage NVENC :", e.message?.split("\n")[0]);
  }

  try {
    await execAsync(cmdGpuEncodeOnly, { timeout: 300000 });
    console.log("[ffmpeg] export MP4 : encodage GPU (NVENC), décodage CPU");
    return output;
  } catch (e) {
    console.warn("[ffmpeg] NVENC indisponible, repli complet sur le CPU (libx264) :", e.message?.split("\n")[0]);
  }

  await execAsync(cmdCPU, { timeout: 300000 });
  console.log("[ffmpeg] export MP4 : CPU complet (libx264)");
  return output;
};
