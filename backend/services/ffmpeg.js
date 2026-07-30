import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { copyFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { detectSceneCuts } from "./videoAnalysis.js";
import { planMusicSyncedCuts, planMultiSourceCuts } from "./videoCutPlanner.js";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Watermark vidéo — DÉSACTIVÉ (demande explicite, 24/07/2026) ──────────
// Actif entre juillet 2026 (incrusté en bas à droite de chaque export MP4)
// et sa désactivation ci-dessous. Le mécanisme de conversion .ico → .png est
// laissé en place (inoffensif, jamais appelé) plutôt que supprimé : tous les
// appelants (buildSilentVideoMontage, buildMultiSourceVideoMontage,
// buildFilterFromPlan) dégradent déjà proprement quand ensureWatermarkPng()
// renvoie null (c'était prévu à l'origine pour le cas "icon.ico absent"),
// donc forcer null ici retire le watermark de tous les exports sans toucher
// au reste de la construction du filter_complex — le chemin le plus sûr.
// Pour réactiver : remettre `return _watermarkPngPath;` en tête de fonction.
const WATERMARK_ICO_PATH = join(__dirname, "../../icon.ico");
const WATERMARK_PNG_PATH = join(__dirname, "../data/watermark.png");
let _watermarkPngPath = null; // résolu au 1er appel de ensureWatermarkPng()
let _watermarkChecked = false;

// Jamais bloquant : toute erreur (icon.ico absent, ffmpeg incapable de le
// décoder, etc.) fait simplement continuer l'export SANS watermark plutôt
// que de faire échouer tout le mashup pour un défaut purement cosmétique.
const ensureWatermarkPng = async () => {
  return null; // watermark désactivé — cf. commentaire ci-dessus
  // eslint-disable-next-line no-unreachable
  if (_watermarkChecked) return _watermarkPngPath;
  _watermarkChecked = true;
  if (existsSync(WATERMARK_PNG_PATH)) {
    _watermarkPngPath = WATERMARK_PNG_PATH;
    return _watermarkPngPath;
  }
  if (!existsSync(WATERMARK_ICO_PATH)) {
    console.warn(`⚠️ [ffmpeg] watermark introuvable (${WATERMARK_ICO_PATH}) — exports vidéo générés SANS watermark. Place un fichier "icon.ico" à la racine du projet pour l'activer.`);
    return null;
  }
  try {
    // -frames:v 1 : ne garde que la 1ère image du fichier .ico (généralement
    // la plus grande résolution embarquée) — évite toute ambiguïté de
    // "séquence" côté démuxeur ico. -y : écrase un essai précédent éventuel.
    await execAsync(`ffmpeg -y -i "${WATERMARK_ICO_PATH}" -frames:v 1 "${WATERMARK_PNG_PATH}"`, { timeout: 15000 });
    _watermarkPngPath = WATERMARK_PNG_PATH;
    console.log(`✅ [ffmpeg] watermark converti en PNG (${WATERMARK_PNG_PATH}), réutilisé pour tous les exports suivants`);
  } catch (e) {
    console.warn(`⚠️ [ffmpeg] conversion du watermark (icon.ico → PNG) échouée — exports vidéo générés SANS watermark :`, e.message?.split("\n")[0]);
    _watermarkPngPath = null;
  }
  return _watermarkPngPath;
};

// ── Détection du filtre rubberband (pitch-shift haute qualité) ───────────
// rubberband est compilé dans FFmpeg uniquement si librubberband est présente
// lors de la compilation (cas des builds "full" ; absent des builds allégés).
// Testé une seule fois au chargement du module — résultat mis en cache.
// Si absent → repli transparent sur asetrate+atempo (correct pour ≤ 6 st).
let _hasRubberband = null;
const hasRubberband = async () => {
  if (_hasRubberband !== null) return _hasRubberband;
  try {
    const { stdout } = await execAsync("ffmpeg -filters 2>&1 | grep -c rubberband", { timeout: 5000 });
    _hasRubberband = parseInt(stdout.trim()) > 0;
  } catch {
    _hasRubberband = false;
  }
  console.log(`[ffmpeg] rubberband: ${_hasRubberband ? "✅ disponible (pitch-shift HQ)" : "❌ absent → repli asetrate+atempo"}`);
  return _hasRubberband;
};

// Durée d'un média (audio ou vidéo) en secondes, via ffprobe. Exportée
// (audit perf juillet 2026) : routes/mashup.js en a besoin pour précalculer
// la durée totale cible AVANT que le mixage audio ne soit terminé, afin de
// démarrer le montage vidéo en parallèle (cf. buildSilentVideoMontage plus
// bas) — ffprobe ne fait que lire les métadonnées du conteneur, coût
// négligeable même appelé une 2e fois sur le même fichier.
export const getDuration = async (path) => {
  const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${path}"`);
  return parseFloat(stdout.trim()) || 0;
};

// Le format cible visé par cette fonction — utilisé aussi par le garde-fou
// ci-dessous pour détecter quand la conversion est déjà inutile.
const TARGET_CODEC = "pcm_s16le", TARGET_RATE = "44100", TARGET_CHANNELS = 2;

// L'entrée est-elle déjà EXACTEMENT dans le format cible (WAV PCM 44.1kHz
// stéréo) ? Utilisé pour éviter une passe ffmpeg complète (décodage +
// ré-encodage de tout le fichier) quand ce n'est pas nécessaire — notamment
// pour l'audio téléchargé via yt-dlp (services/ytdlp.js), qui produit
// désormais déjà ce format exact en une seule passe (--postprocessor-args).
// ffprobe ne fait que lire les métadonnées du conteneur (quasi instantané,
// indépendant de la durée du fichier), donc ce garde-fou coûte beaucoup
// moins cher que la conversion qu'il permet d'éviter.
const isAlreadyTargetFormat = async (path) => {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "${path}"`,
      { timeout: 10000 },
    );
    const [codec, rate, channels] = stdout.trim().split(",");
    return codec === TARGET_CODEC && rate === TARGET_RATE && Number(channels) === TARGET_CHANNELS;
  } catch {
    return false; // en cas de doute, on repasse par la conversion complète (sûr par défaut)
  }
};

// Extraire l'audio en WAV PCM 44100Hz stéréo
export const extractAudio = async (input, output) => {
  // Repli rapide : si l'entrée est déjà exactement dans ce format (cas
  // fréquent depuis que yt-dlp le produit directement), une simple copie de
  // fichier suffit — pas besoin de redécoder/ré-encoder tout l'audio pour
  // rien. Sinon (upload utilisateur en MP3/OGG/etc., ou format inattendu),
  // conversion ffmpeg complète comme avant.
  if (input !== output && await isAlreadyTargetFormat(input)) {
    await copyFile(input, output);
    return output;
  }
  const cmd = `ffmpeg -i "${input}" -vn -acodec ${TARGET_CODEC} -ar ${TARGET_RATE} -ac ${TARGET_CHANNELS} "${output}" -y`;
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

// ── Cache disque de l'instrumental dérivé (drums+bass+other) ──────────────
// Constaté en pratique : routes/stems.js ET routes/mashup.js relançaient un
// amix ffmpeg complet (décodage de 3 flux + ré-encodage FLAC) à CHAQUE fois
// qu'un morceau déjà analysé (4 stems Demucs en cache) était réutilisé — par
// ex. un même morceau demandé successivement par le Deck, l'export de stems,
// puis un mashup. Ce calcul est pourtant entièrement déterministe pour un
// jeu de stems donné : pas la peine de le refaire. On écrit le résultat une
// seule fois À CÔTÉ des stems eux-mêmes (même dossier que drumsPath, donc
// déjà unique par morceau) et on le réutilise tel quel ensuite — évite un
// pass ffmpeg entier (le 2e poste de temps du pipeline après Demucs) à
// chaque réutilisation d'un morceau déjà traité.
// Rest params (...stemPaths) plutôt que 3 arguments nommés fixes : depuis
// l'ajout du sélecteur 2/4/6 stems, l'instrumental peut se combiner à partir
// de 3 pistes (mode 4 : drums/bass/other) ou 5 (mode 6 : + guitar/piano) —
// cette fonction reste agnostique du nombre exact, seul le 1er chemin sert à
// déterminer où écrire le cache (même dossier que les stems, déjà unique par
// morceau).
export const getCachedInstrumental = async (...stemPaths) => {
  const cachedPath = join(dirname(stemPaths[0]), "instrumental_combined.flac");
  if (existsSync(cachedPath)) return cachedPath;
  await combineTracks(stemPaths, cachedPath);
  return cachedPath;
};

// ── Mixdown "mix perso" (cadre FadrMacheUp, ClipEditor) ──────────────────
// Recombine N stems déjà séparés en un seul export audio, pondéré par les
// réglages mute/solo/volume/pan choisis par l'utilisateur — pas de
// génération IA, un simple mixage ffmpeg des pistes déjà sur le disque.
// `stems` : [{ path, volume (0-4, 1=neutre), pan (-1..1, 0=centré), mute,
// solo }]. Si au moins un stem est solo=true, seuls les stems solo sont
// inclus (comportement console de mixage classique) ; les autres se
// comportent alors comme mute pour cet export, qu'ils soient mute=true ou non.
// Le pan utilise une loi simple (gain linéaire par canal, pas de loi -3dB
// constant-power) : suffisant pour un outil perso, pas un mastering.
export const mixStemsCustom = async (stems, output) => {
  const hasSolo = stems.some(s => s.solo);
  const active = stems.filter(s => !s.mute && (!hasSolo || s.solo));
  if (active.length === 0) {
    throw new Error("Aucun stem actif (tout est coupé/muet) — impossible d'exporter un mix vide.");
  }

  const inputs = active.map(s => `-i "${s.path}"`).join(" ");
  const panStages = active.map((s, i) => {
    const vol = Math.max(0, Math.min(4, Number(s.volume) ?? 1));
    const pan = Math.max(-1, Math.min(1, Number(s.pan) ?? 0));
    const leftGain = (pan <= 0 ? 1 : 1 - pan) * vol;
    const rightGain = (pan >= 0 ? 1 : 1 + pan) * vol;
    return `[${i}:a]pan=stereo|c0=${leftGain.toFixed(4)}*c0|c1=${rightGain.toFixed(4)}*c1[s${i}]`;
  });
  const mixInputs = active.map((_, i) => `[s${i}]`).join("");
  const filterComplex = `${panStages.join(";")};${mixInputs}amix=inputs=${active.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95[out]`;

  const cmd = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[out]" -ar 44100 "${output}" -y`;
  await execAsync(cmd, { timeout: 120000 });
  return output;
};

// ── Effet de genre (cadre FadrMacheUp) ────────────────────────────────────
// Retour utilisateur (30/07) : une vraie génération audio IA par genre (testé
// via ElevenLabs Music) coûte trop cher pour un usage perso régulier (~0,15$/
// minute générée). Repli sur l'option gratuite envisagée en amont : de VRAIS
// effets audio ffmpeg (EQ, compression, saturation, largeur stéréo, écho,
// parfois pitch) qui changent audiblement le TIMBRE du mix existant, par
// genre — pas une nouvelle composition, une coloration du morceau de
// l'utilisateur. Rendu quasi instantané (un seul passage ffmpeg, pas d'appel
// réseau externe), zéro coût, zéro clé API à configurer.
//
// Chaque preset ne définit QUE ce qui s'écarte du neutre — un compresseur +
// limiteur final est toujours appliqué (glue + garde-fou anti-écrêtage,
// cf. acompressor/alimiter), les autres étages (EQ/saturation/largeur/écho/
// pitch) sont optionnels par genre.
export const GENRE_DSP_PRESETS = {
  "R&B": {
    eq: [{ f: 120, g: 3, width: 1 }, { f: 3000, g: 2, width: 1.2 }],
    compressor: { threshold: 0.15, ratio: 3, attack: 20, release: 200, makeup: 1.6 },
  },
  "Rock": {
    eq: [{ f: 90, g: -1.5, width: 1 }, { f: 2500, g: 4, width: 1 }, { f: 6000, g: 2, width: 1 }],
    crusher: { bits: 14 },
    compressor: { threshold: 0.12, ratio: 4, attack: 8, release: 120, makeup: 1.8 },
  },
  "Trap": {
    eq: [{ f: 60, g: 6, width: 0.8 }, { f: 150, g: -2, width: 1 }, { f: 8000, g: 2, width: 1 }],
    compressor: { threshold: 0.1, ratio: 5, attack: 5, release: 100, makeup: 1.8 },
  },
  "Drill": {
    eq: [{ f: 55, g: 6, width: 0.8 }, { f: 200, g: -2, width: 1 }],
    compressor: { threshold: 0.08, ratio: 6, attack: 3, release: 80, makeup: 2 },
  },
  "Hard Techno": {
    eq: [{ f: 50, g: 4, width: 0.8 }, { f: 3000, g: 3, width: 1 }],
    crusher: { bits: 10 },
    compressor: { threshold: 0.06, ratio: 8, attack: 2, release: 60, makeup: 2.2 },
  },
  "Future Garage": {
    eq: [{ f: 100, g: 2, width: 1 }, { f: 9000, g: -4, width: 1 }],
    echo: { inGain: 0.8, outGain: 0.7, delay: 90, decay: 0.25 },
    compressor: { threshold: 0.2, ratio: 2.5, attack: 25, release: 250, makeup: 1.3 },
  },
  "Disco House": {
    eq: [{ f: 100, g: 3, width: 1 }, { f: 4000, g: 3, width: 1 }],
    widen: 1.35,
    compressor: { threshold: 0.15, ratio: 3, attack: 10, release: 150, makeup: 1.6 },
  },
  "Deep House": {
    eq: [{ f: 90, g: 3, width: 1 }, { f: 8000, g: -3, width: 1 }],
    widen: 1.2,
    compressor: { threshold: 0.18, ratio: 2.5, attack: 15, release: 200, makeup: 1.4 },
  },
  "Minimal House": {
    eq: [{ f: 3000, g: -2, width: 1 }],
    widen: 0.7,
    compressor: { threshold: 0.15, ratio: 4, attack: 10, release: 150, makeup: 1.5 },
  },
  "Tech House": {
    eq: [{ f: 70, g: 3, width: 0.9 }, { f: 3500, g: 2.5, width: 1 }],
    compressor: { threshold: 0.12, ratio: 4, attack: 8, release: 130, makeup: 1.7 },
  },
  "Drum and Bass": {
    eq: [{ f: 55, g: 5, width: 0.8 }, { f: 9000, g: 3, width: 1 }],
    compressor: { threshold: 0.08, ratio: 5, attack: 4, release: 90, makeup: 2 },
  },
  "Phonk": {
    eq: [{ f: 60, g: 6, width: 0.8 }, { f: 5000, g: -3, width: 1 }],
    crusher: { bits: 9 },
    pitchSemitones: -2,
    compressor: { threshold: 0.1, ratio: 4, attack: 10, release: 150, makeup: 1.8 },
  },
};

export const applyGenreEffect = async (inputPath, genreKey, output) => {
  const preset = GENRE_DSP_PRESETS[genreKey];
  if (!preset) throw new Error(`Genre inconnu : "${genreKey}".`);

  const rbAvailable = preset.pitchSemitones ? await hasRubberband() : false;
  const stages = [];
  let label = "0:a";
  let stageIdx = 0;
  const nextLabel = () => `gfx${stageIdx++}`;

  for (const band of preset.eq || []) {
    const out = nextLabel();
    stages.push(`[${label}]equalizer=f=${band.f}:width_type=o:width=${band.width}:g=${band.g}[${out}]`);
    label = out;
  }

  if (preset.crusher) {
    const out = nextLabel();
    stages.push(`[${label}]acrusher=bits=${preset.crusher.bits}:mode=log:aa=1[${out}]`);
    label = out;
  }

  if (preset.widen) {
    const out = nextLabel();
    stages.push(`[${label}]extrastereo=m=${preset.widen}[${out}]`);
    label = out;
  }

  if (preset.echo) {
    const out = nextLabel();
    const { inGain, outGain, delay, decay } = preset.echo;
    stages.push(`[${label}]aecho=${inGain}:${outGain}:${delay}:${decay}[${out}]`);
    label = out;
  }

  // Pitch (ex: Phonk, léger "slowed") — rubberband si dispo (qualité, garde
  // le tempo inchangé), sinon repli asetrate+atempo (même pattern que le
  // reste de ce fichier, cf. alignAndCombineStems plus haut).
  if (preset.pitchSemitones) {
    const ratio = Math.pow(2, preset.pitchSemitones / 12);
    const out = nextLabel();
    if (rbAvailable) {
      stages.push(`[${label}]rubberband=pitch=${ratio.toFixed(6)}:tempo=1[${out}]`);
    } else {
      stages.push(`[${label}]asetrate=44100*${ratio.toFixed(6)},aresample=44100,atempo=${(1 / ratio).toFixed(6)}[${out}]`);
    }
    label = out;
  }

  const c = preset.compressor || {};
  const out = nextLabel();
  stages.push(
    `[${label}]acompressor=threshold=${c.threshold ?? 0.15}:ratio=${c.ratio ?? 3}:attack=${c.attack ?? 15}:release=${c.release ?? 150}:makeup=${c.makeup ?? 1.5},alimiter=limit=0.95[${out}]`
  );
  label = out;

  const cmd = `ffmpeg -i "${inputPath}" -filter_complex "${stages.join(";")}" -map "[${label}]" -ar 44100 "${output}" -y`;
  await execAsync(cmd, { timeout: 120000 });
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
//   2) Fenêtre de qualité audio, dépendante de la méthode d'étirement dispo :
//      - atempo (filtre ffmpeg natif, PSOLA) dégrade audiblement le son
//        (artefacts métalliques/saturés) au-delà d'environ ±30-40% — d'où la
//        fenêtre conservatrice ci-dessous pour ce cas.
//      - rubberband (phase-vocoder HQ, déjà utilisé pour le pitch-shift de la
//        voix) tolère un étirement bien plus large (jusqu'à 2x/0.5x — "half-
//        time/double-time" en DJing) sans ces artefacts : on élargit donc la
//        fenêtre quand rubberband est disponible, ce qui réduit nettement les
//        cas où AUCUNE correction n'est appliquée.
//      Hors fenêtre (quelle qu'elle soit), on préfère NE PAS étirer du tout
//      (ratio 1.0) plutôt que produire un son déformé — mais un ratio 1.0 ici
//      signifie aussi que la voix et l'instru vont dériver rythmiquement l'un
//      par rapport à l'autre sur toute la durée du morceau (aucune correction
//      de tempo n'étant appliquée) : c'est un compromis qualité/synchro
//      assumé, pas un bug — cf. mixFullRave/mixFullRaveDuo qui journalisent
//      ce cas.
const safeTempoRatio = (bpmA, bpmB, rbAvailable = false) => {
  if (!bpmA || !bpmB || bpmA <= 0 || bpmB <= 0) return 1.0;
  const raw = bpmA / bpmB;
  const candidates = [raw, raw * 2, raw / 2];
  const best = candidates.reduce((a, b) => Math.abs(Math.log2(b)) < Math.abs(Math.log2(a)) ? b : a);
  const [SAFE_MIN, SAFE_MAX] = rbAvailable ? [0.5, 2.0] : [0.72, 1.4];
  if (best < SAFE_MIN || best > SAFE_MAX) {
    console.warn(`[mixFullRave] ratio tempo ${best.toFixed(3)} hors fenêtre qualité (BPM A=${bpmA}, B=${bpmB}, rubberband=${rbAvailable}) — pas d'étirement appliqué : la voix et l'instru risquent de dériver rythmiquement l'un par rapport à l'autre sur toute la durée du morceau.`);
    return 1.0;
  }
  return best;
};

// ── Correction de dérive rythmique par tempo LOCAL (anti-"décrochage") ───
//
// Constat (retour utilisateur + audit du pipeline) : safeTempoRatio ci-dessus
// calcule UN SEUL ratio à partir du BPM MOYEN de chaque piste, appliqué tel
// quel sur TOUTE la durée du mashup — valable seulement si les 2 pistes ont
// un tempo parfaitement constant. Un morceau réel (surtout une voix chantée
// "live") a presque toujours un tempo qui fluctue légèrement : l'écart
// s'accumule alors progressivement sur la durée du morceau, ressenti comme un
// décalage croissant entre voix et instru. Les fonctions ci-dessous exploitent
// la grille de beats COMPLÈTE désormais exportée par analyzer.js (beat_times,
// plus seulement les 12 premières secondes) pour recalculer un tempo LOCAL à
// intervalles réguliers plutôt qu'un seul BPM moyen — voir buildTempoSchedule.

// Tempo local (BPM) autour d'un instant donné, à partir de l'intervalle
// inter-beats MÉDIAN (pas la moyenne : robuste à un beat isolé mal détecté)
// sur une fenêtre de beats réels proches de `atTime`. Renvoie null si la
// grille est absente/trop pauvre à cet endroit — l'appelant retombe alors sur
// le BPM moyen global pour CE segment précis (dégradation locale, pas totale).
const computeLocalBpm = (beatTimes, atTime, windowBeats = 6) => {
  if (!Array.isArray(beatTimes) || beatTimes.length < 4) return null;
  let idx = beatTimes.findIndex(t => t >= atTime);
  if (idx === -1) idx = beatTimes.length - 1;
  const lo = Math.max(0, idx - windowBeats);
  const hi = Math.min(beatTimes.length - 1, idx + windowBeats);
  const window = beatTimes.slice(lo, hi + 1);
  if (window.length < 4) return null;
  const intervals = [];
  for (let i = 1; i < window.length; i++) {
    const d = window[i] - window[i - 1];
    // Écarte les écarts aberrants (silence/beat manqué > 2s, ou quasi-doublon
    // < 150ms) qui fausseraient la médiane.
    if (d > 0.15 && d < 2.0) intervals.push(d);
  }
  if (intervals.length < 3) return null;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  return median > 0 ? 60 / median : null;
};

// Construit un plan de correction PAR SEGMENT (au lieu d'un seul ratio
// global) pour l'étirement temporel de l'instrumental dans mixFullRave.
// Renvoie null quand il n'y a rien à gagner à découper (grille absente pour
// les 2 pistes, ou tous les ratios locaux retombent sur la même valeur à
// ±1% près) — dans ce cas l'appelant retombe intégralement sur le
// comportement historique (un seul rubberband/atempo pour toute la piste),
// donc AUCUNE régression pour un morceau sans grille de beats (uploads
// locaux, morceaux analysés avant cet ajout).
//
// outputDurationSec : durée totale visée du mix (voix + intro instru seul).
// vocalDelaySec : durée de l'intro instru-seul avant l'entrée de la voix.
// vocalsStartOffset/instruStartOffset : offsets de départ (secondes, dans le
// fichier source ORIGINAL) déjà choisis par pickBestSegmentPair/
// snapToMeasureBoundary (routes/mashup.js).
const TARGET_SEGMENT_SEC = 20;
const buildTempoSchedule = ({
  outputDurationSec, vocalDelaySec,
  vocalsStartOffset, instruStartOffset,
  beatTimesVocals, beatTimesInstru,
  globalBpmVocals, globalBpmInstru, rbAvailable,
}) => {
  const hasVocalsGrid = Array.isArray(beatTimesVocals) && beatTimesVocals.length >= 4;
  const hasInstruGrid = Array.isArray(beatTimesInstru) && beatTimesInstru.length >= 4;
  if (!hasVocalsGrid && !hasInstruGrid) return null;
  if (!outputDurationSec || outputDurationSec <= 0 || !isFinite(outputDurationSec)) return null;

  const n = Math.min(Math.max(Math.round(outputDurationSec / TARGET_SEGMENT_SEC), 3), 16);
  if (n < 2) return null;
  const segLen = outputDurationSec / n;

  let instruCursorRel = 0; // position relative au flux DÉJÀ trimé sur instruStartOffset (0 = instruStartOffset dans le fichier original)
  const segments = [];
  for (let i = 0; i < n; i++) {
    const outStart = i * segLen;
    const outEnd = i === n - 1 ? outputDurationSec : (i + 1) * segLen;
    const outMid = (outStart + outEnd) / 2;
    const vocalsAtTime = vocalsStartOffset + Math.max(0, outMid - vocalDelaySec);

    const localVocalsBpm = computeLocalBpm(beatTimesVocals, vocalsAtTime) ?? globalBpmVocals;
    const localInstruBpm = computeLocalBpm(beatTimesInstru, instruStartOffset + instruCursorRel) ?? globalBpmInstru;
    const ratio = safeTempoRatio(localVocalsBpm, localInstruBpm, rbAvailable);

    const outDur = outEnd - outStart;
    const srcDur = Math.max(0.05, outDur * ratio);
    segments.push({ srcStart: instruCursorRel, srcDur, ratio });
    instruCursorRel += srcDur;
  }

  const allSame = segments.every(s => Math.abs(s.ratio - segments[0].ratio) < 0.01);
  if (allSame) return null;

  console.log(`[mixFullRave] correction de tempo PAR SEGMENT activée (${n} tronçons, ratios : ${segments.map(s => s.ratio.toFixed(3)).join(", ")}) — grille de beats vocals=${hasVocalsGrid} instru=${hasInstruGrid}`);
  return segments;
};

// Fragment filter_complex qui étire indépendamment chaque segment (son propre
// ratio local) puis les recolle par acrossfade courts (50ms) — même principe
// que les transitions vidéo (xfade) déjà utilisées ailleurs dans ce fichier,
// appliqué ici au flux audio de l'instrumental. `baseLabel` doit déjà pointer
// vers le flux instru trimé+loudnormé+égalisé (AVANT tout étirement temporel) ;
// la sortie est toujours étiquetée [instru_norm], le même label attendu par la
// suite de la chaîne (sidechain multiband) qu'avec l'ancien filtre unique.
const SEGMENT_CROSSFADE_SEC = 0.05;
const buildPiecewiseInstruChain = (baseLabel, segments, rbAvailable) => {
  const stages = [];
  const segLabels = segments.map((seg, i) => {
    const trimmed = `instru_seg${i}_trim`;
    const stretched = `instru_seg${i}`;
    stages.push(`[${baseLabel}]atrim=start=${seg.srcStart.toFixed(3)}:duration=${seg.srcDur.toFixed(3)},asetpts=PTS-STARTPTS[${trimmed}]`);
    const tempoExpr = rbAvailable
      ? `rubberband=pitch=1:tempo=${seg.ratio.toFixed(4)}`
      : `atempo=${seg.ratio.toFixed(4)}`;
    stages.push(`[${trimmed}]${tempoExpr}[${stretched}]`);
    return stretched;
  });

  let prevLabel = segLabels[0];
  for (let i = 1; i < segLabels.length; i++) {
    const outLabel = i === segLabels.length - 1 ? "instru_norm" : `instru_xf${i}`;
    stages.push(`[${prevLabel}][${segLabels[i]}]acrossfade=d=${SEGMENT_CROSSFADE_SEC}:c1=tri:c2=tri[${outLabel}]`);
    prevLabel = outLabel;
  }
  // Pas de "\n" réel dans le fragment renvoyé : la commande ffmpeg finale
  // (mixFullRave) doit rester une seule ligne (convention déjà en place dans
  // ce fichier — les "\" en fin de ligne du template literal du cmd sont des
  // continuations JS qui ne produisent AUCUN caractère, contrairement à un
  // "\n" explicite qui insérerait un vrai saut de ligne dans la chaîne
  // passée au shell, risqué sous cmd.exe (Windows) qui traite la commande
  // ligne par ligne).
  return stages.join(";");
};

// ── Nettoyage voix : clics/craquements/artefacts ──
// Retour utilisateur : "les petits craquements ou artefacts" sur la voix —
// distinct du problème de réverb (traité en amont par cleanVocalsReverb/
// dereverb.js, routes/mashup.js). adeclick répare les clics impulsifs courts
// (défauts de compression/transcodage/downsampling, artefacts occasionnels de
// séparation Demucs) ; adeclip répare les échantillons saturés/écrêtés.
// Appliqué tôt dans la chaîne (juste après le trim, avant pitch-shift/EQ) pour
// nettoyer le signal source avant tout traitement ultérieur qui pourrait
// amplifier ou masquer ces défauts. Paramètres par défaut ffmpeg — corrects
// pour de la voix, pas besoin de réglage fin ici.
const VOCAL_CLEANUP_FILTER = "adeclick,adeclip,";

// ── Bus master : shelf "air" (polish façon mastering) ──
// Audit qualité juillet 2026 ("se calquer sur rave.dj") : après le glue
// compressor, le mix manquait du léger surcroît de brillance/sheen typique
// d'un master professionnel (contribue au ressenti "produit/pro" par rapport
// à un simple remix de stems). Shelf doux (+1.5 dB, pente large) à partir de
// 11 kHz, largement au-dessus des bandes déjà retravaillées par le de-ess
// vocal (7 kHz) — pas de conflit avec ce traitement. Volontairement discret
// (+1.5 dB, pas +4/5 dB) : l'objectif est un supplément de clarté, pas un
// changement de timbre audible. Appliqué sur le bus complet (voix + instru
// déjà sommées), juste avant le limiteur final, pour que celui-ci absorbe
// l'éventuel dépassement de crête introduit par ce boost.
const MASTER_AIR_SHELF = "treble=g=1.5:f=11000:width_type=o:width=0.7";

// ── Mastering adaptatif : ratio du glue compressor (Phase 7, juillet 2026) ──
// Le glue compressor du bus master (acompressor sur [mixed], juste avant
// MASTER_AIR_SHELF/le limiteur final) utilisait jusqu'ici un ratio FIXE
// (2:1) pour tous les morceaux — réglage affiné sur plusieurs rounds contre
// une référence rave.dj (cf. commentaires v1→v3 dans mixFullRave). Cette
// mesure permet d'adapter LÉGÈREMENT ce ratio au CONTENU réel de chaque
// piste plutôt qu'un seul réglage universel :
//   - crest factor ÉLEVÉ (mix "lâche", grands écarts crête/RMS — morceau
//     acoustique/peu produit/peu compressé en amont) → un peu PLUS de glue
//     pour resserrer.
//   - crest factor BAS (mix déjà dense/écrasé — très fréquent en électro/pop
//     modernes déjà masterisés en amont) → un peu MOINS de glue pour éviter
//     le pompage/la sur-compression d'un signal déjà compressé.
//   - Plage "normale" (la majorité des morceaux) → ratio INCHANGÉ (2:1, le
//     réglage d'origine reste le comportement par défaut/central — cette
//     fonction ne fait qu'affiner aux extrêmes, jamais un réglage universel
//     de remplacement).
// Mesure faite sur l'INSTRU (dominant le "grain" du mix final dans un
// mashup) via le filtre `astats` d'ffmpeg, greffé sur la MÊME passe que le
// loudnorm 2-passes déjà en place (cf. measureLoudness ci-dessus) — aucun
// coût ffmpeg supplémentaire pour mixFullRave/mixFullRaveDuo. Jamais
// bloquant : mesure absente/non-finie → ratio par défaut (comportement
// identique à avant cette fonctionnalité).
const GLUE_RATIO_DEFAULT = 2;
const GLUE_RATIO_LOOSE = 2.5;   // crest factor haut → un peu plus de glue
const GLUE_RATIO_DENSE = 1.6;   // crest factor bas → un peu moins de glue
const GLUE_CREST_LOOSE_THRESHOLD_DB = 18;
const GLUE_CREST_DENSE_THRESHOLD_DB = 10;
const adaptiveGlueRatio = (crestFactorDb, label = "") => {
  if (crestFactorDb == null) return GLUE_RATIO_DEFAULT;
  let ratio = GLUE_RATIO_DEFAULT, why = "plage normale";
  if (crestFactorDb >= GLUE_CREST_LOOSE_THRESHOLD_DB) { ratio = GLUE_RATIO_LOOSE; why = "crest factor élevé, mix lâche"; }
  else if (crestFactorDb <= GLUE_CREST_DENSE_THRESHOLD_DB) { ratio = GLUE_RATIO_DENSE; why = "crest factor bas, mix déjà dense"; }
  if (ratio !== GLUE_RATIO_DEFAULT) {
    console.log(`[mastering adaptatif]${label ? ` ${label} :` : ""} crest factor instru ${crestFactorDb.toFixed(1)} dB (${why}) → glue ratio ${ratio} (défaut ${GLUE_RATIO_DEFAULT})`);
  }
  return ratio;
};

// Mesure de crest factor AUTONOME (sans loudnorm 2-passes) — pour les
// chaînes qui n'en font pas (mixFullOverlay, loudnorm 1-passe seulement, cf.
// commentaire sur normalizeStemLoudness plus bas expliquant pourquoi la
// précision 2-passes n'y est pas jugée nécessaire). Même motif "jamais
// bloquant" que measureLoudness : tout échec retombe sur crestFactorDb=null
// → adaptiveGlueRatio applique alors le ratio par défaut.
const measureCrestFactorDb = async (inputPath, preFilter = "") => {
  const nullOut = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    const { stderr } = await execAsync(
      `ffmpeg -i "${inputPath}" -filter:a "${preFilter}astats=metadata=0:reset=0" -f null ${nullOut}`,
      { timeout: 60000, maxBuffer: 1024 * 1024 * 10 }
    );
    const matches = [...stderr.matchAll(/Crest factor:\s*([\d.]+)/g)];
    if (matches.length === 0) return null;
    const crestLinear = Number(matches[matches.length - 1][1]);
    if (!Number.isFinite(crestLinear) || crestLinear <= 0) return null;
    return 20 * Math.log10(crestLinear);
  } catch (e) {
    console.warn(`[mastering adaptatif] mesure crest factor échouée pour ${inputPath} — ratio de glue par défaut conservé :`, e.message?.split("\n")[0]);
    return null;
  }
};

// ── Harmonisation voix/instru (clé musicale) ──
// Retour utilisateur : sur les combos "voix d'un morceau + instru de l'autre",
// les 2 pistes n'étant pas forcément dans la même clé/tonalité, la voix peut
// sonner fausse par-dessus l'instru (dissonance), même quand le tempo est
// correctement calé. On transpose la voix (et seulement la voix — un stem
// vocal isolé tolère beaucoup mieux ce type de transposition simple qu'un
// instrumental complet avec basse/percussions) du nombre de demi-tons le
// plus court pour ramener sa tonalité sur celle de l'instru.
const PITCH_CHROMA = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Au cas où une clé serait fournie en notation bémol plutôt que dièse.
const FLAT_TO_SHARP = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };
const pitchIndex = (p) => {
  if (!p) return null;
  const norm = FLAT_TO_SHARP[p] || p;
  const idx = PITCH_CHROMA.indexOf(norm);
  return idx === -1 ? null : idx;
};

// Décalage en demi-tons (le plus court, entre -6 et +5) pour amener la
// tonalité `from` sur celle de `to`. Renvoie 0 si l'une des deux clés est
// inconnue (morceau pas encore analysé) — pas de transposition par défaut.
const semitoneShift = (from, to) => {
  const i = pitchIndex(from), j = pitchIndex(to);
  if (i === null || j === null) return 0;
  let diff = (j - i) % 12;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
};

// ── Correction harmonique "façon roue de Camelot" ───────────────────────
// La transposition ci-dessus (semitoneShift) force la voix sur EXACTEMENT
// la même note que l'instru, sans tenir compte du mode (majeur/mineur).
// Problème concret : si la voix est déjà en La mineur et l'instru en Do
// majeur, ces 2 tonalités sont déjà parfaitement compatibles (mêmes notes,
// "relatives" l'une de l'autre) — les forcer à l'unisson décale la voix pour
// rien, et peut même la rendre dissonante avec elle-même (sa propre
// harmonisation/réverbe enregistrée dans le morceau d'origine). La roue de
// Camelot (notation standard du DJing, déjà calculée dans analyzer.js et
// stockée en base : ex. "8B" = Do majeur, "8A" = La mineur) considère 2
// tonalités harmoniquement compatibles si elles sont : identiques, "voisines"
// (même lettre, numéro ±1 — un intervalle de quarte/quinte) ou "relatives"
// (même numéro, lettre opposée — même gamme, mode différent). On choisit ici
// la transposition la plus PETITE qui amène la voix sur l'UNE de ces 3
// situations par rapport à l'instru, plutôt que de forcer l'unisson strict.
const PITCHES_CAMELOT = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Mêmes tables que services/analyzer.js (Python) — à garder synchronisées.
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
// Lookup inverse : code Camelot → { pitch, mode }.
const CAMELOT_TO_PITCH = {};
CAMELOT_MAJOR.forEach((code, idx) => { CAMELOT_TO_PITCH[code] = { pitch: PITCHES_CAMELOT[idx], mode: "major" }; });
CAMELOT_MINOR.forEach((code, idx) => { CAMELOT_TO_PITCH[code] = { pitch: PITCHES_CAMELOT[idx], mode: "minor" }; });

const parseCamelot = (code) => {
  const m = /^(\d{1,2})([AB])$/.exec((code || "").trim().toUpperCase());
  if (!m) return null;
  const number = parseInt(m[1], 10);
  if (number < 1 || number > 12) return null;
  return { number, letter: m[2] };
};

// Décalage en demi-tons le plus PETIT qui amène la voix sur une tonalité
// compatible (au sens Camelot ci-dessus) avec celle de l'instru — au lieu de
// systématiquement forcer l'unisson. Repli sur l'ancien comportement
// (unisson strict via semitoneShift) si l'un des 2 codes Camelot est absent
// ou invalide (morceau pas encore analysé avec la notation Camelot).
//
// maxShift : budget maximal (demi-tons) qu'on s'autorise à appliquer — cf.
// bug corrigé ici : cette fonction pouvait renvoyer un décalage "idéal"
// (jusqu'à ±6 demi-tons) qui était ENSUITE tronqué à MAX_AUTO_VOCAL_SHIFT
// (±2) par un simple clamp dans mixFullRave/mixFullRaveDuo. Un clamp après
// coup ne fait PAS atterrir la voix sur une note valide : ±4 tronqué à ±2 ne
// tombe ni sur la note d'origine, ni sur la tonalité cible — juste sur une
// note intermédiaire fausse, d'où le "la voix sonne encore un peu fausse"
// remonté même après une correction automatique. Le budget est donc
// maintenant appliqué ICI, en amont du choix : seules les cibles
// atteignables DANS ce budget sont candidates ; si aucune ne l'est, on
// renvoie 0 (on laisse la voix dans sa tonalité d'origine, non retouchée,
// plutôt que de la décaler vers une note qui n'a de sens ni pour l'une ni
// pour l'autre tonalité).
const camelotAwareShift = (camelotVocals, camelotInstru, fallbackKeyVocals, fallbackKeyInstru, maxShift = Infinity) => {
  const vocals = parseCamelot(camelotVocals);
  const instru = parseCamelot(camelotInstru);
  if (!vocals || !instru) {
    const fallback = semitoneShift(fallbackKeyVocals, fallbackKeyInstru);
    return Math.abs(fallback) <= maxShift ? fallback : 0;
  }

  const wrap = (n) => ((n - 1) % 12 + 12) % 12 + 1;
  // Codes Camelot "cibles" atteignables par simple transposition de la voix
  // (la transposition change la note mais jamais le mode) ET compatibles
  // avec l'instru : l'unisson + les 2 voisins si même lettre que l'instru,
  // sinon uniquement la relative (même numéro, lettre de la voix).
  const targetCodes = vocals.letter === instru.letter
    ? [instru.number, wrap(instru.number + 1), wrap(instru.number - 1)].map(n => `${n}${vocals.letter}`)
    : [`${instru.number}${vocals.letter}`];

  const vocalsPitch = CAMELOT_TO_PITCH[`${vocals.number}${vocals.letter}`]?.pitch;
  let best = 0, bestAbs = Infinity;
  for (const code of targetCodes) {
    const target = CAMELOT_TO_PITCH[code];
    if (!target) continue;
    const shift = semitoneShift(vocalsPitch, target.pitch);
    // Seules les cibles atteignables dans le budget sont candidates — cf.
    // commentaire au-dessus de la fonction.
    if (Math.abs(shift) > maxShift) continue;
    if (Math.abs(shift) < bestAbs) { bestAbs = Math.abs(shift); best = shift; }
  }
  return best;
};

// ── Mashup "à la carte" — provenance indépendante par stem ───────────────
// Demande explicite (grade au-dessus de voix/instru en bloc) : au lieu de
// toujours combiner "voix d'UN morceau + instru complet de L'AUTRE", choisir
// librement, pour CHACUN des 4 stems Demucs (voix/batterie/basse/autres), de
// quel morceau (Deck A ou B) il provient — ex: voix + basse de A, batterie +
// autres de B.
//
// Les 3 stems non-vocaux (batterie/basse/autres) forment ensemble
// l'"instrumental composite" : s'ils viennent tous du MÊME morceau, ils sont
// déjà cohérents entre eux (même tempo/tonalité d'origine) et se combinent
// tels quels (combineTracks, aucun étirement). S'ils sont RÉPARTIS entre les
// 2 morceaux, le(s) stem(s) minoritaire(s) doivent être realignés (tempo +
// tonalité) sur le morceau majoritaire ("l'ancre") avant combinaison — sinon
// batterie et basse de 2 morceaux à BPM différents ne tomberaient jamais en
// phase. Le résultat (déjà à un seul tempo/tonalité cohérent) est ensuite
// traité EXACTEMENT comme l'instru B d'un mashup classique : passé tel quel à
// mixFullRave avec la voix choisie, qui gère (inchangé) le calage fin voix/
// instru, le ducking, le loudnorm 2-passes, etc.
//
// allowPitchShift=false pour la batterie : un stem de percussions est
// essentiellement bruité/atonal, un pitch-shift n'y a ni sens ni bénéfice
// audible (contrairement à la basse/autres, qui portent du contenu tonal) —
// seul le tempo de la batterie est réaligné, jamais sa "tonalité".
export const alignAndCombineStems = async (parts, targetBpm, targetCamelot, targetKeyPitch, output) => {
  const rbAvailable = await hasRubberband();
  const workDir = dirname(output);
  const alignedPaths = [];

  for (const part of parts) {
    const needsTempo = !!(part.bpm && targetBpm && Math.abs(part.bpm - targetBpm) > 0.5);
    const ratio = needsTempo ? safeTempoRatio(targetBpm, part.bpm, rbAvailable) : 1.0;
    const semitones = part.allowPitchShift === false
      ? 0
      : camelotAwareShift(part.camelot, targetCamelot, part.keyPitch, targetKeyPitch, 6);

    if (Math.abs(ratio - 1.0) < 0.005 && semitones === 0) {
      // Déjà l'ancre (ou BPM/tonalité quasi identiques) — aucun traitement.
      alignedPaths.push(part.path);
      continue;
    }

    const pitchRatio = Math.pow(2, semitones / 12);
    const outPath = join(workDir, `aligned_${part.label}.flac`);
    let filterExpr;
    if (semitones !== 0 && rbAvailable) {
      filterExpr = `rubberband=pitch=${pitchRatio.toFixed(6)}:tempo=${ratio.toFixed(4)}:formant=preserved`;
    } else if (semitones !== 0) {
      filterExpr = `asetrate=44100*${pitchRatio.toFixed(6)},aresample=44100,atempo=${(ratio / pitchRatio).toFixed(6)}`;
    } else if (Math.abs(ratio - 1.0) >= 0.005 && rbAvailable) {
      filterExpr = `rubberband=pitch=1:tempo=${ratio.toFixed(4)}`;
    } else {
      filterExpr = `atempo=${ratio.toFixed(4)}`;
    }
    const cmd = `ffmpeg -i "${part.path}" -filter:a "${filterExpr}" -ar 44100 "${outPath}" -y`;
    await execAsync(cmd, { timeout: 120000 });
    alignedPaths.push(outPath);
    console.log(`[alignAndCombineStems] ${part.label} : BPM ${part.bpm ?? "?"}→${targetBpm ?? "?"} (ratio ${ratio.toFixed(3)})${semitones ? `, ${semitones > 0 ? "+" : ""}${semitones} demi-ton(s)` : ""}`);
  }

  await combineTracks(alignedPaths, output);
  return output;
};

// ── Loudnorm 2-passes (mesure précise, option 1 de l'audit qualité) ──────
// loudnorm en 1 passe (comportement précédent) est un algorithme streaming :
// il estime la loudness au fil de l'eau et ajuste dynamiquement — correct à
// quelques dixièmes de LU près, mais pas exact. Le mode 2 passes :
//   1) MESURE la loudness réelle du signal après le MÊME pré-traitement que
//      la passe finale (trim, pitch-shift, HPF/LPF) — indispensable, sinon
//      la mesure ne correspondrait pas au signal qui traverse réellement
//      loudnorm dans la chaîne finale — sortie jetée (-f null).
//   2) Applique un gain LINÉAIRE exact (linear=true) calculé à partir de
//      cette mesure, au lieu de la correction dynamique/non-linéaire du mode
//      1 passe.
// Résultat : la cible LUFS (-13.5 par défaut) est atteinte à ~0.1 LU près
// au lieu d'une simple approximation. Jamais bloquant : un échec de mesure
// (ffmpeg absent d'une fonctionnalité, timeout...) retombe simplement sur le
// loudnorm 1 passe précédent.
const measureLoudness = async (inputPath, preFilter, targetI, targetTP, targetLRA) => {
  // astats=metadata=0:reset=0 enchaîné APRÈS loudnorm (juste pour la mesure,
  // -f null : jamais dans le signal réellement exporté) : récupère le crest
  // factor du même flux dans la MÊME passe ffmpeg, sans coût significatif
  // supplémentaire — réutilisé par le mastering adaptatif (glue compressor,
  // cf. adaptiveGlueRatio plus bas) pour éviter une 2e analyse dédiée.
  const filter = `${preFilter}loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}:print_format=json,astats=metadata=0:reset=0`;
  const nullOut = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    // Timeout relevé 60s → 150s : sous contention CPU (plusieurs combos en
    // parallèle, cf. services/cpuQueue.js), cette mesure peut légitimement
    // prendre plus d'une minute — un timeout trop court ici ne fait pas
    // échouer tout le job (repli sur loudnorm 1-passe, cf. plus bas), mais
    // dégrade silencieusement la précision plus souvent que nécessaire.
    const { stderr } = await execAsync(
      `ffmpeg -i "${inputPath}" -filter:a "${filter}" -f null ${nullOut}`,
      { timeout: 150000, maxBuffer: 1024 * 1024 * 10 }
    );
    // Crest factor (astats, valeur LINÉAIRE — conversion dB via 20*log10) :
    // extrait indépendamment du parsing JSON loudnorm ci-dessous, un échec
    // ici (filtre absent, sortie inattendue) ne doit jamais faire échouer la
    // mesure loudnorm qui, elle, est critique pour le mix.
    let crestFactorDb = null;
    try {
      const crestMatches = [...stderr.matchAll(/Crest factor:\s*([\d.]+)/g)];
      if (crestMatches.length > 0) {
        const crestLinear = Number(crestMatches[crestMatches.length - 1][1]);
        if (Number.isFinite(crestLinear) && crestLinear > 0) crestFactorDb = 20 * Math.log10(crestLinear);
      }
    } catch { /* non-bloquant, cf. commentaire ci-dessus */ }
    // loudnorm imprime un objet JSON sur stderr, au milieu du reste des logs
    // ffmpeg — on prend le DERNIER bloc {...} trouvé (le plus fiable, les
    // logs ffmpeg eux-mêmes ne contiennent normalement pas d'accolades).
    const matches = stderr.match(/\{[^{}]*\}/g);
    if (!matches || matches.length === 0) return null;
    const measured = JSON.parse(matches[matches.length - 1]);
    if (measured.input_i == null) return null;
    // Correctif (retour utilisateur juillet 2026 : le mashup "Voix + instru"
    // échouait systématiquement à l'étape "Mixage voix + instrumental
    // composite" avec l'erreur ffmpeg "value for option 'measured_I' out of
    // range [-99 - 0]" / "Result too large") — root-causé : ffmpeg imprime
    // "-inf" (une CHAÎNE, pas un nombre) pour input_i/input_tp/input_lra
    // quand le signal mesuré est quasi-silencieux sur toute sa durée (cas
    // fréquent ici : un stem "vocals" ou "autres" quasi vide selon le
    // morceau). Cette chaîne "-inf" était jusqu'ici injectée telle quelle
    // dans measured_I=... du filter_complex final, que ffmpeg refuse (hors de
    // la plage valide [-99, 0] LUFS) — et fait donc échouer TOUT le job,
    // alors que le mécanisme de repli 1-passe (prévu pour tout autre échec de
    // mesure, cf. le catch ci-dessous) existe déjà et n'attendait qu'à être
    // déclenché ici aussi. On valide donc que les 3 mesures utilisées sont de
    // vrais nombres finis avant de les exploiter ; sinon on retombe sur le
    // loudnorm 1 passe (jamais bloquant), exactement comme un timeout ou une
    // absence de ffmpeg.
    const asFiniteNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const inputI = asFiniteNum(measured.input_i);
    const inputTP = asFiniteNum(measured.input_tp);
    const inputLRA = asFiniteNum(measured.input_lra);
    const inputThresh = asFiniteNum(measured.input_thresh);
    if (inputI == null || inputTP == null || inputLRA == null || inputThresh == null) {
      console.warn(`[loudnorm 2-passes] mesure non-finie (signal quasi silencieux ?) pour ${inputPath} — repli sur loudnorm 1 passe :`, JSON.stringify(measured));
      return null;
    }
    return {
      measured_I: inputI,
      measured_TP: inputTP,
      measured_LRA: inputLRA,
      measured_thresh: inputThresh,
      offset: measured.target_offset,
      crestFactorDb,
    };
  } catch (e) {
    console.warn(`[loudnorm 2-passes] mesure échouée pour ${inputPath} — repli sur loudnorm 1 passe :`, e.message?.split("\n")[0]);
    return null;
  }
};

