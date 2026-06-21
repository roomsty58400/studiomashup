
import sys, json, warnings
warnings.filterwarnings('ignore')

try:
    import librosa
    import numpy as np

    path = sys.argv[1]
    y, sr = librosa.load(path, sr=None, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # ── BPM ──
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    # ── Clé + mode (algorithme de Krumhansl-Schmuckler) ──
    # Profils de référence (Krumhansl & Kessler, 1990) — corrélation entre le
    # chroma moyen du morceau et chaque rotation des 2 profils (majeur/mineur)
    # pour les 12 hauteurs : le meilleur score donne la clé + le mode.
    PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)

    def best_correlation(profile):
        best_idx, best_corr = 0, -2.0
        for shift in range(12):
            rotated = np.roll(profile, shift)
            corr = np.corrcoef(chroma_mean, rotated)[0, 1]
            if corr > best_corr:
                best_corr, best_idx = corr, shift
        return best_idx, best_corr

    major_idx, major_corr = best_correlation(MAJOR_PROFILE)
    minor_idx, minor_corr = best_correlation(MINOR_PROFILE)

    if major_corr >= minor_corr:
        key_pitch, key_mode = PITCHES[major_idx], 'major'
    else:
        key_pitch, key_mode = PITCHES[minor_idx], 'minor'

    # ── Notation Camelot (roue standard utilisée en DJing) ──
    CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B']
    CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A']
    pitch_idx = PITCHES.index(key_pitch)
    camelot = CAMELOT_MAJOR[pitch_idx] if key_mode == 'major' else CAMELOT_MINOR[pitch_idx]

    # ── Énergie (RMS) ──
    rms = librosa.feature.rms(y=y)[0]
    energy_rms = float(rms.mean())
    energy_std = float(rms.std())

    # ── Empreinte spectrale (MFCC + centroïde) ──
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    mfcc_mean = mfcc.mean(axis=1).tolist()
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    spectral_centroid = float(centroid.mean())

    # ── Structure approximative (segmentation par timbre/harmonie) ──
    # Combine chroma + MFCC frame par frame, segmente en sections via
    # clustering agglomératif (librosa.segment), puis étiquette chaque
    # section par son énergie relative au morceau entier.
    try:
        n_segments = min(8, max(3, int(duration // 20)))  # ~1 section / 20s, borné [3,8]
        features = np.vstack([chroma, mfcc])
        bounds = librosa.segment.agglomerative(features, n_segments)
        bound_times = librosa.frames_to_time(bounds, sr=sr).tolist()
        bound_times = [0.0] + [t for t in bound_times if 0 < t < duration] + [duration]
        bound_times = sorted(set(round(t, 2) for t in bound_times))

        hop_length = 512
        rms_frame_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
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
            structure.append({'start': round(start, 2), 'end': round(end, 2), 'energy': round(seg_energy, 4), 'label': label})
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
        'camelot': camelot,
        'energy_rms': round(energy_rms, 4),
        'energy_std': round(energy_std, 4),
        'spectral_centroid': round(spectral_centroid, 1),
        'mfcc_mean': mfcc_mean,
        'structure': structure,
    }))
except Exception as e:
    import traceback
    print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), file=sys.stderr)
    sys.exit(1)
