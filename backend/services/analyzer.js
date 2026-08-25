import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { PersistentWorker, registerWorker } from "./workerPool.js";
import { createPythonResolver, validateVersion } from "./pythonResolver.js";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Détection de la commande Python à utiliser ───────────────────────────
// Constaté en pratique (Windows) : "python" n'est pas forcément trouvable
// sur le PATH du process qui lance le serveur (`npm run dev` dans une
// fenêtre PowerShell dédiée), même quand un AUTRE terminal, lui, le trouve
// très bien — le PATH effectif dépend de la fenêtre/l'ordre d'installation,
// pas d'une propriété globale de la machine. Symptôme observé : l'exec de
// "python script.py" échoue avec un "Command failed" totalement vide (pas
// le moindre message), ce qui correspondait à "where python" ne trouvant
// rien du tout dans cette fenêtre précise.
// Mécanisme générique factorisé dans services/pythonResolver.js (audit perf
// juillet 2026 — même logique que demucs.js::resolveDemucsPython, dupliquée
// avant cette factorisation) : on teste plusieurs commandes candidates une
// seule fois (résultat mis en cache), la première qui répond à "--version"
// est retenue — suffisant ici puisque le problème est la PRÉSENCE d'un
// interpréteur valide sur le PATH, pas un paquet manquant dans celui-ci (cf.
// demucs.js, qui utilise validateImport pour cette raison précise).
// "py -3.12" en tête : constaté en pratique que "python"/"py -3" pointent
// vers Python 3.14 sur cette machine, une version trop récente pour numba
// (dépendance de librosa.beat.beat_track) — combo numba 0.65.1 / Python
// 3.14.6 qui plante en crash natif (0xC0000005) ou erreur interne
// ('get_call_template'). Python 3.12 a un écosystème numba/librosa mature
// et stable. Si "py -3.12" n'est pas installé, on retombe sur les anciens
// candidats (qui utiliseront alors 3.14 avec le repli NUMBA_DISABLE_JIT).
const resolvePythonCmd = createPythonResolver({
  candidates: ["py -3.12", "py -3.11", "python", "py -3", "python3"],
  validate: validateVersion(5000),
  label: "[analyzer]",
});
// ── Worker Python persistant pour l'analyse BPM/clé (audit perf juillet 2026)
// ────────────────────────────────────────────────────────────────────────────
// Miroir de getDemucsWorker/tryWorkerSeparate dans services/demucs.js : au
// lieu d'écrire un script temporaire ET de relancer un process Python neuf à
// CHAQUE analyse (import librosa/numpy + compilation JIT numba à froid à
// chaque fois — 1 à 3s payés en pure perte à chaque appel), un unique
// process persistant garde librosa déjà chargé/chaud en mémoire (cf.
// backend/pyworkers/analyzer_worker.py). RÉACTIVÉ PAR DÉFAUT (opt-out via
// ANALYZER_WORKER=0 dans backend/.env si besoin) — tryWorkerAnalyze ne lève
// JAMAIS : en cas d'indisponibilité (dépendance manquante, worker qui
// plante), on retombe automatiquement sur l'ancien mode "un process par
// appel" ci-dessous, déjà éprouvé.
const WORKER_ENABLED = process.env.ANALYZER_WORKER !== "0";
let _analyzerWorker = null;
const getAnalyzerWorker = async () => {
  if (_analyzerWorker) return _analyzerWorker;
  const pythonCmd = await resolvePythonCmd();
  const [bin, ...extraArgs] = pythonCmd.split(" ");
  const scriptPath = join(__dirname, "..", "pyworkers", "analyzer_worker.py");
  // Même garde-fou numba que la commande "exec" ci-dessous (usingProblematicPython) —
  // décidé UNE FOIS ici, au démarrage du worker, puisque le process persistant
  // ne relance jamais l'interpréteur ensuite.
  const usingProblematicPython = !/py -3\.1[12]/.test(pythonCmd);
  _analyzerWorker = registerWorker(new PersistentWorker(bin, [...extraArgs, scriptPath], {
    name: "analyzer",
    readyTimeoutMs: 60000,
    env: usingProblematicPython ? { NUMBA_DISABLE_JIT: "1" } : undefined,
  }));
  return _analyzerWorker;
};