// Construit l'expression loudnorm à insérer dans le filter_complex — 2
// passes (précis) si la mesure a réussi, repli 1 passe (comportement
// précédent, jamais bloquant) sinon.
const loudnormExpr = (targetI, targetTP, targetLRA, measured) =>
  measured
    ? `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}:measured_I=${measured.measured_I}:measured_TP=${measured.measured_TP}:measured_LRA=${measured.measured_LRA}:measured_thresh=${measured.measured_thresh}:offset=${measured.offset}:linear=true`
    : `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}`;

// ── Normalisation de niveau d'un stem isolé (export voix/instru FLAC) ──
// Demucs ne garantit AUCUN équilibre de niveau entre les stems séparés : le
// volume relatif voix/instru dans le mix ORIGINAL (avant séparation) se
// retrouve tel quel sur chaque stem exporté, ce qui donne parfois une voix
// nettement plus forte (ou plus faible) que l'instru une fois téléchargée
// séparément — signalé en pratique par un ressenti "volume voix trop haut
// vs instru". Cible commune (-16 LUFS intégré, standard pour un export
// autonome, un peu moins dense qu'un master streaming à -14) appliquée
// IDENTIQUEMENT aux deux stems : après normalisation, voix et instru sonnent
// au même niveau perçu l'un par rapport à l'autre, quel que soit leur niveau
// respectif dans le mix d'origine.
// Loudnorm à 1 SEULE passe désormais (measureLoudness en amont supprimée) :
// contrairement au mix final (mixFullRave/Duo, où la précision du loudnorm
// 2-passes compte vraiment sur un signal déjà retravaillé par plusieurs
// filtres en chaîne), ici on ne fait qu'aligner 2 stems bruts l'un sur
// l'autre — l'écart de précision du loudnorm 1-passe est inaudible pour ce
// cas d'usage, et ça évite de décoder le fichier 2 fois (priorité vitesse).
export const normalizeStemLoudness = async (input, output, targetI = "-16") => {
  const expr = loudnormExpr(targetI, "-1.5", "11", null);
  const cmd = `ffmpeg -i "${input}" -filter:a "${expr}" -ar 44100 "${output}" -y`;
  await execAsync(cmd, { timeout: 120000 });
  return output;
};

