import sys, json, warnings, traceback
warnings.filterwarnings('ignore')

# ── Worker Python persistant pour l'analyse BPM/clé (audit perf juillet 2026)
# ────────────────────────────────────────────────────────────────────────────
# Miroir de services/workers/demucs_worker.py, mais pour librosa au lieu de
# Demucs : jusqu'ici, services/analyzer.js écrivait un script .py temporaire
# ET relançait un process Python NEUF à CHAQUE analyse (exec), qui payait à
# chaque fois l'import de librosa/numpy (souvent 1-3s à lui seul) ET la
# recompilation JIT (numba) de librosa.beat.beat_track à froid — numba met en
# cache les fonctions compilées PAR PROCESS, donc ce coût ne s'amortit
# jamais d'un appel à l'autre avec l'ancienne approche. Un worker persistant
# ne paie tout ça qu'UNE FOIS au démarrage, puis traite tous les jobs
# suivants avec librosa déjà chaud (imports faits, JIT numba déjà compilé).
#
# Protocole IDENTIQUE à demucs_worker.py : une ligne JSON par job sur stdin
# ({"id":N,"wavPath":"..."}), une ligne JSON par réponse sur stdout
# ({"id":N,"ok":true,"result":{...}} ou {"id":N,"ok":false,"error":"..."}).
# {"type":"ready"} signale la fin des imports. Une exception AU DÉMARRAGE
# (librosa absent, etc.) est fatale ({"type":"fatal"}) — c'est alors à
# analyzer.js de retomber sur l'ancien mode "un process par appel", jamais
# l'inverse. Une exception PENDANT un job ne casse que CE job.

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

try:
    import librosa
    import numpy as np
    import scipy.signal  # dépendance déjà requise par librosa — jamais d'import séparé à gérer
except Exception as e:
    emit({"type": "fatal", "error": f"import impossible ({e.__class__.__name__}: {e}) — librosa/numpy absents de cet environnement Python"})
    sys.exit(1)

# ── Constantes de l'algorithme (identiques à l'ancien PYTHON_SCRIPT inline
# dans analyzer.js — aucun changement de logique ici, seulement de portage
# vers un process persistant). ──────────────────────────────────────────────
PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B']
CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A']


def best_correlation(chroma_vec, profile):
    best_idx, best_corr = 0, -2.0
    for shift in range(12):
        rotated = np.roll(profile, shift)
        corr = np.corrcoef(chroma_vec, rotated)[0, 1]
        if corr > best_corr:
            best_corr, best_idx = corr, shift
    return best_idx, best_corr


def analyze_track(path):
    # sr=22050 : fréquence standard MIR, réduit de moitié le volume de
    # données pour CQT/MFCC/beat_track sans perte perceptible utile.
    y, sr = librosa.load(path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # ── BPM + grille de beats complète ──
    # PARADE "Réessayer l'analyse" (juillet 2026, cf. même correctif détaillé
    # dans services/analyzer.js::PYTHON_SCRIPT) : librosa.beat.beat_track()
    # est la fonction identifiée comme cause du crash natif 0xC0000005 (numba
    # instable sur Python 3.14). Un crash natif tue tout ce process worker
    # (pas rattrapable par ce try/except), auquel cas services/analyzer.js
    # retombe automatiquement sur son propre chemin "process par appel" (qui,
    # lui, a un vrai 2e essai en SAFE MODE). Ce try/except couvre le cas plus
    # rare mais réel où l'échec reste une exception Python catchable ("peut
    # produire une autre erreur numba interne selon les cas") — on bascule
    # alors, SANS perdre le worker persistant, vers tempo() (même calcul que
    # beat_track mais sans le backtracking DP qui plante) + une grille de
    # beats approximative à pas régulier ancrée sur le premier onset détecté.
    try:
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        beat_times_all = librosa.frames_to_time(beat_frames, sr=sr)
        beat_times = [round(float(t), 3) for t in beat_times_all][:4000]
    except Exception:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo_arr = librosa.beat.tempo(onset_envelope=onset_env, sr=sr)
        bpm = float(np.atleast_1d(tempo_arr)[0])
        onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
        onset_times = librosa.frames_to_time(onset_frames, sr=sr)
        start = float(onset_times[0]) if len(onset_times) else 0.0
        step = 60.0 / bpm if bpm > 0 else 0.5
        beat_times, t = [], start
        while t < duration and len(beat_times) < 4000:
            beat_times.append(round(t, 3))
            t += step

    # ── Clé + mode (Krumhansl-Schmuckler), sur le "corps" du morceau ──
    skip_s = int(len(y) * 0.20)
    skip_e = max(int(len(y) * 0.10), int(sr * 5))
    y_body = y[skip_s: -skip_e] if len(y) > skip_s + skip_e + sr * 10 else y
    chroma_key = librosa.feature.chroma_cens(y=y_body, sr=sr, hop_length=4096)
    chroma_mean = chroma_key.mean(axis=1)
    chroma_full = librosa.feature.chroma_cqt(y=y, sr=sr)

    major_idx, major_corr = best_correlation(chroma_mean, MAJOR_PROFILE)
    minor_idx, minor_corr = best_correlation(chroma_mean, MINOR_PROFILE)
    if major_corr >= minor_corr:
        key_pitch, key_mode = PITCHES[major_idx], 'major'
    else:
        key_pitch, key_mode = PITCHES[minor_idx], 'minor'
    key_confidence = round(float(max(major_corr, minor_corr)), 3)

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

    # ── Empreinte spectrale ──
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
    # cf. import en tête de fichier) — ordre 4, compromis raideur/stabilité
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

    # ── Structure approximative (segmentation + clé par segment) ──
    try:
        n_segments = min(8, max(3, int(duration // 20)))
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
                seg_key_pitch, seg_key_mode, seg_camelot, seg_key_confidence = None, None, None, 0.0

            structure.append({
                'start': round(start, 2), 'end': round(end, 2),
                'energy': round(seg_energy, 4), 'label': label,
                'key_pitch': seg_key_pitch, 'key_mode': seg_key_mode,
                'camelot': seg_camelot, 'key_confidence': seg_key_confidence,
            })
    except Exception:
        structure = []

    return {
        'bpm': round(bpm, 1),
        'duration': round(duration, 2),
        'key': key_pitch,
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
    }


emit({"type": "ready"})

# Reste vivant pour toute la durée du serveur Node — un job JSON par ligne
# stdin, jusqu'à fermeture du flux (shutdown() côté Node, cf. workerPool.js).
for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    try:
        req = json.loads(raw_line)
    except Exception:
        continue

    job_id = req.get("id")
    try:
        wav_path = req["wavPath"]
        result = analyze_track(wav_path)
        emit({"id": job_id, "ok": True, "result": result})
    except Exception as e:
        emit({"id": job_id, "ok": False, "error": f"{e.__class__.__name__}: {e}"})
        sys.stderr.write(traceback.format_exc() + "\n")
        sys.stderr.flush()