// Tente l'analyse via le worker persistant. Renvoie null (jamais ne lève) si
// le worker est indisponible ou échoue — l'appelant retombe alors sur
// l'ancien mode "process par appel" (exec du script temporaire), sans que
// le job échoue pour autant.
const tryWorkerAnalyze = async (wavPath) => {
  if (!WORKER_ENABLED) return null;
  // Chrono explicite (même principe que tryWorkerSeparate dans demucs.js) —
  // le tout 1er appel après démarrage inclut encore l'import librosa/numpy
  // (normal), les suivants dans le même process montrent le vrai gain du
  // worker persistant par rapport à l'ancien "un process par appel".
  const t0 = Date.now();
  try {
    const result = await (await getAnalyzerWorker()).call({ wavPath }, 300000);
    console.log(`[analyzer] ⏱ analyse via worker persistant (librosa déjà chaud) — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
  } catch (e) {
    console.warn(`[analyzer] worker persistant indisponible, repli sur le mode process-par-appel : ${e.message}`);
    return null;
  }
};

// Le script temporaire doit vivre HORS des dossiers surveillés par
// "node --watch-path=services" (cf. package.json) — l'écrire dans services/
// lui-même (comme avant) déclenchait un redémarrage du serveur à CHAQUE
// analyse, en plein milieu du job (le job en mémoire disparaissait alors,
// d'où l'erreur "Job introuvable" côté frontend).
const TMP_SCRIPT_DIR = join(__dirname, "../tmp");
mkdirSync(TMP_SCRIPT_DIR, { recursive: true });

// ── Analyse musicale complète (Librosa) ──────────────────────────────────
// Étend l'analyse BPM/clé d'origine pour fournir tout ce dont le moteur de
// scoring (services/scoring.js) a besoin :
//   - bpm
//   - clé + MODE (majeur/mineur) + notation Camelot (pour la distance sur la
//     roue de Camelot utilisée dans le scoring harmonique)
//   - énergie (RMS moyen + écart-type = dynamique du morceau)
//   - empreinte spectrale (MFCC moyen + centroïde) pour la similarité
//     spectrale entre 2 morceaux
//   - structure approximative : segmentation en sections par changement de
//     timbre/harmonie (librosa.segment.agglomerative), chaque section
//     étiquetée par son niveau d'énergie relatif ("low"/"mid"/"high").
//     NOTE : une vraie détection sémantique intro/couplet/refrain demande un
//     modèle entraîné dédié (hors scope ici) — cette segmentation par
//     énergie/timbre reste un bon proxy pour aligner un plan de mix.
const PYTHON_SCRIPT = `
import sys, json, warnings
warnings.filterwarnings('ignore')

try:
    import librosa
    import numpy as np
    import scipy.signal  # dépendance déjà requise par librosa — jamais d'import séparé à gérer

    path = sys.argv[1]
    # sr=22050 (au lieu de sr=None qui gardait la fréquence native, souvent
    # 44.1 ou 48 kHz) : c'est la fréquence standard pour l'analyse MIR
    # (Music Information Retrieval) — son nyquist (11025 Hz) capture
    # largement l'essentiel du contenu tonal/rythmique utile au BPM, à la clé
    # et à la structure. Ça réduit de moitié le volume de données traité par
    # CQT/MFCC/beat_track (les étapes les plus coûteuses ici), pour un temps
    # d'analyse nettement plus court, sans perte perceptible de précision.
    y, sr = librosa.load(path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # ── BPM + positions de beats (pour l'alignement de mesure downstream) ──
    # ── PARADE "Réessayer l'analyse" (juillet 2026) ────────────────────────
    # librosa.beat.beat_track() est la fonction identifiée comme cause du
    # crash natif 0xC0000005 (cf. commentaire détaillé de resolvePythonCmd
    # plus haut) : son backtracking DP interne passe par du code numba-jitté
    # qui peut planter tout le process Python — un crash NATIF ne peut PAS
    # être rattrapé par un try/except Python (contrairement à une exception
    # normale), donc avant ce correctif, cliquer "↺ Réessayer l'analyse" côté
    # Deck.jsx relançait littéralement le MÊME appel et retombait sur le
    # MÊME crash à coup sûr pour un morceau qui le déclenche — un clic sans
    # le moindre effet réel, juste une parade cosmétique.
    # 2 filets complémentaires ajoutés ici :
    #  1) try/except AUTOUR de beat_track (attrape les erreurs numba encore
    #     catchables, cf. commentaire de resolvePythonCmd : "peut produire
    #     une autre erreur numba interne selon les cas") — repli immédiat,
    #     dans le MÊME process, vers safe_tempo_and_beats() ci-dessous.
    #  2) SAFE_MODE (argv[2] === "safe") : pour le cas où beat_track crashe
    #     le process AVANT même qu'un except Python n'ait pu s'exécuter —
    #     analyzeAudio() (plus bas dans ce fichier) relance alors un 2e
    #     process Python COMPLET avec ce flag, qui évite d'appeler
    #     beat_track() dès le départ.
    # safe_tempo_and_beats() n'utilise que des fonctions déjà validées comme
    # stables dans CE MÊME diagnostic (onset_strength/onset_detect servent
    # déjà sans souci pour le kick/snare plus bas) — tempo() partage
    # l'essentiel de son calcul avec beat_track() (enveloppe d'onset +
    # autocorrélation) mais SANS le backtracking DP qui plante. La grille de
    # beats devient une approximation à pas régulier (60/bpm) ancrée sur le
    # premier onset détecté plutôt qu'une vraie grille DP — suffisant pour
    # caler un point de départ de mesure (snapToMeasureBoundary), moins
    # précis pour la correction de dérive tempo fine (computeLocalBpm), mais
    # très largement préférable à une analyse qui échoue purement et
    # simplement pour ce morceau.
    def safe_tempo_and_beats():
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo_arr = librosa.beat.tempo(onset_envelope=onset_env, sr=sr)
        bpm_val = float(np.atleast_1d(tempo_arr)[0])
        onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
        onset_times = librosa.frames_to_time(onset_frames, sr=sr)
        start = float(onset_times[0]) if len(onset_times) else 0.0
        step = 60.0 / bpm_val if bpm_val > 0 else 0.5
        beats, t = [], start
        while t < duration and len(beats) < 4000:
            beats.append(round(t, 3))
            t += step
        return bpm_val, beats

    SAFE_MODE = len(sys.argv) > 2 and sys.argv[2] == 'safe'
    if SAFE_MODE:
        bpm, beat_times = safe_tempo_and_beats()
    else:
        try:
            tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
            bpm = float(np.atleast_1d(tempo)[0])
            # Grille de beats COMPLÈTE (toute la piste), pas seulement les 12
            # premières secondes comme avant : beat_track() calcule déjà cette
            # grille en entier pour trouver le tempo moyen, donc la garder
            # intégralement ne coûte rien de plus. Elle sert à 2 choses :
            #  1. caler le point de départ du mashup sur un VRAI beat détecté
            #     plutôt que d'extrapoler arithmétiquement depuis le premier
            #     (routes/mashup.js, snapToMeasureBoundary) ;
            #  2. calculer un tempo LOCAL par tronçon du morceau (intervalle
            #     inter-beats médian autour d'un instant donné) au lieu d'un
            #     seul BPM moyen appliqué tel quel sur toute la durée — ce qui
            #     permet de corriger la dérive rythmique progressive entre
            #     voix et instru ("décrochage") au lieu de l'ignorer (cf.
            #     computeLocalBpm/buildTempoSchedule dans services/ffmpeg.js).
            # Plafonné à 4000 points par sécurité (piste anormalement longue)
            # — un morceau de 4-5 min à 90-180 BPM en compte typiquement
            # 150 à 750.
            beat_times_all = librosa.frames_to_time(beat_frames, sr=sr)
            beat_times = [round(float(t), 3) for t in beat_times_all][:4000]
        except Exception:
            bpm, beat_times = safe_tempo_and_beats()

    # ── Clé + mode (algorithme de Krumhansl-Schmuckler) ──
    # Profils de référence (Krumhansl & Kessler, 1990) — corrélation entre le
    # chroma moyen du morceau et chaque rotation des 2 profils (majeur/mineur)
    # pour les 12 hauteurs : le meilleur score donne la clé + le mode.
    PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    # Détection de clé sur le "corps" du morceau uniquement (20% → 90% de la
    # durée) : évite les intros/outros qui peuvent avoir un contenu harmonique
    # différent (ex. intro instrumentale hip-hop avant l'entrée du chanteur qui
    # amène la vraie tonalité, ou fade-out en fin de piste).
    # chroma_cens (Chroma Energy Normalized Statistics) — plus robuste que
    # chroma_cqt face aux percussions et bruit non-harmonique : applique des
    # normalisations successives + lissage gaussien qui atténuent l'impact des
    # kicks/snares sur le vecteur chroma. Recommandé en MIR pour les genres
    # électro/hip-hop/pop avec batterie marquée ou basse forte (vs chroma_cqt
    # qui reste sensible au timbre des éléments non tonaux).
    skip_s = int(len(y) * 0.20)
    skip_e = max(int(len(y) * 0.10), int(sr * 5))
    y_body = y[skip_s : -skip_e] if len(y) > skip_s + skip_e + sr * 10 else y
    chroma_key = librosa.feature.chroma_cens(y=y_body, sr=sr, hop_length=4096)
    chroma_mean = chroma_key.mean(axis=1)

    # chroma_cqt sur l'ensemble du morceau — uniquement pour la segmentation
    # structurelle ci-dessous (clustering agglomératif sur features chroma+mfcc).
    chroma_full = librosa.feature.chroma_cqt(y=y, sr=sr)

    # chroma_vec en paramètre (au lieu de fermer sur chroma_mean) : réutilisé
    # plus bas pour la clé PAR SEGMENT (mashability cross-morceaux), pas
    # seulement pour la clé globale du morceau entier.
    def best_correlation(chroma_vec, profile):
        best_idx, best_corr = 0, -2.0
        for shift in range(12):
            rotated = np.roll(profile, shift)
            corr = np.corrcoef(chroma_vec, rotated)[0, 1]
            if corr > best_corr:
                best_corr, best_idx = corr, shift
        return best_idx, best_corr

    major_idx, major_corr = best_correlation(chroma_mean, MAJOR_PROFILE)
    minor_idx, minor_corr = best_correlation(chroma_mean, MINOR_PROFILE)

    if major_corr >= minor_corr:
        key_pitch, key_mode = PITCHES[major_idx], 'major'
    else:
        key_pitch, key_mode = PITCHES[minor_idx], 'minor'

    # ── Confiance de la détection de clé ──
    # La corrélation du profil gagnant (Krumhansl-Schmuckler) mesure à quel
    # point le chroma du morceau "ressemble" à une tonalité nette. Sur un
    # morceau très percussif/atonal (peu de contenu harmonique net), cette
    # corrélation reste basse (souvent < 0.3-0.4) même pour la "meilleure"
    # rotation trouvée — la clé/Camelot renvoyée est alors peu fiable et ne
    # devrait pas servir à bloquer/forcer un pitch-shift avec la même
    # confiance qu'une détection nette (>0.6). scoring.js et ffmpeg.js
    # utilisent ce champ pour moduler leur confiance dans le calage
    # harmonique plutôt que de le traiter comme toujours vrai.
    key_confidence = round(float(max(major_corr, minor_corr)), 3)

    # ── Notation Camelot (roue standard utilisée en DJing) ──
    CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B']
    CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A']
    pitch_idx = PITCHES.index(key_pitch)
    camelot = CAMELOT_MAJOR[pitch_idx] if key_mode == 'major' else CAMELOT_MINOR[pitch_idx]

    # ── Énergie (RMS) ──
    rms = librosa.feature.rms(y=y)[0]
    energy_rms = float(rms.mean())
    energy_std = float(rms.std())
    # hop_length par défaut de librosa.feature.rms (512) — sorti du bloc
    # structure ci-dessous (audit perf juillet 2026, Phase 2) car réutilisé
    # aussi par detect_drops, qui doit rester exploitable même si la
    # segmentation structurelle échoue (try/except plus bas).
    hop_length = 512
    rms_frame_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)

    # ── Empreinte spectrale (MFCC + centroïde) ──
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    mfcc_mean = mfcc.mean(axis=1).tolist()
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    spectral_centroid = float(centroid.mean())

    # ── Onset detection par bande de fréquence (kick / snare-hihat) ─────────
    # Approxime la détection d'attaques PAR FAMILLE d'instrument percussif
    # sans modèle de transcription batterie dédié (hors de portée sans
    # dépendance lourde supplémentaire) : on filtre le signal dans une bande
    # de fréquence typique de chaque famille AVANT de calculer l'enveloppe
    # d'onset — un kick concentre son énergie sous ~150 Hz, une snare/hi-hat
    # surtout au-dessus. Bandes volontairement larges : l'objectif est un
    # signal de rythme exploitable (mashup "à la carte", futur module vidéo
    # pour caler des coupes sur les percussions), pas une transcription
    # précise instrument par instrument.
    # Filtre Butterworth passe-bande (scipy, déjà une dépendance de librosa,
    # cf. import en tête de script) — ordre 4, compromis raideur/stabilité
    # numérique standard, largement suffisant ici (seule la présence d'une
    # attaque dans la bande compte, pas une séparation audio propre).
    def band_onset_times(y_full, low_hz, high_hz, max_points=2000):
        sos = scipy.signal.butter(4, [low_hz, high_hz], btype='band', fs=sr, output='sos')
        y_band = scipy.signal.sosfilt(sos, y_full)
        onset_env = librosa.onset.onset_strength(y=y_band, sr=sr)
        onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
        times = librosa.frames_to_time(onset_frames, sr=sr)
        return [round(float(t), 3) for t in times][:max_points]

    try:
        # Kick ≈ 20-150 Hz (fondamentale de grosse caisse électro/pop).
        kick_times = band_onset_times(y, 20, 150)
        # Snare/hi-hat ≈ 150 Hz-6 kHz (corps de caisse claire + cymbales) —
        # une seule bande large plutôt que 2 bandes séparées : au-delà de
        # 150 Hz, les deux se chevauchent trop pour une distinction fiable
        # par simple filtrage (contrairement au kick, bien isolé en dessous).
        snare_times = band_onset_times(y, 150, 6000)
    except Exception:
        # Ne doit jamais faire échouer le reste de l'analyse — cf. même
        # philosophie que le bloc structure ci-dessous (morceaux très
        # courts/atypiques, filtre instable sur un cas limite...).
        kick_times, snare_times = [], []

    # ── Détection de "drop" (montée d'énergie brutale après un creux) ───────
    # Heuristique simple, sans modèle dédié : on lisse le RMS déjà calculé
    # (~0.5s, pour ignorer le jitter frame-à-frame) puis on repère les points
    # où sa DÉRIVÉE (vitesse de montée) dépasse nettement la moyenne — un vrai
    # drop est une TRANSITION RAPIDE, pas un simple passage progressif en
    # zone forte. On exige en plus que le niveau ATTEINT après la montée soit
    # dans la zone "haute" du morceau (>= 1.15x l'énergie moyenne — seuil
    # légèrement plus permissif que le label 'high' de la segmentation
    # structurelle ci-dessous, à 1.3x, car un drop peut être détecté sur son
    # tout début, avant que le niveau plafonne) pour écarter les simples
    # remontées locales sans réel impact. min_gap_sec fusionne les
    # détections trop rapprochées (même transitoire vu sur plusieurs frames
    # consécutives).
    def detect_drops(min_gap_sec=8.0):
        if len(rms) < 10:
            return []
        win = max(1, int(0.5 * sr / hop_length))
        kernel = np.ones(win) / win
        smooth = np.convolve(rms, kernel, mode='same')
        deriv = np.diff(smooth, prepend=smooth[0])
        if deriv.std() == 0:
            return []
        threshold = deriv.mean() + 1.8 * deriv.std()
        drops = []
        last_time = -min_gap_sec
        for idx in np.where(deriv > threshold)[0]:
            if smooth[idx] < energy_rms * 1.15:
                continue
            t = float(rms_frame_times[idx])
            if t - last_time < min_gap_sec:
                continue
            drops.append(round(t, 2))
            last_time = t
        return drops

    try:
        drops = detect_drops()
    except Exception:
        drops = []

    # ── Structure approximative (segmentation par timbre/harmonie) ──
    # Combine chroma + MFCC frame par frame, segmente en sections via
    # clustering agglomératif (librosa.segment), puis étiquette chaque
    # section par son énergie relative au morceau entier.
    try:
        n_segments = min(8, max(3, int(duration // 20)))  # ~1 section / 20s, borné [3,8]
        features = np.vstack([chroma_full, mfcc])
        bounds = librosa.segment.agglomerative(features, n_segments)
        bound_times = librosa.frames_to_time(bounds, sr=sr).tolist()
        bound_times = [0.0] + [t for t in bound_times if 0 < t < duration] + [duration]
        bound_times = sorted(set(round(t, 2) for t in bound_times))

        overall_energy = energy_rms

        structure = []
        for i in range(len(bound_times) - 1):
            start, end = bound_times[i], bound_times[i + 1]
            mask = (rms_frame_times >= start) & (rms_frame_times < end)
            seg_energy = float(rms[mask].mean()) if mask.any() else overall_energy
            if seg_energy < overall_energy * 0.7:
                label = 'low'
            elif seg_energy > overall_energy * 1.3:
                label = 'high'
            else:
                label = 'mid'

            # ── Clé PAR SEGMENT ──
            # Même algorithme Krumhansl-Schmuckler que la clé globale ci-dessus,
            # mais appliqué au seul intervalle [start, end) de CE segment plutôt
            # qu'au "corps" du morceau entier — nécessaire pour comparer la
            # compatibilité harmonique entre une section précise du morceau A et
            # une section précise du morceau B (matrice de "mashability" façon
            # AutoMashUpper, cf. routes/mashup.js), plutôt qu'une seule clé
            # globale qui peut ne pas refléter une section particulière (ex:
            # refrain en majeur après un couplet en mineur relatif).
            # Réutilise chroma_full (déjà calculé pour le clustering structurel
            # ci-dessus, même référentiel temporel hop_length=512 par défaut que
            # bound_times) — pas de nouveau calcul chroma coûteux.
            f_start = librosa.time_to_frames(start, sr=sr)
            f_end = max(f_start + 1, librosa.time_to_frames(end, sr=sr))
            seg_chroma = chroma_full[:, f_start:f_end]
            if seg_chroma.shape[1] >= 4:
                seg_chroma_mean = seg_chroma.mean(axis=1)
                seg_major_idx, seg_major_corr = best_correlation(seg_chroma_mean, MAJOR_PROFILE)
                seg_minor_idx, seg_minor_corr = best_correlation(seg_chroma_mean, MINOR_PROFILE)
                if seg_major_corr >= seg_minor_corr:
                    seg_key_pitch, seg_key_mode = PITCHES[seg_major_idx], 'major'
                else:
                    seg_key_pitch, seg_key_mode = PITCHES[seg_minor_idx], 'minor'
                seg_key_confidence = round(float(max(seg_major_corr, seg_minor_corr)), 3)
                seg_pitch_idx = PITCHES.index(seg_key_pitch)
                seg_camelot = CAMELOT_MAJOR[seg_pitch_idx] if seg_key_mode == 'major' else CAMELOT_MINOR[seg_pitch_idx]
            else:
                # Segment trop court (< 4 frames, ~0.09s) pour une estimation
                # fiable — pas de clé exploitable, confiance à 0 (cf. scoring.js
                # / routes/mashup.js : ignoré par la matrice de mashability).
                seg_key_pitch, seg_key_mode, seg_camelot, seg_key_confidence = None, None, None, 0.0

            structure.append({
                'start': round(start, 2), 'end': round(end, 2),
                'energy': round(seg_energy, 4), 'label': label,
                'key_pitch': seg_key_pitch, 'key_mode': seg_key_mode,
                'camelot': seg_camelot, 'key_confidence': seg_key_confidence,
            })
    except Exception:
        # La segmentation peut échouer sur des morceaux très courts/atypiques
        # — ce n'est pas bloquant, le reste de l'analyse reste valide.
        structure = []

    print(json.dumps({
        'bpm': round(bpm, 1),
        'duration': round(duration, 2),
        'key': key_pitch,           # rétro-compatibilité avec l'ancien champ
        'key_pitch': key_pitch,
        'key_mode': key_mode,
        'key_confidence': key_confidence,
        'camelot': camelot,
        'energy_rms': round(energy_rms, 4),
        'energy_std': round(energy_std, 4),
        'spectral_centroid': round(spectral_centroid, 1),
        'mfcc_mean': mfcc_mean,
        'structure': structure,
        'beat_times': beat_times,
        'kick_times': kick_times,
        'snare_times': snare_times,
        'drops': drops,
    }))
except Exception as e:
    import traceback
    print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), file=sys.stderr)
    sys.exit(1)
`;

// Une seule tentative d'exécution du script Python (extrait de l'ancien
// analyzeAudio, juillet 2026, pour pouvoir être appelé 2 FOIS de suite —
// cf. analyzeAudio ci-dessous). "safeMode" (3e argv du script, "safe") passe
// directement par safe_tempo_and_beats() dans PYTHON_SCRIPT, en évitant
// complètement d'appeler librosa.beat.beat_track() — utile quand la 1ère
// tentative a planté AVANT que son propre try/except interne (aussi ajouté
// dans PYTHON_SCRIPT) n'ait pu s'exécuter (crash natif 0xC0000005, jamais
// rattrapable côté Python). Lève en cas d'échec (charge à l'appelant de
// décider s'il retente ou abandonne) — ne renvoie JAMAIS le "faux repli"
// bpm=120/camelot=8B d'avant (cf. commentaire détaillé plus bas).
const runAnalyzeAttempt = async (wavPath, { safeMode = false } = {}) => {
  const scriptPath = join(TMP_SCRIPT_DIR, `_analyze_${Date.now()}_${safeMode ? "safe" : "std"}.py`);
  writeFileSync(scriptPath, PYTHON_SCRIPT);
  const pythonCmd = await resolvePythonCmd();
  const t0 = Date.now();
  try {
    // NUMBA_DISABLE_JIT=1 : filet de sécurité UNIQUEMENT pour Python 3.14
    // (candidats "python"/"py -3"/"python3" ci-dessus) — root cause identifiée :
    // numba 0.65.1 est instable sur Python 3.14.6 (trop récent, support numba
    // encore immature), ce qui plante librosa.beat.beat_track en crash natif
    // 0xC0000005 (isolé précisément via un script de diagnostic pas-à-pas :
    // chaque étape avant beat_track passait, aucune après ne s'affichait).
    // Désactiver le JIT numba évite le crash natif mais reste fragile (peut
    // produire une autre erreur numba interne selon les cas) et ralentit
    // beaucoup l'analyse (boucle DP en pur Python). Avec "py -3.12"/"py -3.11"
    // (candidats prioritaires, écosystème numba/librosa mature et stable), le
    // JIT reste actif : rapide ET fiable, donc pas besoin de ce contournement.
    // Timeout relevé à 5 min (au lieu de 2) pour couvrir le cas JIT désactivé.
    const usingProblematicPython = !/py -3\.1[12]/.test(pythonCmd);
    const safeArg = safeMode ? ` "safe"` : "";
    const { stdout, stderr } = await execAsync(`${pythonCmd} "${scriptPath}" "${wavPath}"${safeArg}`, {
      timeout: 300000,
      maxBuffer: 1024 * 1024 * 10,
      env: usingProblematicPython ? { ...process.env, NUMBA_DISABLE_JIT: "1" } : process.env,
    });
    try { unlinkSync(scriptPath); } catch {}
    if (stderr) console.warn("Analyzer stderr:", stderr);
    console.log(`[analyzer] ⏱ analyse process-par-appel${safeMode ? " (SAFE MODE, sans beat_track)" : ""} (import librosa à froid) — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return JSON.parse(stdout.trim());
  } catch (err) {
    try { unlinkSync(scriptPath); } catch {}
    // Le script Python journalise ses propres exceptions en JSON sur stderr
    // ({'error': ..., 'trace': ...}) — on essaie de l'extraire pour un
    // message clair ; sinon on retombe sur l'erreur brute de Node (ex:
    // "python" introuvable, timeout d'exécution, etc).
    let cleanMessage = err.stderr || err.message || "Erreur d'analyse inconnue";
    try {
      const parsed = JSON.parse((err.stderr || "").trim());
      if (parsed?.error) cleanMessage = parsed.error;
    } catch { /* stderr n'était pas du JSON — message brut conservé */ }
    // Diagnostic supplémentaire quand stderr est VIDE (aucune trace Python) :
    // c'est la signature d'un process qui a échoué avant même d'exécuter la
    // moindre ligne du script — cas constaté en pratique : "python" absent du
    // PATH de LA FENÊTRE qui lance "npm run dev" spécifiquement, même quand
    // un autre terminal le trouve très bien ("where python" vide dans cette
    // fenêtre précise). resolvePythonCmd() ci-dessus tente déjà "py -3" et
    // "python3" en repli automatique — si ce message apparaît malgré tout,
    // aucune des 3 commandes n'a fonctionné. C'est AUSSI la signature d'un
    // crash natif (0xC0000005) en cours de script : le process meurt sans
    // qu'aucune ligne de PYTHON_SCRIPT n'ait pu écrire sur stderr.
    if (!err.stderr) {
      cleanMessage = `${cleanMessage} [commande="${pythonCmd}", code=${err.code ?? "?"}, stdout="${(err.stdout || "").toString().slice(0, 200)}"]`;
    }
    const e = new Error(cleanMessage);
    e.stderrEmpty = !err.stderr;
    throw e;
  }
};

// ── PARADE "Réessayer l'analyse" (juillet 2026) ──────────────────────────
// Avant ce correctif, un morceau qui déclenchait le crash natif 0xC0000005
// (cf. runAnalyzeAttempt/PYTHON_SCRIPT ci-dessus) échouait à CHAQUE tentative
// de façon identique — cliquer "↺ Réessayer l'analyse" côté Deck.jsx
// relançait littéralement le même appel, qui replantait à coup sûr : un clic
// sans le moindre effet réel pour ce morceau précis. La cause était un crash
// NATIF (pas une exception Python normale), donc rien de catchable ne
// permettait à l'ancien code de s'en apercevoir et de changer de stratégie.
// Ce correctif fait maintenant, ICI, ce que l'utilisateur devait faire à la
// main en boucle : si la 1ère tentative échoue, une 2e tentative automatique
// est lancée en SAFE MODE (sans jamais appeler beat_track) AVANT de déclarer
// l'analyse en échec — le clic "Réessayer" (ou même le tout premier essai)
// aboutit donc directement à un résultat exploitable pour les morceaux qui
// déclenchaient ce crash, sans action manuelle supplémentaire.
export const analyzeAudio = async (wavPath) => {
  const viaWorker = await tryWorkerAnalyze(wavPath);
  if (viaWorker) return { ...viaWorker, analysisFailed: false };

  try {
    const result = await runAnalyzeAttempt(wavPath, { safeMode: false });
    return { ...result, analysisFailed: false };
  } catch (firstErr) {
    console.warn(`[analyzer] 1ère tentative échouée (${firstErr.message.slice(0, 200)}) — nouvel essai automatique en SAFE MODE (sans beat_track)…`);
    try {
      const result = await runAnalyzeAttempt(wavPath, { safeMode: true });
      console.log("[analyzer] ✅ SAFE MODE a réussi — BPM/beats moins précis qu'un vrai beat-tracking DP, mais analyse exploitable.");
      return { ...result, analysisFailed: false };
    } catch (secondErr) {
      console.error("Analyze error complet (2 tentatives, standard + SAFE MODE) :", secondErr.message);
      // IMPORTANT — constaté en pratique : l'ancien repli renvoyait des
      // valeurs PLAUSIBLES (bpm:120, camelot:"8B") qui ressemblaient à un
      // vrai résultat Librosa. Conséquence : la quasi-totalité des morceaux
      // en base (SQLite) avaient exactement bpm=120/key_pitch=C/camelot="8B"
      // — pas un vrai résultat d'analyse, mais CE repli silencieux, mis en
      // cache comme si l'analyse avait réussi, pour CHAQUE morceau. Résultat :
      // aucune correction de tempo/tonalité n'a jamais été réellement
      // pertinente (deux morceaux "120 BPM / 8B" semblent toujours
      // parfaitement compatibles, y compris quand leurs vrais tempos
      // diffèrent) — cause probable n°1 du décalage vocal/instru ressenti
      // par l'utilisateur. Un échec est signalé explicitement (analysisFailed
      // / bpm null etc.) pour que l'appelant (routes/analyze.js,
      // routes/mashup.js) fasse ÉCHOUER le job au lieu de mettre en cache un
      // résultat inventé — les 2 tentatives (standard + SAFE MODE) ont donc
      // véritablement échoué toutes les deux si ce message apparaît.
      return {
        bpm: null, duration: 0,
        key: null, key_pitch: null, key_mode: null, key_confidence: 0, camelot: null,
        energy_rms: 0, energy_std: 0, spectral_centroid: 0,
        mfcc_mean: [], structure: [], beat_times: [],
        kick_times: [], snare_times: [], drops: [],
        analysisFailed: true,
        analysisError: secondErr.message,
      };
    }
  }
};