// balanceOffsetDb : décale l'équilibre voix/instru SANS changer le volume
// global (la baisse côté voix compense la hausse côté instru) — utilisé par
// le cadre "combos" (routes/mashup.js /combine-stems) pour une voix moins
// dominante que dans le mashup principal, suite au retour "la voix est trop
// forte par rapport à l'instru" sur ces 2 pistes générées.
// duckingRatio : force du sidechain qui baisse l'instru pendant la voix —
// plus bas = l'instru reste plus présent même quand la voix chante.
// vocalsTrimDb : baisse SÈCHE du volume de la voix (en plus de
// balanceOffsetDb ci-dessus), sans compensation côté instru — utilisé pour un
// réglage fin direct ("baisser le volume des vocals de X dB"), par opposition
// à un simple rééquilibrage relatif.
export const mixFullRave = async (vocalsA, instrumentalB, bpmA, bpmB, crossfade, output, opts = {}) => {
  const { balanceOffsetDb = 0, duckingRatio = 2.5, vocalsTrimDb = 0, keyVocals = null, keyInstru = null,
          camelotVocals = null, camelotInstru = null,
          // Rec #4 — Sélection de segment : offset de départ (secondes) dans
          // chaque stem, calculé depuis le premier segment "high" de structure_json.
          // atrim=start=X,asetpts=PTS-STARTPTS remet le compteur à t=0 après découpe.
          vocalsStartOffset = 0, instruStartOffset = 0,
          // Rec #5 — Délai vocal calé sur une mesure entière de l'instru (ms).
          // Calculé dans routes/mashup.js depuis le BPM de l'instru : toujours
          // un multiple entier de mesure 4/4, cible ≈ 4s.
          vocalDelayMs = 4000,
          // ── Réglages manuels ("pitch fader", Mixer.jsx → routes/mashup.js) ──
          // null = comportement automatique inchangé (safeTempoRatio /
          // camelotAwareShift-semitoneShift). Non-null = l'utilisateur a
          // volontairement réglé un curseur dans l'UI et veut CE ratio/décalage
          // précis, même hors de la fenêtre "sûre" calculée automatiquement —
          // un vrai fader de pitch DJ ne bloque jamais l'utilisateur, il le
          // prévient juste (cf. scoring.js) mais le laisse forcer sa valeur.
          manualTempoRatio = null, manualSemitoneShift = null,
          // Grille de beats complète des 2 pistes (analyzer.js, beat_times) —
          // utilisée par buildTempoSchedule ci-dessous pour corriger le tempo
          // PAR SEGMENT plutôt qu'un seul ratio global (anti-décrochage).
          // Optionnel : un tableau vide/absent fait retomber le comportement
          // sur l'ancien ratio unique, sans régression.
          beatTimesVocals = [], beatTimesInstru = [],
          // ── Durée de sortie plafonnée ("mode tailored", demande explicite) ──
          // null = comportement historique inchangé (le mashup dure aussi
          // longtemps que la voix A, du segment choisi jusqu'à sa fin — peut
          // faire 3-4+ min). Un nombre (secondes) tronque la voix à cette
          // durée totale de sortie (intro instru + voix), à la façon de
          // RaveDJ qui produit systématiquement un montage COURT et ciblé
          // (constaté : 1:49 et 3:08 sur 2 tests réels, jamais la longueur
          // complète d'un morceau source) plutôt qu'un mashup de la durée
          // d'une chanson entière. Câblé par routes/mashup.js selon le mode
          // de durée choisi côté UI — cf. commentaire dans routes/mashup.js.
          maxDurationSec = null } = opts;
  // Vérifié UNE fois ici (résultat mis en cache par hasRubberband), utilisé
  // à la fois pour le pitch-shift de la voix ET pour l'étirement temporel de
  // l'instru ci-dessous — c'est ce qui permet à safeTempoRatio d'élargir sa
  // fenêtre de qualité (cf. commentaire sur safeTempoRatio).
  const rbAvailable = await hasRubberband();
  const ratio = manualTempoRatio != null
    ? Number(manualTempoRatio).toFixed(4)
    : safeTempoRatio(bpmA, bpmB, rbAvailable).toFixed(4);
  console.log(`[mixFullRave] BPM A=${bpmA} B=${bpmB} → ratio tempo appliqué=${ratio}${manualTempoRatio != null ? " (manuel)" : rbAvailable ? " (rubberband)" : " (atempo)"}`);

  // ── Plan de correction de tempo PAR SEGMENT (anti-décrochage) ──
  // Désactivé si un ratio MANUEL est fourni (curseur pitch fader) : un choix
  // volontaire de l'utilisateur doit s'appliquer tel quel, uniformément, pas
  // être recalculé localement segment par segment à sa place.
  // ── Durée de sortie EFFECTIVE (calculée UNE fois, partagée voix+instru) ──
  // Bug remonté par l'utilisateur (juillet 2026) : en mode "tailored", la
  // voix était bien tronquée à maxDurationSec (vocalsDurationCapSec plus
  // bas) mais l'INSTRU, lui, ne l'était PAS — seul son offset de départ
  // était appliqué, jamais sa durée. Résultat : "amix=duration=longest"
  // (plus bas) laissait le flux instru NON PLAFONNÉ (potentiellement toute
  // la longueur brute du morceau B) dicter la durée réelle de sortie dès
  // que buildTempoSchedule renvoie null (BPM globalement stable sur les 2
  // pistes → tous les ratios locaux quasi identiques → `allSame` renvoie
  // null, cf. commentaire sur buildTempoSchedule) — cas très fréquent. Le
  // rendu audio final continuait alors bien au-delà de ce que la vidéo (elle,
  // dimensionnée sur la durée voix) laissait paraître : constaté sur un cas
  // réel, 163.8s d'audio pour une vidéo de 62.6s. `effectiveOutputDurationSec`
  // est maintenant calculé UNE fois ici et réutilisé à la fois pour le plan
  // de tempo par segment ET pour les 2 plafonds (voix ET instru) plus bas,
  // afin que les 2 flux s'arrêtent bien au MÊME instant. Toujours plafonné
  // par la durée RÉELLEMENT disponible dans la voix (naturalOutputDurationSec)
  // : jamais d'extension artificielle au-delà de ce qui existe physiquement
  // (un plafond "tailored" plus grand que la voix dispo ne peut pas manufacturer
  // de l'audio manquant — il ne fait alors simplement rien, cf. Math.min).
  const vocalsDurationForCap = await getDuration(vocalsA).catch(() => null);
  const vocalDelaySec = vocalDelayMs / 1000;
  const naturalOutputDurationSec = vocalsDurationForCap != null
    ? vocalDelaySec + Math.max(0, vocalsDurationForCap - vocalsStartOffset)
    : null;
  const effectiveOutputDurationSec = maxDurationSec != null && naturalOutputDurationSec != null
    ? Math.min(naturalOutputDurationSec, Math.max(maxDurationSec, vocalDelaySec + 5))
    : (maxDurationSec != null ? maxDurationSec : naturalOutputDurationSec);
  if (maxDurationSec != null && naturalOutputDurationSec != null && effectiveOutputDurationSec < naturalOutputDurationSec) {
    console.log(`[mixFullRave] durée plafonnée (mode tailored) : ${naturalOutputDurationSec.toFixed(1)}s → ${effectiveOutputDurationSec.toFixed(1)}s`);
  }

  let tempoSchedule = null;
  if (manualTempoRatio == null && effectiveOutputDurationSec != null) {
    try {
      tempoSchedule = buildTempoSchedule({
        outputDurationSec: effectiveOutputDurationSec, vocalDelaySec, vocalsStartOffset, instruStartOffset,
        beatTimesVocals, beatTimesInstru,
        globalBpmVocals: bpmA, globalBpmInstru: bpmB, rbAvailable,
      });
    } catch (e) {
      console.warn(`[mixFullRave] calcul du plan de tempo par segment ignoré (repli sur ratio global) : ${e.message}`);
    }
  }

  // Transposition de la voix sur une tonalité compatible avec l'instru (cf.
  // camelotAwareShift ci-dessus — unisson, relative ou voisine sur la roue de
  // Camelot, selon ce qui demande le PLUS PETIT décalage, plutôt qu'un
  // unisson strict qui ignore le mode majeur/mineur). Repli sur l'ancien
  // calcul "note exacte" (semitoneShift) si les codes Camelot ne sont pas
  // fournis.
  // Pitch-shift : rubberband (phase-vocoder HQ, sans artéfacts de vitesse)
  // si compilé dans FFmpeg, sinon asetrate+atempo (correct pour ≤ 6 st).
  //
  // Budget de décalage AUTOMATIQUE (même limite que le score de
  // compatibilité, MAX_VOCAL_SHIFT_SEMITONES dans scoring.js) — passé
  // DIRECTEMENT à camelotAwareShift/semitoneShift plutôt que d'être appliqué
  // APRÈS coup sur leur résultat (bug corrigé : un clamp a posteriori sur un
  // décalage de, disons, +4 demi-tons donnait +2 — qui n'est ni la tonalité
  // d'origine ni la tonalité cible, juste une note fausse entre les deux,
  // d'où le "la voix sonne encore un peu fausse" malgré la correction). Ces
  // fonctions ne considèrent maintenant QUE les cibles atteignables dans ce
  // budget, et renvoient 0 (voix non retouchée) si aucune ne l'est — jamais
  // une note intermédiaire invalide. Un override manuel explicite (curseur
  // "pitch fader", Mixer.jsx) n'est PAS concerné : un choix volontaire de
  // l'utilisateur, non plafonné.
  const MAX_AUTO_VOCAL_SHIFT = 2;
  const autoShift = camelotVocals && camelotInstru
    ? camelotAwareShift(camelotVocals, camelotInstru, keyVocals, keyInstru, MAX_AUTO_VOCAL_SHIFT)
    : (Math.abs(semitoneShift(keyVocals, keyInstru)) <= MAX_AUTO_VOCAL_SHIFT ? semitoneShift(keyVocals, keyInstru) : 0);
  const shift = manualSemitoneShift != null ? Number(manualSemitoneShift) : autoShift;
  if (manualSemitoneShift != null) {
    console.log(`[mixFullRave] décalage vocal FORCÉ manuellement : ${shift > 0 ? "+" : ""}${shift} demi-ton(s)`);
  } else if (autoShift === 0 && keyVocals && keyInstru) {
    // Distingue "déjà compatible" (idéal aussi = 0) de "rien d'atteignable
    // dans le budget" (idéal ≠ 0 mais hors budget) — pour ne logguer
    // l'avertissement que dans le 2e cas, sans bruit inutile dans le 1er.
    const idealShift = camelotVocals && camelotInstru
      ? camelotAwareShift(camelotVocals, camelotInstru, keyVocals, keyInstru)
      : semitoneShift(keyVocals, keyInstru);
    if (idealShift !== 0) {
      console.warn(`[mixFullRave] tonalité idéale (${idealShift > 0 ? "+" : ""}${idealShift} demi-tons) hors budget ±${MAX_AUTO_VOCAL_SHIFT} — voix laissée dans sa tonalité d'origine plutôt que transposée vers une note fausse.`);
    }
  }
  const pitchRatio = Math.pow(2, shift / 12);
  // formant=preserved : sans ça, rubberband translate aussi les formants avec
  // la hauteur (comportement par défaut) — au-delà d'1-2 demi-tons, la voix
  // sonne artificiellement aiguë/grave ("chipmunk"). Avec les formants
  // préservés, le timbre de la voix reste naturel même sur des transpositions
  // plus importantes — c'est ce qui permet d'élargir le verrou anti-décrochage
  // vocal (cf. MAX_VOCAL_SHIFT_SEMITONES dans scoring.js) sans sacrifier la
  // qualité perçue.
  const pitchFilter = shift !== 0
    ? rbAvailable
      ? `rubberband=pitch=${pitchRatio.toFixed(6)}:tempo=1:formant=preserved,`
      : `asetrate=44100*${pitchRatio.toFixed(6)},aresample=44100,atempo=${(1 / pitchRatio).toFixed(6)},`
    : "";
  const camelotLog = camelotVocals && camelotInstru ? ` (camelot voix=${camelotVocals} instru=${camelotInstru})` : "";
  if (shift !== 0) {
    console.log(`[mixFullRave] clé voix=${keyVocals} clé instru=${keyInstru}${camelotLog} → voix transposée de ${shift > 0 ? "+" : ""}${shift} demi-ton(s) pour rejoindre une tonalité compatible`);
  } else if (keyVocals && keyInstru) {
    console.log(`[mixFullRave] clé voix=${keyVocals} clé instru=${keyInstru}${camelotLog} → déjà harmoniquement compatible, pas de transposition`);
  }

  const cf = Math.min(Math.max(crossfade, 0), 1);
  // Cible loudnorm relevée de −15.5 → −13.5 LUFS (v3 analyse rave.dj) :
  // rave.dj probable −12/−13 LUFS (MP4 non normalisé par une plateforme).
  // À loudness égale le mix était perçu comme "moins bon" uniquement parce
  // qu'il était plus silencieux — biais perceptif documenté. Le curseur
  // crossfade conserve son rôle (±1 dB autour du pivot) ; le limiter en
  // fin de chaîne rattrape tout pic > 0 dBFS.
  // [12] Pivot voix abaissé d'1 dB (−13.5 → −14.5) : retour utilisateur "le
  //     niveau du vocal est légèrement trop fort par rapport à l'instru" —
  //     la voix restait ~1 dB au-dessus de l'instru à cf=0.5 par construction
  //     (mêmes bases −13.5/−13.5 mais signe opposé sur le terme crossfade).
  //     Ce point fixe déplace tout l'intervalle vers un vocal légèrement en
  //     retrait, sans toucher au curseur crossfade ni à balanceOffsetDb/
  //     vocalsTrimDb (réglages fins existants, toujours cumulables).
  const vocalsLUFS = (-14.5 + (1 - cf) * 1 - balanceOffsetDb / 2 - vocalsTrimDb).toFixed(1);  // -14.5 (cf=1) → -13.5 (cf=0)
  const instruLUFS = (-13.5 - (1 - cf) * 1 + balanceOffsetDb / 2).toFixed(1);  // -13.5 (cf=1) → -14.5 (cf=0)

  // Corrections qualité v1→v3 (analyses rave.dj juin 2026) :
  // [1] HPF voix 200 Hz : retire le bleed basse du stem vocal Demucs (160-300 Hz).
  // [2] De-ess voix −3 dB large @ 7 kHz : réduit sibilances amplifiées par le
  //     pitch shift (perceptibles surtout sur voix féminines ou après +2 st).
  // [3] aecho 60ms sur voix ("acoustic glue") : ancre la voix dans le même
  //     espace de réverb que l'instru — cohérence spatiale entre les deux stems.
  // [4] EQ creux instru −1.25 dB @ 1800 Hz : sculpte l'espace de présence vocale
  //     (réduit de −2.5 → −1.25 dB, retour utilisateur : instru "étouffé").
  // [4b] Mud cut instru −1.5 dB @ 300 Hz : retire la boue low-mid (200-400 Hz)
  //     (réduit de −3 → −1.5 dB, même raison qu'en [4]).
  // [5] adelay (vocalDelayMs = N mesures entières BPM instru) : intro instru seul.
  // [6] atrim (vocalsStartOffset / instruStartOffset) : saute l'intro basse énergie.
  // [7] Sidechain multiband : duck uniquement la bande 200-3000 Hz de l'instru
  //     (zone de masquage vocal). Les basses (<200 Hz) et les aigus (>3000 Hz)
  //     ne pompent plus — l'instru reste naturel quand la voix chante.
  // [7b] Limiteur de sécurité juste après la reconstruction 3 bandes
  //     (instru_ducked_raw → instru_ducked) : la reconstruction lo+mid_duck+hi
  //     (amix normalize=0) peut ponctuellement dépasser 0 dBFS en interne selon
  //     le contenu (percussions notamment) AVANT même d'être mélangée à la
  //     voix — sans ce garde-fou, seul le limiteur final (en bout de chaîne,
  //     donc après cumul avec la voix) rattrapait le coup, ce qui pouvait
  //     laisser passer un dépassement bref = saturation audible sur l'instru
  //     seul (retour utilisateur : "instru saturé/distordu").
  // [8] Glue compressor 2:1 / attack 80ms / release 500ms sur master bus :
  //     "colle" les deux stems dans le même espace dynamique. Standard mastering.
  // [9] Cible loudnorm −13.5 LUFS (vs −15.5 avant) : aligne sur rave.dj
  //     probable −12/−13 LUFS, élimine le biais de loudness à l'écoute.
  // [10] rubberband pitch-shift HQ si compilé, sinon asetrate+atempo.
  // [11] Attaque du limiteur final resserrée 5ms → 2ms : rattrape mieux les
  //     transitoires rapides (percussions) qui pouvaient passer légèrement
  //     au-dessus du seuil avant que le limiteur n'ait le temps de réagir.
  // Plafond de durée (mode "tailored") appliqué ICI, indépendamment de la
  // réussite du plan de tempo par segment ci-dessus (celui-ci peut échouer/
  // être désactivé — ex. ratio manuel — sans que ça doive annuler le
  // plafonnage voulu) : c'est cet atrim qui coupe RÉELLEMENT le flux voix,
  // le reste de la chaîne (ducking, loudnorm...) s'applique ensuite sur un
  // flux déjà de la bonne longueur.
  const vocalsDurationCapSec = maxDurationSec != null && effectiveOutputDurationSec != null
    ? Math.max(5, effectiveOutputDurationSec - vocalDelaySec)
    : null;
  const vocalsTrimFilter  = (vocalsStartOffset > 0 || vocalsDurationCapSec != null)
    ? `atrim=start=${vocalsStartOffset.toFixed(3)}${vocalsDurationCapSec != null ? `:duration=${vocalsDurationCapSec.toFixed(3)}` : ""},asetpts=PTS-STARTPTS,`
    : "";
  // Plafond de durée INSTRU (fix bug "durée ciblée" remonté par l'utilisateur,
  // cf. commentaire détaillé sur effectiveOutputDurationSec plus haut) : sans
  // ce cap, l'instru continuait sur toute sa longueur brute (mode "tailored"
  // ou non) et "amix=duration=longest" (plus bas) laissait CE flux, bien plus
  // long que la voix, dicter la durée réelle de sortie — d'où un audio final
  // qui débordait largement la durée visée (ex. réel : 163.8s d'audio pour
  // une vidéo calée sur 62.6s de voix). L'instru démarre à t=0 (pas de délai,
  // contrairement à la voix retardée de vocalDelaySec) : son plafond est donc
  // effectiveOutputDurationSec directement, converti en durée d'ENTRÉE via
  // `ratio` (l'étirement tempo change la durée : tempo=ratio ⇒ durée_sortie =
  // durée_entrée / ratio, donc durée_entrée = durée_sortie × ratio) — une
  // approximation basée sur le ratio GLOBAL (le plan par segment, quand actif,
  // recolle de toute façon ses propres tronçons à la durée de sortie visée
  // par construction ; ce plafond amont reste un filet de sécurité sans effet
  // notable dans ce cas, et redevient le SEUL filet quand buildTempoSchedule
  // renvoie null — cas fréquent, cf. `allSame` dans buildTempoSchedule).
  const instruDurationCapSec = maxDurationSec != null && effectiveOutputDurationSec != null
    ? Math.max(5, effectiveOutputDurationSec * Number(ratio))
    : null;
  const instruTrimFilter  = (instruStartOffset > 0 || instruDurationCapSec != null)
    ? `atrim=start=${instruStartOffset.toFixed(3)}${instruDurationCapSec != null ? `:duration=${instruDurationCapSec.toFixed(3)}` : ""},asetpts=PTS-STARTPTS,`
    : "";

  // Étirement temporel de l'instru : rubberband (phase-vocoder HQ, mêmes
  // artéfacts quasi nuls que pour le pitch-shift ci-dessus) si disponible,
  // sinon repli sur atempo (fenêtre déjà restreinte par safeTempoRatio dans
  // ce cas). "pitch=1" explicite : on ne veut QUE l'effet tempo ici, le
  // pitch de l'instru ne doit pas bouger.
  const tempoFilterExpr = rbAvailable ? `rubberband=pitch=1:tempo=${ratio}` : `atempo=${ratio}`;

  // Loudnorm 2-passes (mesure précise, cf. commentaire sur measureLoudness
  // plus haut) : la mesure REJOUE le même pré-traitement (trim + pitch-shift
  // + HPF/LPF pour la voix, trim seul pour l'instru) que ce qui arrive
  // réellement dans loudnorm au sein de la passe finale ci-dessous — sinon
  // la mesure ne correspondrait pas au signal effectivement normalisé.
  const [vocalsMeasured, instruMeasured] = await Promise.all([
    measureLoudness(vocalsA, `${vocalsTrimFilter}${VOCAL_CLEANUP_FILTER}${pitchFilter}highpass=f=200,lowpass=f=16000,`, vocalsLUFS, "-1.5", "11"),
    measureLoudness(instrumentalB, instruTrimFilter, instruLUFS, "-1.5", "11"),
  ]);
  const vocalsLoudnormExpr = loudnormExpr(vocalsLUFS, "-1.5", "11", vocalsMeasured);
  const instruLoudnormExpr = loudnormExpr(instruLUFS, "-1.5", "11", instruMeasured);
  const glueRatio = adaptiveGlueRatio(instruMeasured?.crestFactorDb, "mixFullRave");

  // Étirement temporel de l'instru : soit l'ancien ratio unique sur toute la
  // piste (tempoSchedule absent — pas de grille de beats exploitable, ou
  // ratio manuel forcé), soit le nouveau plan par segment (tempoSchedule
  // présent) qui recolle N tronçons indépendamment étirés par acrossfade —
  // cf. buildTempoSchedule/buildPiecewiseInstruChain plus haut. Les 2 chemins
  // produisent un flux [instru_norm] identique pour la suite de la chaîne
  // (sidechain multiband, EQ, etc.), qui n'a donc besoin d'aucun changement.
  const instruEqFilter = `${instruTrimFilter}${instruLoudnormExpr},equalizer=f=1800:width_type=o:width=2.5:g=-1.25,equalizer=f=300:width_type=o:width=2:g=-1.5`;
  const instruTempoStage = tempoSchedule
    ? `[1:a]${instruEqFilter}[instru_eq];${buildPiecewiseInstruChain("instru_eq", tempoSchedule, rbAvailable)}`
    : `[1:a]${instruEqFilter},${tempoFilterExpr}[instru_norm]`;

  const cmd = `ffmpeg -i "${vocalsA}" -i "${instrumentalB}" -filter_complex \
"[0:a]${vocalsTrimFilter}${VOCAL_CLEANUP_FILTER}${pitchFilter}highpass=f=200,lowpass=f=16000,${vocalsLoudnormExpr},equalizer=f=3000:width_type=o:width=2:g=2.5,equalizer=f=7000:width_type=h:width=4000:g=-3,aecho=0.8:0.88:60:0.2[vocals_pre];\
[vocals_pre]adelay=${vocalDelayMs}|${vocalDelayMs}[vocals_delayed];\
[vocals_delayed]asplit=2[vocals_out][vocals_sc];\
${instruTempoStage};\
[instru_norm]asplit=2[instru_norm_lo][instru_norm_hp];\
[instru_norm_lo]lowpass=f=200,lowpass=f=200[instru_lo];\
[instru_norm_hp]highpass=f=200,highpass=f=200[instru_hp200];\
[instru_hp200]asplit=2[instru_hp200_a][instru_hp200_b];\
[instru_hp200_a]lowpass=f=3000,lowpass=f=3000[instru_mid];\
[instru_hp200_b]highpass=f=3000,highpass=f=3000[instru_hi];\
[instru_mid]aformat=sample_fmts=fltp:channel_layouts=stereo[instru_mid_fmt];\
[vocals_sc]aformat=sample_fmts=fltp:channel_layouts=stereo[vocals_scfmt];\
[instru_mid_fmt][vocals_scfmt]sidechaincompress=threshold=0.06:ratio=${duckingRatio}:attack=30:release=600:makeup=1[instru_mid_ducked];\
[instru_lo][instru_mid_ducked][instru_hi]amix=inputs=3:normalize=0[instru_ducked_raw];\
[instru_ducked_raw]alimiter=level_in=1:level_out=0.97:limit=0.97:attack=3:release=50[instru_ducked];\
[vocals_out][instru_ducked]amix=inputs=2:duration=longest:dropout_transition=4:normalize=0[mixed];\
[mixed]acompressor=threshold=0.1:ratio=${glueRatio}:attack=80:release=500:makeup=1[mixed_glued];\
[mixed_glued]${MASTER_AIR_SHELF}[mixed_air];\
[mixed_air]alimiter=level_in=1:level_out=0.97:limit=0.95:attack=2:release=50[out]" \
-map "[out]" -ar 44100 "${output}" -y`;
  // Timeout relevé 180s → 420s (diagnostic capture terminal utilisateur :
  // ~0.476x temps réel observé sur cette chaîne multibande/sidechain assez
  // dense, largement de quoi dépasser 3 minutes sur un morceau de 4-5 min dès
  // qu'un autre process CPU-intensif tourne en même temps — cf. aussi
  // routes/mashup.js/services/cpuQueue.js qui limite maintenant le nombre de
  // combos traités en parallèle).
  await execAsync(cmd, { timeout: 420000 });
  return output;
};

