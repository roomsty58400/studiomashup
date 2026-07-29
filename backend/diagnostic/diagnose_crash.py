import sys

path = sys.argv[1]
print(f"[0] fichier : {path}", flush=True)

import librosa
import numpy as np
print("[1] imports ok", flush=True)

y, sr = librosa.load(path, sr=22050, mono=True)
print(f"[2] load ok — {len(y)} echantillons, sr={sr}", flush=True)

duration = float(librosa.get_duration(y=y, sr=sr))
print(f"[3] duration ok — {duration:.1f}s", flush=True)

tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
print(f"[4] beat_track ok — tempo={np.atleast_1d(tempo)[0]:.1f}", flush=True)

beat_times_all = librosa.frames_to_time(beat_frames, sr=sr)
print("[5] frames_to_time ok", flush=True)

skip_s = int(len(y) * 0.20)
skip_e = max(int(len(y) * 0.10), int(sr * 5))
y_body = y[skip_s : -skip_e] if len(y) > skip_s + skip_e + sr * 10 else y
print("[6] decoupage corps ok", flush=True)

chroma_key = librosa.feature.chroma_cens(y=y_body, sr=sr, hop_length=4096)
print("[7] chroma_cens ok", flush=True)

chroma_full = librosa.feature.chroma_cqt(y=y, sr=sr)
print("[8] chroma_cqt ok", flush=True)

rms = librosa.feature.rms(y=y)[0]
print("[9] rms ok", flush=True)

mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
print("[10] mfcc ok", flush=True)

centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
print("[11] spectral_centroid ok", flush=True)

n_segments = min(8, max(3, int(duration // 20)))
features = np.vstack([chroma_full, mfcc])
bounds = librosa.segment.agglomerative(features, n_segments)
print("[12] segment.agglomerative ok", flush=True)

print("=== TOUT EST PASSE — aucun crash isole par ce script ===", flush=True)
