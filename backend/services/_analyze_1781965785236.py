
import sys, json, warnings
warnings.filterwarnings('ignore')

try:
    import librosa
    import numpy as np
    path = sys.argv[1]
    y, sr = librosa.load(path, sr=None, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key_idx = int(chroma.mean(axis=1).argmax())
    keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
    print(json.dumps({"bpm": round(bpm, 1), "key": keys[key_idx]}))
except Exception as e:
    import traceback
    print(json.dumps({"error": str(e), "trace": traceback.format_exc()}), file=sys.stderr)
    sys.exit(1)