// ── Mix SUPERPOSITION COMPLÈTE ("overlay", façon RaveDJ) ────────────────
// Demande explicite (audit RaveDJ juillet 2026) : un mode ALTERNATIF au
// mashup "voix isolée + instru isolé" (mixFullRave), qui superpose les 2
// MIX COMPLETS (wavA/wavB, avant toute séparation Demucs) plutôt que des
// stems — hypothèse retenue dans le rapport d'analyse (Analyse_RaveDJ_vs_
// MacheUp.md) sur ce que RaveDJ fait probablement de son côté : pas
// d'isolation vocale, un calage tempo/tonalité puis une superposition assez
// dense des 2 morceaux. Offert en PLUS du mode stems existant (pas un
// remplacement) pour les utilisateurs qui préfèrent ce rendu plus "brut".
//
// Convention : A reste la piste de référence (même logique que mixFullRave
// où l'instru B est recalé sur le tempo de la voix A) — B est recalé en
// tempo ET, dans un budget prudent (±2 demi-tons, cf. MAX_FULL_MIX_SHIFT),
// transposé vers une tonalité compatible avec A. Budget volontairement plus
// serré qu'un stem vocal isolé (MAX_AUTO_VOCAL_SHIFT dans mixFullRave) : un
// mix complet contient basse/batterie, bien moins tolérant à un pitch-shift
// marqué qu'une voix seule.
//
// Équilibre A/B piloté par le même curseur "crossfade" que les autres modes,
// mais symétriquement ici (0 = A dominant, 1 = B dominant) plutôt que
// voix/instru. Chaîne de polish partagée avec mixFullRave (glue compressor +
// shelf "air" + limiter final) pour un résultat cohérent avec le reste de
// l'app plutôt qu'un simple amix brut.
export const mixFullOverlay = async (fullA, fullB, bpmA, bpmB, crossfade, output, opts = {}) => {
  const { keyA = null, keyB = null, camelotA = null, camelotB = null,
          offsetA = 0, offsetB = 0,
          // Même sémantique que dans mixFullRave : null = pas de plafond
          // (durée naturelle, = piste A du offset choisi à sa fin) ; sinon
          // durée totale de sortie visée (mode "tailored", cf. routes/mashup.js).
          maxDurationSec = null,
          // Grilles de beats des 2 pistes (analyzer.js, beat_times) — cf.
          // commentaire détaillé plus bas sur le plan de tempo par segment.
          // Optionnelles : absentes/vides → repli sur l'ancien ratio unique,
          // sans régression (comportement historique inchangé dans ce cas).
          beatTimesA = [], beatTimesB = [] } = opts;
  const rbAvailable = await hasRubberband();

  const ratio = safeTempoRatio(bpmA, bpmB, rbAvailable).toFixed(4);
  console.log(`[mixFullOverlay] BPM A=${bpmA} B=${bpmB} → ratio tempo B→A=${ratio}${rbAvailable ? " (rubberband)" : " (atempo)"}`);

  // ── Durée effective (même logique que mixFullRave, cf. son commentaire
  // détaillé sur effectiveOutputDurationSec) — réutilisée ci-dessous à la
  // fois pour le plan de tempo par segment ET pour les plafonds A/B.
  const fullADuration = await getDuration(fullA).catch(() => null);
  const naturalOutputDurationSec = fullADuration != null ? Math.max(0, fullADuration - offsetA) : null;
  const effectiveOutputDurationSec = maxDurationSec != null && naturalOutputDurationSec != null
    ? Math.min(naturalOutputDurationSec, Math.max(maxDurationSec, 5))
    : (maxDurationSec != null ? maxDurationSec : naturalOutputDurationSec);

  // ── Plan de tempo par segment pour B (audit qualité juillet 2026) ────────
  // Avant : B était réaligné sur A avec un SEUL ratio de tempo global
  // (safeTempoRatio) appliqué sur toute la piste. Problème : contrairement à
  // mixFullRave (où seul l'instru "respire" pendant qu'une voix isolée reste
  // stable), ici les 2 pistes COMPLÈTES (basse/batterie/voix incluses) jouent
  // en même temps — la moindre dérive de tempo entre A et B (BPM local qui
  // varie légèrement au fil du morceau, très fréquent sur un enregistrement
  // réel non quantifié) devient immédiatement audible : les 2 grilles
  // rythmiques se désynchronisent progressivement, ce qui donne une
  // impression de résultat "bancal"/médiocre par rapport à RaveDJ (retour
  // utilisateur juillet 2026). Fix : réutiliser exactement le même plan de
  // tempo PAR SEGMENT que mixFullRave (buildTempoSchedule/
  // buildPiecewiseInstruChain) pour B — recalé localement tous les ~20s sur
  // le BPM réel de A et B à cet instant, au lieu d'un seul ratio moyen sur
  // toute la durée. Null si aucune grille de beats exploitable (repli sur
  // l'ancien comportement, sans régression).
  let tempoSchedule = null;
  if (effectiveOutputDurationSec != null) {
    try {
      tempoSchedule = buildTempoSchedule({
        outputDurationSec: effectiveOutputDurationSec, vocalDelaySec: 0,
        vocalsStartOffset: offsetA, instruStartOffset: offsetB,
        beatTimesVocals: beatTimesA, beatTimesInstru: beatTimesB,
        globalBpmVocals: bpmA, globalBpmInstru: bpmB, rbAvailable,
      });
    } catch (e) {
      console.warn(`[mixFullOverlay] plan de tempo par segment ignoré (repli sur ratio global) : ${e.message}`);
    }
  }

  const MAX_FULL_MIX_SHIFT = 2;
  const shift = camelotA && camelotB
    ? camelotAwareShift(camelotB, camelotA, keyB, keyA, MAX_FULL_MIX_SHIFT)
    : (Math.abs(semitoneShift(keyB, keyA)) <= MAX_FULL_MIX_SHIFT ? semitoneShift(keyB, keyA) : 0);
  if (shift !== 0) {
    console.log(`[mixFullOverlay] clé B=${keyB} clé A=${keyA} → B transposé de ${shift > 0 ? "+" : ""}${shift} demi-ton(s) pour rejoindre une tonalité compatible avec A`);
  }
  const pitchRatio = Math.pow(2, shift / 12);

  const durCap = effectiveOutputDurationSec != null ? `:duration=${effectiveOutputDurationSec.toFixed(3)}` : "";
  const trimAFilter = (offsetA > 0 || durCap)
    ? `atrim=start=${offsetA.toFixed(3)}${durCap},asetpts=PTS-STARTPTS,` : "";
  // Plafond de durée sur B AUSSI (cf. commentaire détaillé sur
  // effectiveOutputDurationSec dans mixFullRave) : sans ça, "amix=
  // duration=longest" (plus bas) laisse B continuer sur toute sa longueur
  // brute et dicter la durée réelle de sortie dès qu'elle dépasse celle
  // visée pour A. B est tempo-étiré vers A (tempo=ratio) : son plafond en
  // durée d'ENTRÉE est donc effectiveOutputDurationSec × ratio (durée_sortie
  // = durée_entrée / ratio ⇒ durée_entrée = durée_sortie × ratio) — une
  // approximation basée sur le ratio GLOBAL (le plan par segment, quand
  // actif, recolle de toute façon ses propres tronçons à la durée visée par
  // construction ; ce plafond amont reste un filet de sécurité sans effet
  // notable dans ce cas).
  const durCapB = effectiveOutputDurationSec != null ? `:duration=${(effectiveOutputDurationSec * Number(ratio)).toFixed(3)}` : "";
  const trimBFilter = (offsetB > 0 || durCapB)
    ? `atrim=start=${offsetB.toFixed(3)}${durCapB},asetpts=PTS-STARTPTS,` : "";

  // Pitch de B SEUL (tempo=1) — séparé du tempo pour pouvoir enchaîner sur le
  // plan par segment ci-dessous (qui gère lui-même le tempo, tronçon par
  // tronçon) : rubberband/asetrate+atempo appliquent ici UNIQUEMENT le
  // décalage de tonalité, sans toucher à la durée.
  const pitchOnlyFilter = shift !== 0
    ? (rbAvailable
        ? `rubberband=pitch=${pitchRatio.toFixed(6)}:tempo=1:formant=preserved,`
        : `asetrate=44100*${pitchRatio.toFixed(6)},aresample=44100,atempo=${(1 / pitchRatio).toFixed(6)},`)
    : "";
  const needsTempo = Math.abs(Number(ratio) - 1) >= 0.005;

  const cf = Math.min(Math.max(crossfade, 0), 1);
  // Cible loudnorm alignée sur le reste de l'app (cf. commentaire "v3 analyse
  // rave.dj" dans mixFullRave) — ±1 dB de bascule symétrique A/B pilotée par
  // le curseur crossfade, pas de priorité voix/instru ici (2 mix complets).
  const lufsA = (-14 + (1 - cf) * 1).toFixed(1);
  const lufsB = (-14 - (1 - cf) * 1).toFixed(1);

  // ── Carve basse sur B (audit qualité juillet 2026) ───────────────────────
  // Sans isolation vocale ici (contrairement à "full"/"stems"), superposer 2
  // MIX COMPLETS fait cogner 2 basses/grosses caisses en même temps sur la
  // même plage de fréquences — un des principaux facteurs du côté "brouillon"
  // signalé (comparé à RaveDJ). Un peu de densité vocale reste inévitable
  // dans ce mode (c'est le principe même de la "superposition complète", pas
  // un défaut à corriger sans réintroduire Demucs), mais le conflit de basses
  // n'a lui rien d'inhérent : A garde tout son spectre (piste "fondation"),
  // B reçoit une coupe douce autour de 90 Hz — technique de blend DJ classique
  // ("bass swap") pour garder un bas du spectre propre.
  const bEqFilter = `${trimBFilter}${pitchOnlyFilter}loudnorm=I=${lufsB}:TP=-1.5:LRA=11,equalizer=f=90:width_type=o:width=1.5:g=-4`;
  const bTempoStage = tempoSchedule
    ? `[1:a]${bEqFilter}[b_eq];${buildPiecewiseInstruChain("b_eq", tempoSchedule, rbAvailable)}`
    : needsTempo
      ? `[1:a]${bEqFilter},${rbAvailable ? `rubberband=pitch=1:tempo=${ratio}` : `atempo=${ratio}`}[instru_norm]`
      : `[1:a]${bEqFilter}[instru_norm]`;

  // mastering adaptatif (cf. adaptiveGlueRatio) : pas de loudnorm 2-passes
  // ici (cf. commentaire "Cible loudnorm alignée..." ci-dessus, précision
  // jugée suffisante en 1-passe pour ce mode) — mesure de crest factor
  // AUTONOME sur B (piste "fondation" dominant le grain du mix superposé).
  const overlayCrestFactorDb = await measureCrestFactorDb(fullB, trimBFilter);
  const glueRatio = adaptiveGlueRatio(overlayCrestFactorDb, "mixFullOverlay");

  const cmd = `ffmpeg -i "${fullA}" -i "${fullB}" -filter_complex \
"[0:a]${trimAFilter}loudnorm=I=${lufsA}:TP=-1.5:LRA=11[a0];\
${bTempoStage};\
[a0][instru_norm]amix=inputs=2:duration=longest:normalize=0[mixed];\
[mixed]acompressor=threshold=0.1:ratio=${glueRatio}:attack=80:release=500:makeup=1[mixed_glued];\
[mixed_glued]${MASTER_AIR_SHELF}[mixed_air];\
[mixed_air]alimiter=level_in=1:level_out=0.97:limit=0.95:attack=2:release=50[out]" \
-map "[out]" -ar 44100 "${output}" -y`;
  await execAsync(cmd, { timeout: 300000 });
  return output;
};

// Mix DUO : 2 voix alternées (ping-pong mesure→mesure) sur un seul instrumental.
// Voix A chante les mesures paires (0, 2, 4…), voix B chante les mesures
// impaires (1, 3, 5…). Les 2 voix sont transposées indépendamment pour
// rejoindre la tonalité de l'instru (camelotAwareShift ou semitoneShift).
// Même chaîne qualité que mixFullRave (HPF 200, EQ, loudnorm, de-ess,
// aecho 60ms, sidechain multiband, glue compressor, limiter).
// Le tempo de l'instru est calé sur bpmA (voix A = référence).
// La durée de mesure du gate est calculée sur ce BPM effectif.
export const mixFullRaveDuo = async (vocalsA, vocalsB, instrumental, bpmA, bpmB, bpmInstru, crossfade, output, opts = {}) => {
  const {
    balanceOffsetDb = 0, duckingRatio = 2.5, vocalsTrimDb = 0,
    keyVocalsA = null, keyVocalsB = null, keyInstru = null,
    camelotVocalsA = null, camelotVocalsB = null, camelotInstru = null,
    vocalsAStartOffset = 0, vocalsBStartOffset = 0, instruStartOffset = 0,
    // Pas de valeur numérique fixe par défaut : un 4000ms codé en dur ici ne
    // tombe quasiment jamais sur un temps fort (downbeat) une fois rapporté à
    // la grille de mesure réelle du morceau — cf. le même bug corrigé dans
    // mixFullRave (routes/mashup.js utilisait le mauvais BPM). Le calcul par
    // défaut ci-dessous (measureDur, déjà correct : basé sur bpmA/bpmInstru)
    // s'applique tant que l'appelant ne fournit pas explicitement une valeur.
    vocalDelayMs: vocalDelayMsOverride = null,
    // ── Réglages manuels ("pitch fader") — cf. commentaire détaillé dans
    // mixFullRave ci-dessus. null = comportement automatique inchangé.
    manualTempoRatio = null, manualSemitoneShiftA = null, manualSemitoneShiftB = null,
  } = opts;

  // Vérifié une fois ici (résultat mis en cache), réutilisé pour le pitch-
  // shift des 2 voix ET pour l'étirement temporel de l'instru ci-dessous —
  // cf. mixFullRave pour le détail du raisonnement (fenêtre de qualité
  // élargie quand rubberband est disponible).
  const rbAvailable = await hasRubberband();

  // Instru calé sur bpmA (voix A = référence), même logique que mixFullRave.
  const ratio = manualTempoRatio != null
    ? Number(manualTempoRatio).toFixed(4)
    : safeTempoRatio(bpmA, bpmInstru, rbAvailable).toFixed(4);
  console.log(`[mixFullRaveDuo] BPM A=${bpmA} B=${bpmB} Instru=${bpmInstru} → ratio=${ratio}${manualTempoRatio != null ? " (manuel)" : rbAvailable ? " (rubberband)" : " (atempo)"}`);

  // Durée d'une mesure 4/4 au tempo effectif de bpmA.
  // Utilisée par le gate volume pour alterner les 2 voix à chaque mesure :
  //   vol A = mod(floor(t/M)+1, 2) → 1 sur mesures paires, 0 sur impaires
  //   vol B = mod(floor(t/M),   2) → 0 sur mesures paires, 1 sur impaires
  const effectiveBpm = bpmA || bpmInstru || 120;
  const measureDur = (4 * 60 / effectiveBpm).toFixed(6);

  // Délai vocal par défaut : ~4s, arrondi au multiple entier de measureDur
  // (même grille que le gate ci-dessus) — garantit que l'entrée des voix
  // tombe sur un downbeat plutôt qu'en milieu de mesure. Remplace l'ancien
  // 4000ms fixe, qui ne tombait juste par hasard.
  const introMeasures = Math.max(1, Math.round(4.0 / parseFloat(measureDur)));
  const computedVocalDelayMs = Math.round(introMeasures * parseFloat(measureDur) * 1000);
  const vocalDelayMs = vocalDelayMsOverride ?? computedVocalDelayMs;

  // Budget de décalage AUTO (voix A/B) : même limite et même raisonnement que
  // dans mixFullRave — passé DIRECTEMENT à camelotAwareShift/semitoneShift
  // plutôt qu'appliqué en clamp après coup (cf. commentaire détaillé dans
  // mixFullRave : un clamp a posteriori pouvait faire atterrir la voix sur
  // une note fausse, ni l'originale ni la cible). Un override manuel
  // explicite n'est pas concerné.
  const MAX_AUTO_VOCAL_SHIFT_DUO = 2;
  const autoShiftWithinBudget = (camelotVocals, keyVocals) => camelotVocals && camelotInstru
    ? camelotAwareShift(camelotVocals, camelotInstru, keyVocals, keyInstru, MAX_AUTO_VOCAL_SHIFT_DUO)
    : (Math.abs(semitoneShift(keyVocals, keyInstru)) <= MAX_AUTO_VOCAL_SHIFT_DUO ? semitoneShift(keyVocals, keyInstru) : 0);
  const idealShiftFor = (camelotVocals, keyVocals) => camelotVocals && camelotInstru
    ? camelotAwareShift(camelotVocals, camelotInstru, keyVocals, keyInstru)
    : semitoneShift(keyVocals, keyInstru);

  // Pitch shift voix A → tonalité instru
  const autoShiftA = autoShiftWithinBudget(camelotVocalsA, keyVocalsA);
  const shiftA = manualSemitoneShiftA != null ? Number(manualSemitoneShiftA) : autoShiftA;
  const pitchRatioA = Math.pow(2, shiftA / 12);
  // formant=preserved : cf. commentaire détaillé dans mixFullRave ci-dessus.
  const pitchFilterA = shiftA !== 0
    ? rbAvailable
      ? `rubberband=pitch=${pitchRatioA.toFixed(6)}:tempo=1:formant=preserved,`
      : `asetrate=44100*${pitchRatioA.toFixed(6)},aresample=44100,atempo=${(1 / pitchRatioA).toFixed(6)},`
    : "";

  // Pitch shift voix B → tonalité instru
  const autoShiftB = autoShiftWithinBudget(camelotVocalsB, keyVocalsB);
  const shiftB = manualSemitoneShiftB != null ? Number(manualSemitoneShiftB) : autoShiftB;
  const pitchRatioB = Math.pow(2, shiftB / 12);
  // formant=preserved : cf. commentaire détaillé dans mixFullRave ci-dessus.
  const pitchFilterB = shiftB !== 0
    ? rbAvailable
      ? `rubberband=pitch=${pitchRatioB.toFixed(6)}:tempo=1:formant=preserved,`
      : `asetrate=44100*${pitchRatioB.toFixed(6)},aresample=44100,atempo=${(1 / pitchRatioB).toFixed(6)},`
    : "";

  if (shiftA !== 0) console.log(`[mixFullRaveDuo] voix A : ${shiftA > 0 ? "+" : ""}${shiftA} demi-ton(s)`);
  if (shiftB !== 0) console.log(`[mixFullRaveDuo] voix B : ${shiftB > 0 ? "+" : ""}${shiftB} demi-ton(s)`);
  if (manualSemitoneShiftA == null && autoShiftA === 0 && keyVocalsA && keyInstru) {
    const idealA = idealShiftFor(camelotVocalsA, keyVocalsA);
    if (idealA !== 0) console.warn(`[mixFullRaveDuo] voix A : tonalité idéale (${idealA > 0 ? "+" : ""}${idealA} demi-tons) hors budget ±${MAX_AUTO_VOCAL_SHIFT_DUO} — laissée dans sa tonalité d'origine.`);
  }
  if (manualSemitoneShiftB == null && autoShiftB === 0 && keyVocalsB && keyInstru) {
    const idealB = idealShiftFor(camelotVocalsB, keyVocalsB);
    if (idealB !== 0) console.warn(`[mixFullRaveDuo] voix B : tonalité idéale (${idealB > 0 ? "+" : ""}${idealB} demi-tons) hors budget ±${MAX_AUTO_VOCAL_SHIFT_DUO} — laissée dans sa tonalité d'origine.`);
  }

  const cf = Math.min(Math.max(crossfade, 0), 1);
  // Pivot voix légèrement plus bas (−14.5 au lieu de −13.5) : la voix active
  // est seule à jouer (gate exclusif), donc pas de saturation par sommation,
  // mais on réserve 1 dB de marge pour la transition instantanée de gate.
  // Encore abaissé d'1 dB (−15.5) : même correctif que mixFullRave, retour
  // utilisateur "vocal légèrement trop fort par rapport à l'instru".
  const vocalsLUFS = (-15.5 + (1 - cf) * 1 - balanceOffsetDb / 2 - vocalsTrimDb).toFixed(1);
  const instruLUFS = (-13.5 - (1 - cf) * 1 + balanceOffsetDb / 2).toFixed(1);

  const vaTrimFilter = vocalsAStartOffset > 0
    ? `atrim=start=${vocalsAStartOffset.toFixed(3)},asetpts=PTS-STARTPTS,` : "";
  const vbTrimFilter = vocalsBStartOffset > 0
    ? `atrim=start=${vocalsBStartOffset.toFixed(3)},asetpts=PTS-STARTPTS,` : "";
  const instruTrimFilter = instruStartOffset > 0
    ? `atrim=start=${instruStartOffset.toFixed(3)},asetpts=PTS-STARTPTS,` : "";

  // Même raisonnement que mixFullRave : rubberband si dispo (pitch=1, tempo
  // seul modifié), sinon repli atempo (fenêtre déjà restreinte en conséquence
  // par safeTempoRatio ci-dessus).
  const tempoFilterExpr = rbAvailable ? `rubberband=pitch=1:tempo=${ratio}` : `atempo=${ratio}`;

  // Loudnorm 2-passes (cf. mixFullRave) : mesure sur les 3 flux (voix A, voix
  // B, instru) avec le même pré-traitement que la passe finale ci-dessous.
  const [vocalsAMeasured, vocalsBMeasured, instruMeasured] = await Promise.all([
    measureLoudness(vocalsA, `${vaTrimFilter}${VOCAL_CLEANUP_FILTER}${pitchFilterA}highpass=f=200,lowpass=f=16000,`, vocalsLUFS, "-1.5", "11"),
    measureLoudness(vocalsB, `${vbTrimFilter}${VOCAL_CLEANUP_FILTER}${pitchFilterB}highpass=f=200,lowpass=f=16000,`, vocalsLUFS, "-1.5", "11"),
    measureLoudness(instrumental, instruTrimFilter, instruLUFS, "-1.5", "11"),
  ]);
  const vocalsALoudnormExpr = loudnormExpr(vocalsLUFS, "-1.5", "11", vocalsAMeasured);
  const vocalsBLoudnormExpr = loudnormExpr(vocalsLUFS, "-1.5", "11", vocalsBMeasured);
  const instruLoudnormExpr = loudnormExpr(instruLUFS, "-1.5", "11", instruMeasured);
  const glueRatio = adaptiveGlueRatio(instruMeasured?.crestFactorDb, "mixFullRaveDuo");

  const cmd = `ffmpeg -i "${vocalsA}" -i "${vocalsB}" -i "${instrumental}" -filter_complex \
"[0:a]${vaTrimFilter}${VOCAL_CLEANUP_FILTER}${pitchFilterA}highpass=f=200,lowpass=f=16000,${vocalsALoudnormExpr},equalizer=f=3000:width_type=o:width=2:g=2.5,equalizer=f=7000:width_type=h:width=4000:g=-3,aecho=0.8:0.88:60:0.2[va_eq];\
[1:a]${vbTrimFilter}${VOCAL_CLEANUP_FILTER}${pitchFilterB}highpass=f=200,lowpass=f=16000,${vocalsBLoudnormExpr},equalizer=f=3000:width_type=o:width=2:g=2.5,equalizer=f=7000:width_type=h:width=4000:g=-3,aecho=0.8:0.88:60:0.2[vb_eq];\
[va_eq]volume='mod(floor(t/${measureDur})+1,2)':eval=frame[va_gated];\
[vb_eq]volume='mod(floor(t/${measureDur}),2)':eval=frame[vb_gated];\
[va_gated][vb_gated]amix=inputs=2:normalize=0[vocals_mixed];\
[vocals_mixed]adelay=${vocalDelayMs}|${vocalDelayMs}[vocals_delayed];\
[vocals_delayed]asplit=2[vocals_out][vocals_sc];\
[2:a]${instruTrimFilter}${instruLoudnormExpr},equalizer=f=1800:width_type=o:width=2.5:g=-1.25,equalizer=f=300:width_type=o:width=2:g=-1.5,${tempoFilterExpr}[instru_norm];\
[instru_norm]asplit=2[instru_norm_lo][instru_norm_hp];\
[instru_norm_lo]lowpass=f=200,lowpass=f=200[instru_lo];\
[instru_norm_hp]highpass=f=200,highpass=f=200[instru_hp200];\
[instru_hp200]asplit=2[instru_hp200_a][instru_hp200_b];\
[instru_hp200_a]lowpass=f=3000,lowpass=f=3000[instru_mid];\
[instru_hp200_b]highpass=f=3000,highpass=f=3000[instru_hi];\
[instru_mid]aformat=sample_fmts=fltp:channel_layouts=stereo[instru_mid_fmt];\
[vocals_sc]aformat=sample_fmts=fltp:channel_layouts=stereo[vocals_scfmt];\
[instru_mid_fmt][vocals_scfmt]sidechaincompress=threshold=0.06:ratio=${duckingRatio}:attack=30:release=600:makeup=1[instru_mid_ducked];\
[instru_lo][instru_mid_ducked][instru_hi]amix=inputs=3:normalize=0[instru_ducked_raw];\
[instru_ducked_raw]alimiter=level_in=1:level_out=0.97:limit=0.97:attack=3:release=50[instru_ducked];\
[vocals_out][instru_ducked]amix=inputs=2:duration=longest:dropout_transition=4:normalize=0[mixed];\
[mixed]acompressor=threshold=0.1:ratio=${glueRatio}:attack=80:release=500:makeup=1[mixed_glued];\
[mixed_glued]${MASTER_AIR_SHELF}[mixed_air];\
[mixed_air]alimiter=level_in=1:level_out=0.97:limit=0.95:attack=2:release=50[out]" \
-map "[out]" -ar 44100 "${output}" -y`;
  // cf. commentaire détaillé sur le même relèvement de timeout dans
  // mixFullRave ci-dessus (mixFullRaveDuo traite en plus 3 flux d'entrée au
  // lieu de 2, donc au moins aussi sensible à la contention CPU).
  await execAsync(cmd, { timeout: 420000 });
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
// pas d'accélération GPU disponible ni nécessaire (encodage déjà rapide, de
// l'ordre de la seconde pour quelques minutes d'audio — pas un poste de
// temps significatif du pipeline). compression_level abaissé 5 → 1 (0-8,
// plus bas = plus rapide/fichier plus gros, toujours sans perte) : gain
// marginal mais gratuit, ces fichiers ne sont pas contraints en taille.
export const exportFLAC = async (input, output) => {
  const cmd = `ffmpeg -i "${input}" -codec:a flac -compression_level 1 "${output}" -y`;
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

// ── Généralisation "plan de segments" (Phase 3, juillet 2026) ───────────────
// Extrait du corps original de buildAlternatingFilter : au lieu de calculer
// SES PROPRES positions de segment à partir d'une durée fixe, cette version
// prend un plan déjà construit ({srcIdx, start, duration} par segment) — ce
// qui permet à videoCutPlanner.js (segments calés sur le beat grid + coupures
// de plan détectées) de produire exactement le même type de filter_complex
// que l'ancien montage à durée fixe, sans dupliquer toute la logique de
// construction de la chaîne xfade/tpad/repères/watermark ci-dessous.
// buildAlternatingFilter (plus bas) devient un simple appelant qui construit
// l'ANCIEN plan à durée fixe puis délègue ici — comportement STRICTEMENT
// identique à avant ce refactor pour tout appelant qui ne fournit pas de plan
// musical, cf. buildSilentVideoMontage.
const buildFilterFromPlan = (plan, totalSec, xfadeSec, hwDecoded, withWatermark = false) => {
  const pre = hwDecoded ? "hwdownload,format=yuv420p," : "";
  const numSegments = plan.length;

  const segments = plan.map(({ srcIdx, start, duration }, i) =>
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
    // frame à 1920x1080, ce qui aggrave encore le risque d'OOM ci-dessus.
    // Format 16:9 (1920x1080, paysage) — remplace l'ancien format 9:16
    // (1080x1920, portrait façon Reels/Shorts) suite à la demande explicite
    // de repasser en format d'écran standard.
    `[${srcIdx}:v]${pre}trim=start=${start.toFixed(2)}:duration=${duration.toFixed(2)},setpts=PTS-STARTPTS,` +
    `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=30,format=yuv420p[seg${i}]`
  );

  const xfades = [];
  let prevLabel = "seg0";
  // Chaque transition xfade CHEVAUCHE 2 segments sur xfadeSec — la durée
  // réelle du montage final est donc systématiquement plus COURTE que la
  // somme des durées de segment (chaque fondu "mange" du temps au lieu d'en
  // ajouter). Avec MAX_SEGMENTS=12 et un xfade allant jusqu'à 1.2s, l'écart
  // cumulé peut dépasser 10s — d'où la vidéo qui finissait plus tôt que
  // l'audio, et le "-shortest" de muxVideoAudio qui tronquait ENSUITE la
  // piste son pour caler sur cette vidéo trop courte ("le son s'arrête avant
  // la fin du clip"). On calcule ici l'écart réel et on le référence dans le
  // dernier label pour appliquer un correctif juste après (cf. plus bas).
  // markerTimes : position (secondes, timeline finale) du MILIEU de chaque
  // transition — cf. repères de synchro invisibles plus bas.
  const markerTimes = [];
  let runningDuration = plan[0].duration;
  for (let i = 1; i < numSegments; i++) {
    const outLabel = i === numSegments - 1 ? "vraw" : `x${i}`;
    const offset = Math.max(0, runningDuration - xfadeSec);
    markerTimes.push(offset + xfadeSec / 2);
    xfades.push(`[${prevLabel}][seg${i}]xfade=transition=fade:duration=${xfadeSec.toFixed(2)}:offset=${offset.toFixed(2)}[${outLabel}]`);
    runningDuration += plan[i].duration - xfadeSec;
    prevLabel = outLabel;
  }
  // numSegments est toujours ≥ 2 (cf. Math.max(2, ...) côté appelants), donc
  // la boucle ci-dessus s'exécute toujours au moins une fois et prevLabel
  // vaut déjà "vraw" à ce stade.

  // Correctif troncature : on rallonge le montage (en clonant sa dernière
  // image) d'au moins l'écart calculé ci-dessus + une marge de sécurité de
  // 0.5s (arrondis ffmpeg / alignement de frames) pour GARANTIR que la
  // vidéo ne soit jamais plus courte que l'audio — le "-shortest" de
  // muxVideoAudio peut alors continuer à s'appuyer sur la durée de l'audio
  // (référence voulue) sans jamais couper la fin du morceau.
  const padNeeded = Math.max(0, totalSec - runningDuration) + 0.5;
  const tpadStage = `[${prevLabel}]tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(2)}[vpad]`;

  // ── Repères de synchro invisibles ────────────────────────────────────────
  // À chaque coupe/transition, on incruste UNE SEULE image pleine couleur
  // (magenta pur — une teinte qui n'apparaît quasiment jamais dans une vraie
  // vidéo, donc facilement repérable) via drawbox, gated sur une fenêtre
  // d'exactement 1 image (1/30s ici) grâce à "enable=between(t,...)". À la
  // lecture normale, ce flash est trop bref pour être perçu (1 image sur 30
  // à cet instant précis) — mais en scrubant image par image dans un logiciel
  // de montage, ce repère est parfaitement visible et permet de vérifier que
  // le montage vidéo tombe bien sur le rythme voulu par rapport à la musique.
  // Pas besoin d'échapper les virgules à l'intérieur de between(...) : comme
  // pour le volume='mod(floor(t/...)+1,2)' déjà utilisé plus haut
  // (mixFullRaveDuo), une expression entre guillemets SIMPLES est prise par
  // ffmpeg comme une valeur opaque — la virgule à l'intérieur n'est pas
  // interprétée comme un séparateur de filtres tant qu'elle reste dans ces
  // guillemets simples.
  const FRAME_DUR = 1 / 30;
  const MARKER_COLOR = "magenta";
  let markerChain = "";
  let markerPrev = "vpad";
  markerTimes.forEach((t, i) => {
    const outLabel = i === markerTimes.length - 1 ? "v" : `mk${i}`;
    markerChain += `;[${markerPrev}]drawbox=x=0:y=0:w=iw:h=ih:color=${MARKER_COLOR}@1.0:t=fill:` +
      `enable='between(t,${t.toFixed(3)},${(t + FRAME_DUR).toFixed(3)})'[${outLabel}]`;
    markerPrev = outLabel;
  });
  // Aucune transition (cas normalement impossible, numSegments ≥ 2 garantit
  // au moins 1 marqueur, mais gardé par sécurité) : "vpad" doit quand même
  // être renommé "v" pour que la suite de la chaîne (mux) trouve son label.
  if (markerTimes.length === 0) markerChain = ";[vpad]copy[v]";

  // ── Watermark (icon.ico, bas droite) ──────────────────────────────────
  // [N:v] = input ffmpeg JUSTE APRÈS les N sources vidéo du plan (image
  // statique, cf. exportMP4_916/buildMultiSourceVideoMontage qui l'ajoutent
  // avec "-loop 1" pour qu'elle soit tenue pendant toute la durée du
  // montage). Indice calculé dynamiquement (Phase 5, juillet 2026 — au lieu
  // du "[2:v]" fixe d'origine) : le montage à 2 sources reste "[2:v]" comme
  // avant (aucun changement de comportement), mais un plan à N sources
  // vidéo (montage multi-morceaux) a besoin de "[N:v]", pas "[2:v]" —
  // srcIdx va de 0 à N-1 dans le plan (garanti par buildAlternatingFilter/
  // planMusicSyncedCuts/planMultiSourceCuts), donc max(srcIdx)+1 = N.
  // Redimensionnée à une largeur fixe (120px, hauteur proportionnelle) et
  // convertie en RGBA (préserve la transparence si le fichier en a une)
  // avant l'overlay. Marge de 24px des 2 bords — assez pour rester lisible
  // sans mordre sur le cadre 16:9. "format=auto" laisse ffmpeg choisir le
  // pixel format de sortie le plus compatible avec l'encodeur demandé
  // ensuite (NVENC ou libx264).
  // scale=120:-2 (pas -1) : arrondit la hauteur au nombre pair le plus
  // proche — nécessaire pour l'encodage 4:2:0 (NVENC/libx264 refusent une
  // dimension impaire, "-1" seul peut y mener selon le ratio de l'icône).
  const watermarkInputIdx = Math.max(...plan.map(s => s.srcIdx)) + 1;
  const watermarkStage = withWatermark
    ? `;[${watermarkInputIdx}:v]scale=120:-2,format=rgba[wm];[v][wm]overlay=W-w-24:H-h-24:format=auto[vout]`
    : "";

  return `"${segments.join(";")};${xfades.length ? xfades.join(";") + ";" : ""}${tpadStage}${markerChain}${watermarkStage}"`;
};

// ── Ancien montage à durée fixe (comportement d'origine, préservé tel quel)─
// Construit le plan historique (segments égaux, bouclage modulo sur chaque
// source) puis délègue à buildFilterFromPlan — AUCUN changement de
// comportement pour les appelants qui ne fournissent pas de plan musical
// (cf. buildSilentVideoMontage : repli automatique dès que le calage musical
// échoue ou n'a pas assez de données).
const buildAlternatingFilter = (totalSec, durA, durB, segmentSec, xfadeSec, hwDecoded, withWatermark = false) => {
  let numSegments = Math.max(2, Math.ceil(totalSec / segmentSec));
  // Recalcule une durée de segment plus longue si on dépasse le plafond, au
  // lieu de garder des segments courts sur une chaîne de transitions énorme.
  if (numSegments > MAX_SEGMENTS) {
    numSegments = MAX_SEGMENTS;
    segmentSec = totalSec / numSegments;
  }

  const plan = [];
  let occA = 0, occB = 0;
  for (let i = 0; i < numSegments; i++) {
    const isA = i % 2 === 0;
    const srcIdx = isA ? 0 : 1;
    const srcDur = isA ? durA : durB;
    const occ = isA ? occA++ : occB++;
    const span = Math.max(srcDur - segmentSec, 1); // évite un trim qui dépasse la fin de la source
    const start = srcDur > 0 ? (occ * segmentSec) % span : 0;
    plan.push({ srcIdx, start, duration: segmentSec });
  }

  return buildFilterFromPlan(plan, totalSec, xfadeSec, hwDecoded, withWatermark);
};

// Preset NVENC relevé p4 ("medium") → p2 ("fast") : priorité vitesse demandée
// explicitement. Sur l'échelle NVENC (p1 le plus rapide/qualité la plus
// faible → p7 le plus lent/meilleure qualité), p2 reste très proche en
// qualité perçue de p4 pour du H.264 à ce niveau de bitrate (cq22), pour un
// gain de vitesse d'encodage notable — l'encodage matériel NVENC n'est de
// toute façon jamais le principal poste de temps du pipeline (Demucs domine
// largement), mais chaque seconde gagnée ici s'ajoute sans coût de qualité
// perceptible.
// ── Caches de capacité GPU vidéo (audit perf juillet 2026, résolution tâche
// "repli GPU décodage/encodage redondant") — même principe que _hasRubberband
// plus haut : une machine qui échoue une fois à décoder en CUDA ou à encoder
// en NVENC échouera de la même façon à CHAQUE appel suivant (pilote/matériel
// fixes pour la durée de vie du process) — inutile de re-tenter et re-échouer
// à l'identique à chaque export. null = pas encore testé, true/false = résultat
// mémorisé pour tout le reste de cette session serveur.
let _cudaDecodeWorks = null;
let _nvencWorks = null;

const ENCODE_GPU = `-c:v h264_nvenc -preset p2 -tune hq -rc vbr -cq 22 -b:v 0 -movflags +faststart`;
const ENCODE_CPU = `-c:v libx264 -preset veryfast -crf 22 -movflags +faststart`;

// Mux rapide vidéo+audio par simple copie du flux vidéo (pas de ré-encodage)
// — utilisé pour assembler le montage "silencieux" (cf. ci-dessous) avec un
// mix audio, et réutilisable plus tard pour recombiner ce même montage avec
// une AUTRE piste audio (mashup personnalisé) sans refaire tout l'encodage
// vidéo, qui est l'étape la plus longue.
export const muxVideoAudio = async (videoPath, audioPath, output) => {
  const cmd = `ffmpeg -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 ` +
    `-c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "${output}" -y`;
  await execAsync(cmd, { timeout: 60000 });
  return output;
};

// ── Montage vidéo silencieux, DÉCOUPLÉ du mixage audio (audit perf juillet
// 2026) ───────────────────────────────────────────────────────────────────
// Constat : cette fonction (segments + fondus + watermark + encodage GPU/CPU)
// ne lit JAMAIS le contenu audio réel — seule sa DURÉE TOTALE (totalSec) lui
// est nécessaire, pour savoir combien de segments A/B alterner. Pourtant,
// exportMP4_916 (plus bas) attendait que le mixage audio final (mixFullRave,
// mesuré à ~0.48x temps réel dans les logs — donc environ 2x la durée du
// morceau) soit ENTIÈREMENT terminé avant de démarrer ce montage, alors que
// les deux n'ont AUCUNE ressource ni fichier en commun (CPU/filter_complex
// pur pour l'un, GPU/NVENC pour l'autre). En extrayant totalSec en paramètre
// explicite plutôt que de le déduire du fichier audio final, cette fonction
// peut être lancée EN PARALLÈLE du mixage (cf. routes/mashup.js, qui calcule
// désormais totalSec par avance avec la même formule que mixFullRave utilise
// en interne pour son propre plan de tempo — aucune nouvelle hypothèse,
// juste la même déjà en place, rendue disponible plus tôt).
// musicSync (Phase 3, juillet 2026, optionnel) : { beatTimes, structure }
// venus de l'analyse audio de la piste qui pilote le montage (resA en mode
// "full", vocalsRes en mode "stems" — cf. routes/mashup.js). Quand fourni ET
// suffisant (≥8 beats détectés), on tente un plan de coupes calé sur la
// musique (videoCutPlanner.js) au lieu du montage à durée fixe historique.
// TOUJOURS avec repli automatique et silencieux : une détection de scène qui
// échoue, prend trop de temps, ou un beatTimes trop court retombe sur
// EXACTEMENT l'ancien comportement (buildAlternatingFilter) — jamais de
// mashup cassé pour un enrichissement qui n'a pas pu aboutir.
export const buildSilentVideoMontage = async (videoA, videoB, totalSec, crossfade, silentOutput, musicSync = null) => {
  const [durA, durB] = await Promise.all([getDuration(videoA), getDuration(videoB)]);
  const segmentSec = videoSegmentDuration(crossfade);
  const xfadeSec = videoXfadeDuration(crossfade);

  let plan = null;
  if (musicSync && Array.isArray(musicSync.beatTimes) && musicSync.beatTimes.length >= 8) {
    try {
      const [scenesA, scenesB] = await Promise.all([
        detectSceneCuts(videoA).catch(() => []),
        detectSceneCuts(videoB).catch(() => []),
      ]);
      const planned = planMusicSyncedCuts({
        totalSec, durA, durB,
        beatTimes: musicSync.beatTimes,
        scenesA, scenesB,
        highlightTimes: musicSync.highlightTimes || [],
        baseSegmentSec: segmentSec, xfadeSec, maxSegments: MAX_SEGMENTS,
      });
      plan = planned.plan;
      console.log(`[ffmpeg] montage calé sur la musique : ${plan.length} segments (${scenesA.length}/${scenesB.length} coupures de plan détectées A/B, segment ${planned.segmentSec.toFixed(2)}s)${planned.highlightSynced ? " — coupes accrochées aux temps forts (drops/énergie)" : ""}`);
    } catch (err) {
      console.warn(`[ffmpeg] planning musical impossible (${err.message}) — repli sur le montage à durée fixe`);
      plan = null;
    }
  }

  console.log(`[ffmpeg] montage ${plan ? "calé musique" : "alterné"} : segments ${plan ? plan[0].duration.toFixed(2) : segmentSec}s, fondus ${xfadeSec.toFixed(2)}s, durée totale ${totalSec.toFixed(1)}s`);

  // Watermark (icon.ico, converti en PNG au 1er appel — cf. ensureWatermarkPng
  // ci-dessus) : 3e input, "-loop 1" pour le tenir en boucle pendant toute la
  // durée du montage (sans quoi ce serait une image d'une seule frame) — PAS
  // de hwInputArgs ici, c'est une image statique décodée en logiciel,
  // indépendamment du chemin choisi pour les 2 vidéos.
  const watermarkPngPath = await ensureWatermarkPng();
  const withWatermark = !!watermarkPngPath;
  const watermarkInput = withWatermark ? `-loop 1 -i "${watermarkPngPath}" ` : "";
  const finalLabel = withWatermark ? "[vout]" : "[v]";
  const buildCmd = (hwDecode, encodeArgs, hwInputArgs) => {
    const filter = plan
      ? buildFilterFromPlan(plan, totalSec, xfadeSec, hwDecode, withWatermark)
      : buildAlternatingFilter(totalSec, durA, durB, segmentSec, xfadeSec, hwDecode, withWatermark);
    return `ffmpeg ${hwInputArgs}-i "${videoA}" ${hwInputArgs}-i "${videoB}" ${watermarkInput}` +
      `-filter_complex ${filter} -map "${finalLabel}" ${encodeArgs} "${silentOutput}" -y`;
  };

  const cmdGpuFull = buildCmd(true, ENCODE_GPU, "-hwaccel cuda -hwaccel_output_format cuda ");
  const cmdGpuEncodeOnly = buildCmd(false, ENCODE_GPU, "");
  const cmdCPU = buildCmd(false, ENCODE_CPU, "");

  let done = false;
  // Tentative "décodage CUDA complet" — sautée d'emblée si un export PRÉCÉDENT
  // (dans ce même process serveur) a déjà démontré qu'elle échoue sur cette
  // machine (cf. _cudaDecodeWorks ci-dessous, résolution de l'audit "tentatives
  // de repli GPU redondantes") : sans ce cache, CHAQUE export retentait le
  // décodage CUDA à l'identique, pour échouer à l'identique à chaque fois — un
  // essai gaspillé (jusqu'à plusieurs dizaines de secondes) avant même
  // d'atteindre le chemin qui, lui, fonctionne réellement sur cette machine.
  if (_cudaDecodeWorks !== false) {
    try {
      await execAsync(cmdGpuFull, { timeout: 900000 });
      _cudaDecodeWorks = true;
      console.log("[ffmpeg] montage vidéo (silencieux) : décodage + encodage GPU (CUDA/NVENC)");
      done = true;
    } catch (e) {
      _cudaDecodeWorks = false; // mémorisé pour tout le reste de cette session serveur
      console.warn("[ffmpeg] décodage CUDA indisponible sur cette machine — ce chemin ne sera plus retenté (repli décodage CPU + encodage NVENC) :", e.message?.split("\n")[0]);
    }
  }

  if (!done && _nvencWorks !== false) {
    try {
      await execAsync(cmdGpuEncodeOnly, { timeout: 900000 });
      _nvencWorks = true;
      console.log("[ffmpeg] montage vidéo (silencieux) : encodage GPU (NVENC), décodage CPU");
      done = true;
    } catch (e) {
      _nvencWorks = false; // mémorisé pour tout le reste de cette session serveur
      console.warn("[ffmpeg] NVENC indisponible sur cette machine — ce chemin ne sera plus retenté (repli complet CPU/libx264) :", e.message?.split("\n")[0]);
    }
  }

  if (!done) {
    await execAsync(cmdCPU, { timeout: 900000 });
    console.log("[ffmpeg] montage vidéo (silencieux) : CPU complet (libx264)");
  }

  return silentOutput;
};

// ── Montage vidéo à N sources (Phase 5, juillet 2026) ───────────────────────
// Généralisation de buildSilentVideoMontage à un nombre arbitraire de vidéos
// sources (3 à 5, cf. routes/mashupMulti.js) au lieu de strictement 2. Fonction
// ADDITIVE et séparée plutôt qu'une modification de buildSilentVideoMontage :
// le chemin 2-sources existant (le plus utilisé de toute l'app) reste
// totalement inchangé, cette fonction ne le remplace pas.
//
// videoPaths : tableau de N chemins vidéo, dans le MÊME ORDRE que les indices
// utilisés côté audio (stemSelection par index — cf. routes/mashupMulti.js).
// musicSync : { beatTimes, structure } optionnel, même sémantique que pour
// buildSilentVideoMontage — repli automatique sur un montage round-robin à
// durée fixe si absent, insuffisant, ou si la détection de scène échoue.
export const buildMultiSourceVideoMontage = async (videoPaths, totalSec, crossfade, silentOutput, musicSync = null) => {
  const n = videoPaths.length;
  if (n < 2) throw new Error(`buildMultiSourceVideoMontage : au moins 2 vidéos requises (reçu ${n})`);

  const durations = await Promise.all(videoPaths.map(getDuration));
  const segmentSec = videoSegmentDuration(crossfade);
  const xfadeSec = videoXfadeDuration(crossfade);

  let plan = null;
  if (musicSync && Array.isArray(musicSync.beatTimes) && musicSync.beatTimes.length >= 8) {
    try {
      const scenesPerSource = await Promise.all(videoPaths.map(p => detectSceneCuts(p).catch(() => [])));
      const planned = planMultiSourceCuts({
        totalSec, durations,
        beatTimes: musicSync.beatTimes,
        scenesPerSource,
        baseSegmentSec: segmentSec, xfadeSec, maxSegments: MAX_SEGMENTS,
      });
      plan = planned.plan;
      console.log(`[ffmpeg] montage multi-sources calé sur la musique : ${plan.length} segments / ${n} sources (${scenesPerSource.map(s => s.length).join("/")} coupures détectées, segment ${planned.segmentSec.toFixed(2)}s)`);
    } catch (err) {
      console.warn(`[ffmpeg] planning musical multi-sources impossible (${err.message}) — repli sur le montage round-robin à durée fixe`);
      plan = null;
    }
  }

  // Repli : round-robin à durée fixe (généralisation à N sources de l'ancien
  // calcul de buildAlternatingFilter — même formule de bouclage modulo par
  // source, juste étendue de 2 à N occurrences en rotation).
  if (!plan) {
    let numSegments = Math.max(n, Math.ceil(totalSec / segmentSec));
    let effectiveSegmentSec = segmentSec;
    if (numSegments > MAX_SEGMENTS) {
      numSegments = Math.max(n, MAX_SEGMENTS);
      effectiveSegmentSec = totalSec / numSegments;
    }
    plan = [];
    const occurrences = new Array(n).fill(0);
    for (let i = 0; i < numSegments; i++) {
      const srcIdx = i % n;
      const srcDur = durations[srcIdx];
      const occ = occurrences[srcIdx]++;
      const span = Math.max(srcDur - effectiveSegmentSec, 1);
      const start = srcDur > 0 ? (occ * effectiveSegmentSec) % span : 0;
      plan.push({ srcIdx, start, duration: effectiveSegmentSec });
    }
    console.log(`[ffmpeg] montage multi-sources round-robin (sans calage musique) : ${plan.length} segments / ${n} sources, ${segmentSec.toFixed(2)}s chacun`);
  }

  const watermarkPngPath = await ensureWatermarkPng();
  const withWatermark = !!watermarkPngPath;
  const watermarkInput = withWatermark ? `-loop 1 -i "${watermarkPngPath}" ` : "";
  const finalLabel = withWatermark ? "[vout]" : "[v]";
  const videoInputs = videoPaths.map(p => `-i "${p}"`).join(" ");
  const buildCmd = (hwDecode, encodeArgs, hwInputArgs) => {
    const filter = buildFilterFromPlan(plan, totalSec, xfadeSec, hwDecode, withWatermark);
    // hwInputArgs répété AVANT CHAQUE entrée vidéo (comme buildSilentVideoMontage
    // pour 2 sources) : chaque flux vidéo doit être décodé en CUDA individuel-
    // lement, ffmpeg n'applique pas -hwaccel globalement à toutes les -i.
    const hwVideoInputs = videoPaths.map(p => `${hwInputArgs}-i "${p}"`).join(" ");
    return `ffmpeg ${hwInputArgs ? hwVideoInputs : videoInputs} ${watermarkInput}` +
      `-filter_complex ${filter} -map "${finalLabel}" ${encodeArgs} "${silentOutput}" -y`;
  };

  const cmdGpuFull = buildCmd(true, ENCODE_GPU, "-hwaccel cuda -hwaccel_output_format cuda ");
  const cmdGpuEncodeOnly = buildCmd(false, ENCODE_GPU, "");
  const cmdCPU = buildCmd(false, ENCODE_CPU, "");

  let done = false;
  if (_cudaDecodeWorks !== false) {
    try {
      await execAsync(cmdGpuFull, { timeout: 900000 });
      _cudaDecodeWorks = true;
      console.log("[ffmpeg] montage vidéo multi-sources : décodage + encodage GPU (CUDA/NVENC)");
      done = true;
    } catch (e) {
      _cudaDecodeWorks = false;
      console.warn("[ffmpeg] décodage CUDA indisponible — repli décodage CPU + encodage NVENC :", e.message?.split("\n")[0]);
    }
  }

  if (!done && _nvencWorks !== false) {
    try {
      await execAsync(cmdGpuEncodeOnly, { timeout: 900000 });
      _nvencWorks = true;
      console.log("[ffmpeg] montage vidéo multi-sources : encodage GPU (NVENC), décodage CPU");
      done = true;
    } catch (e) {
      _nvencWorks = false;
      console.warn("[ffmpeg] NVENC indisponible — repli complet CPU/libx264 :", e.message?.split("\n")[0]);
    }
  }

  if (!done) {
    await execAsync(cmdCPU, { timeout: 900000 });
    console.log("[ffmpeg] montage vidéo multi-sources : CPU complet (libx264)");
  }

  return silentOutput;
};

// crossfade (0-1, même réglage que le Mixer) pilote le rythme du montage —
// cf. videoSegmentDuration/videoXfadeDuration ci-dessus.
//
// silentOutput : chemin où persister le montage vidéo SANS le son (dans
// data/outputs, donc pas nettoyé avec le reste du tmp/ du job) — permet de
// recombiner plus tard ce même montage avec une autre piste audio (mashup
// personnalisé voix/instru croisés) sans refaire l'étape d'encodage vidéo,
// la plus coûteuse du pipeline. Le mux final (vidéo + mix choisi) est lui
// une simple copie de flux, quasi instantanée.
//
// Enveloppe fine autour de buildSilentVideoMontage + muxVideoAudio, pour les
// appelants qui n'ont pas de raison de paralléliser (montage vidéo lancé
// APRÈS le mixage audio, comme avant) — cf. routes/mashup.js pour le chemin
// parallélisé (modes "full"/"stems", qui précalculent totalSec par avance et
// appellent buildSilentVideoMontage directement en même temps que
// mixFullRave, plutôt que via cette enveloppe).
export const exportMP4_916 = async (videoA, videoB, audioMix, output, crossfade = 0.5, silentOutput) => {
  const totalSec = await getDuration(audioMix);
  await buildSilentVideoMontage(videoA, videoB, totalSec, crossfade, silentOutput);
  await muxVideoAudio(silentOutput, audioMix, output);
  console.log("[ffmpeg] export MP4 : mux vidéo silencieuse + mix audio terminé");
  return output;
};
