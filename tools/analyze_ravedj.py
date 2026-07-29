#!/usr/bin/env python3
"""
analyze_ravedj.py — Analyse spectrale comparative mashup
=========================================================
Usage :
  python analyze_ravedj.py ravedj_mashup.mp4 [macheup_mashup.flac]

Compare un fichier rave.dj (MP4 ou MP3) avec un mashup MacheUp sur :
  - Loudness LUFS intégré + True Peak
  - Dynamic Range (PLR = Peak-to-Loudness Ratio)
  - Spectre de fréquences (courbe RMS sur 1/3 octave)
  - HPF effectif (fréquence de coupure basse estimée)
  - EQ shape (comparaison de la courbe spectrale)
  - BPM
  - Dynamic compression estimate (crest factor)
  - Short-term loudness variance (sidechain evidence)

Prérequis : pip install librosa numpy matplotlib soundfile
            ffmpeg dans le PATH (pour extraire l'audio des MP4)

Télécharger des mashups rave.dj pour test :
  "Hold That" (Disclosure + The XX) :
    https://y4w3b3b7.map2.ssl.hwcdn.net/rave-us-3/mashups%2Fc973fc8b-7a88-447e-a4d7-fc61b86d068d.mp4
  "Bloody To My Roots" (Sepultura + PSB) :
    https://assets2.rave.dj/videos/0864fa66-6de8-44ee-a0a4-4c45684c9b1b720.mp4
  Mix 41 songs :
    https://assets3.rave.dj/videos/06b789d7-769f-4765-8984-0403eafc2348720.mp4
"""

import sys
import os
import json
import subprocess
import tempfile
import warnings

warnings.filterwarnings("ignore")

try:
    import librosa
    import numpy as np
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.ticker as ticker
    import soundfile as sf
except ImportError as e:
    print(f"[ERREUR] Module manquant : {e}")
    print("  → pip install librosa numpy matplotlib soundfile")
    sys.exit(1)


# ── Extraction audio depuis MP4/MP3/WAV ──────────────────────────────────────
def extract_audio_wav(input_path: str, sr: int = 44100) -> np.ndarray:
    """Extrait l'audio d'un fichier via ffmpeg si nécessaire, charge en float32."""
    ext = os.path.splitext(input_path)[1].lower()
    if ext in (".wav", ".flac", ".aiff"):
        y, file_sr = librosa.load(input_path, sr=sr, mono=False)
    else:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        cmd = ["ffmpeg", "-i", input_path, "-vn", "-acodec", "pcm_s16le",
               "-ar", str(sr), "-ac", "2", tmp_path, "-y", "-loglevel", "error"]
        subprocess.run(cmd, check=True)
        y, _ = librosa.load(tmp_path, sr=sr, mono=False)
        os.unlink(tmp_path)
    if y.ndim == 1:
        y = np.stack([y, y])  # mono → stéréo fictif
    return y  # shape (2, n_samples) @ sr


# ── LUFS EBU R128 (K-weighted) simplifié ─────────────────────────────────────
def compute_lufs(y: np.ndarray, sr: int) -> tuple[float, float]:
    """
    Calcul LUFS intégré simplifié via K-weighting (pré-filtre + RLB filter).
    Retourne (LUFS_integrated, TruePeak_dBTP).
    """
    from scipy.signal import butter, sosfilt

    # K-weighting stage 1 : high-shelf +4 dB @ 1681 Hz (pré-filtre)
    b0 = 1.53512485958697
    b1 = -2.69169618940638
    b2 = 1.19839281085285
    a1 = -1.69065929318241
    a2 = 0.73248077421585
    # On simplifie ici : appliquer le filtre RMS sur mono
    mono = y.mean(axis=0)
    # Butterworth HPF 100 Hz (RLB filter approximation)
    sos = butter(2, 100.0 / (sr / 2), btype="high", output="sos")
    filtered = sosfilt(sos, mono)
    # Gating simplifié : blocs de 400ms, seuil absolu -70 LUFS
    block_size = int(sr * 0.4)
    n_blocks = len(filtered) // block_size
    block_powers = []
    for i in range(n_blocks):
        block = filtered[i * block_size:(i + 1) * block_size]
        power = np.mean(block ** 2)
        if power > 1e-10:
            lufs_block = -0.691 + 10 * np.log10(power)
            if lufs_block > -70:
                block_powers.append(power)
    if not block_powers:
        return -99.0, -99.0
    # Seuil relatif (-10 LU au-dessus de la moyenne)
    avg_power = np.mean(block_powers)
    threshold = avg_power * 10 ** (-10 / 10)
    gated_powers = [p for p in block_powers if p >= threshold]
    if not gated_powers:
        gated_powers = block_powers
    lufs = -0.691 + 10 * np.log10(np.mean(gated_powers))
    true_peak = float(20 * np.log10(np.abs(y).max() + 1e-10))
    return round(lufs, 1), round(true_peak, 1)


# ── Dynamic Range (crest factor, PLR) ────────────────────────────────────────
def compute_dynamics(y: np.ndarray, sr: int) -> dict:
    mono = y.mean(axis=0)
    # RMS global
    rms = np.sqrt(np.mean(mono ** 2))
    rms_db = 20 * np.log10(rms + 1e-10)
    # Peak
    peak_db = 20 * np.log10(np.abs(mono).max() + 1e-10)
    # Crest factor
    crest = peak_db - rms_db
    # Short-term loudness variance (sidechain evidence)
    # On découpe en blocs de 1s et on regarde l'écart-type
    block_size = sr
    n_blocks = len(mono) // block_size
    rms_per_block = []
    for i in range(n_blocks):
        block = mono[i * block_size:(i + 1) * block_size]
        rms_per_block.append(np.sqrt(np.mean(block ** 2)))
    lufs_variance = float(np.std(20 * np.log10(np.array(rms_per_block) + 1e-10)))
    return {
        "rms_db": round(rms_db, 1),
        "peak_db": round(peak_db, 1),
        "crest_factor_db": round(crest, 1),
        "loudness_variance_1s": round(lufs_variance, 2),
    }


# ── Spectre 1/3 d'octave (courbe EQ de facto) ────────────────────────────────
THIRD_OCTAVE_FREQS = [
    20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
    630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
    10000, 12500, 16000, 20000
]


def compute_spectrum(y: np.ndarray, sr: int) -> dict:
    """Spectre RMS par bandes 1/3 octave. Retourne dict freq→dB."""
    from scipy.signal import butter, sosfilt
    mono = y.mean(axis=0)
    results = {}
    for fc in THIRD_OCTAVE_FREQS:
        if fc >= sr / 2:
            continue
        lo = fc / (2 ** (1 / 6))
        hi = fc * (2 ** (1 / 6))
        lo = max(lo, 10)
        hi = min(hi, sr / 2 - 1)
        if lo >= hi:
            continue
        try:
            sos = butter(2, [lo / (sr / 2), hi / (sr / 2)],
                         btype="band", output="sos")
            band = sosfilt(sos, mono)
            rms = np.sqrt(np.mean(band ** 2))
            results[fc] = round(20 * np.log10(rms + 1e-10), 1)
        except Exception:
            results[fc] = -99.0
    return results


# ── BPM ──────────────────────────────────────────────────────────────────────
def compute_bpm(y: np.ndarray, sr: int) -> float:
    mono = y.mean(axis=0)
    tempo, _ = librosa.beat.beat_track(y=mono, sr=sr)
    return round(float(np.atleast_1d(tempo)[0]), 1)


# ── HPF effectif (fréquence à −6 dB dans le bas du spectre) ─────────────────
def estimate_hpf(spectrum: dict) -> float:
    """Estime la fréquence de coupure basse à partir de la courbe spectrale."""
    freqs = sorted(spectrum.keys())
    # Trouver le niveau de référence (médiane entre 500 et 4000 Hz)
    mid_levels = [spectrum[f] for f in freqs if 500 <= f <= 4000]
    if not mid_levels:
        return 0
    ref_level = np.median(mid_levels)
    # Chercher la fréquence où le niveau est -10 dB sous la référence
    for f in freqs:
        if spectrum[f] >= ref_level - 10:
            return f
    return 0


# ── Analyse principale ────────────────────────────────────────────────────────
def analyze(path: str, label: str, sr: int = 44100) -> dict:
    print(f"\n{'='*60}")
    print(f"Analyse : {label}")
    print(f"Fichier : {os.path.basename(path)}")
    print(f"{'='*60}")

    y = extract_audio_wav(path, sr)
    duration = y.shape[1] / sr
    print(f"  Durée    : {duration:.1f}s")

    lufs, true_peak = compute_lufs(y, sr)
    print(f"  LUFS int : {lufs} LUFS")
    print(f"  True Peak: {true_peak} dBTP")

    dyn = compute_dynamics(y, sr)
    print(f"  RMS      : {dyn['rms_db']} dB")
    print(f"  Crest    : {dyn['crest_factor_db']} dB  (plus bas = plus compressé)")
    print(f"  Variance loudness/1s : {dyn['loudness_variance_1s']} dB (sidechain actif si >2)")

    bpm = compute_bpm(y, sr)
    print(f"  BPM      : {bpm}")

    spectrum = compute_spectrum(y, sr)
    hpf = estimate_hpf(spectrum)
    print(f"  HPF effectif estimé : ~{hpf} Hz")

    return {
        "label": label,
        "path": path,
        "duration": round(duration, 1),
        "lufs": lufs,
        "true_peak": true_peak,
        "bpm": bpm,
        "hpf_estimate": hpf,
        "spectrum": spectrum,
        **dyn,
    }


# ── Comparaison et rapport ───────────────────────────────────────────────────
def compare_and_plot(results: list[dict], output_dir: str = "."):
    print(f"\n{'='*60}")
    print("COMPARAISON")
    print(f"{'='*60}")

    if len(results) < 2:
        print("Un seul fichier analysé — pas de comparaison possible.")
        return

    a, b = results[0], results[1]
    print(f"\n{'Métrique':<30} {a['label']:<20} {b['label']:<20} Delta")
    print("-" * 80)
    metrics = [
        ("LUFS intégré", "lufs", "LUFS"),
        ("True Peak", "true_peak", "dBTP"),
        ("RMS", "rms_db", "dB"),
        ("Crest factor", "crest_factor_db", "dB"),
        ("Variance loudness/1s", "loudness_variance_1s", "dB"),
        ("BPM", "bpm", ""),
        ("HPF estimé", "hpf_estimate", "Hz"),
    ]
    for name, key, unit in metrics:
        va = a.get(key, "N/A")
        vb = b.get(key, "N/A")
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            delta = round(vb - va, 1)
            print(f"{name:<30} {f'{va} {unit}':<20} {f'{vb} {unit}':<20} {delta:+.1f}")
        else:
            print(f"{name:<30} {str(va):<20} {str(vb):<20}")

    # ── Plot spectre comparatif ──
    fig, axes = plt.subplots(2, 1, figsize=(14, 10))
    colors = ["#00BFFF", "#FF6B35"]

    # Subplot 1 : spectres superposés
    ax = axes[0]
    for i, r in enumerate(results):
        spec = r["spectrum"]
        freqs = sorted(spec.keys())
        levels = [spec[f] for f in freqs]
        ax.semilogx(freqs, levels, "-o", markersize=4,
                    color=colors[i], label=r["label"], linewidth=2)
    ax.set_xlim(20, 20000)
    ax.set_xlabel("Fréquence (Hz)")
    ax.set_ylabel("Niveau RMS (dB)")
    ax.set_title("Spectre 1/3 octave — comparaison rave.dj vs MacheUp")
    ax.legend()
    ax.grid(True, which="both", alpha=0.3)
    ax.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f"{int(x)}Hz"))
    ax.axvline(x=200, color="red", linestyle="--", alpha=0.5, label="HPF 200Hz (MacheUp voix)")
    ax.axvline(x=300, color="orange", linestyle="--", alpha=0.5, label="Mud cut 300Hz (MacheUp instru)")
    ax.axvline(x=1800, color="green", linestyle="--", alpha=0.5, label="EQ creux 1800Hz (MacheUp instru)")

    # Subplot 2 : différence spectrale (rave.dj - MacheUp)
    ax2 = axes[1]
    a_spec, b_spec = results[0]["spectrum"], results[1]["spectrum"]
    common_freqs = sorted(set(a_spec.keys()) & set(b_spec.keys()))
    diff = [b_spec[f] - a_spec[f] for f in common_freqs]
    ax2.semilogx(common_freqs, diff, "-o", markersize=4, color="#9B59B6", linewidth=2)
    ax2.axhline(y=0, color="gray", linestyle="-", alpha=0.5)
    ax2.axhline(y=2, color="gray", linestyle="--", alpha=0.3)
    ax2.axhline(y=-2, color="gray", linestyle="--", alpha=0.3)
    ax2.fill_between(common_freqs, diff, 0,
                     where=[d > 0 for d in diff], alpha=0.2, color="green",
                     label=f"{results[1]['label']} plus fort")
    ax2.fill_between(common_freqs, diff, 0,
                     where=[d <= 0 for d in diff], alpha=0.2, color="red",
                     label=f"{results[0]['label']} plus fort")
    ax2.set_xlim(20, 20000)
    ax2.set_xlabel("Fréquence (Hz)")
    ax2.set_ylabel(f"Δ dB ({results[1]['label']} − {results[0]['label']})")
    ax2.set_title("Différence spectrale entre les deux mashups")
    ax2.legend()
    ax2.grid(True, which="both", alpha=0.3)
    ax2.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f"{int(x)}Hz"))

    plt.tight_layout()
    out_path = os.path.join(output_dir, "mashup_comparison.png")
    plt.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"\n  → Graphique sauvegardé : {out_path}")

    # ── JSON brut ──
    json_path = os.path.join(output_dir, "mashup_comparison.json")
    with open(json_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"  → Données JSON : {json_path}")


# ── Interprétation automatique ────────────────────────────────────────────────
def interpret(results: list[dict]):
    print(f"\n{'='*60}")
    print("INTERPRÉTATION AUTOMATIQUE")
    print(f"{'='*60}")

    if len(results) < 2:
        r = results[0]
        print(f"\nAnalyse fichier unique : {r['label']}")
        print(f"  LUFS {r['lufs']} → {'trop silencieux (<-16)' if r['lufs'] < -16 else 'OK' if r['lufs'] < -12 else 'loud (>-12)'}")
        print(f"  Crest {r['crest_factor_db']} dB → {'très compressé (<6)' if r['crest_factor_db'] < 6 else 'peu compressé (>10)' if r['crest_factor_db'] > 10 else 'compression modérée'}")
        return

    a, b = results[0], results[1]

    print(f"\n[Loudness]")
    lufs_diff = b["lufs"] - a["lufs"]
    if abs(lufs_diff) > 2:
        louder = a["label"] if a["lufs"] > b["lufs"] else b["label"]
        print(f"  ⚠ Différence {abs(lufs_diff)} LUFS — '{louder}' est significativement plus fort")
        print(f"    → Comparaison à equal loudness recommandée pour neutraliser le biais perceptif")
    else:
        print(f"  ✓ Loudness similaire (Δ={lufs_diff:+.1f} LUFS)")

    print(f"\n[Compression / Dynamique]")
    crest_a, crest_b = a["crest_factor_db"], b["crest_factor_db"]
    if crest_a < crest_b - 2:
        print(f"  rave.dj ({a['label']}) : crest {crest_a} dB → PLUS compressé")
        print(f"  MacheUp ({b['label']}) : crest {crest_b} dB → moins dense")
        print(f"    → Ajouter un master bus compressor (acompressor ratio=2) sur le mix MacheUp")
    elif crest_b < crest_a - 2:
        print(f"  MacheUp ({b['label']}) : crest {crest_b} dB → plus compressé")
    else:
        print(f"  ✓ Dynamiques similaires")

    print(f"\n[Sidechain / Pumping]")
    var_a, var_b = a["loudness_variance_1s"], b["loudness_variance_1s"]
    print(f"  {a['label']} variance/1s : {var_a} dB")
    print(f"  {b['label']} variance/1s : {var_b} dB")
    if var_a > 3:
        print(f"    → {a['label']} a une forte variance → sidechain ou segments alternés")

    print(f"\n[Spectre basses fréquences]")
    hpf_diff = b["hpf_estimate"] - a["hpf_estimate"]
    if hpf_diff > 50:
        print(f"  rave.dj HPF estimé ~{a['hpf_estimate']} Hz, MacheUp ~{b['hpf_estimate']} Hz")
        print(f"    → MacheUp HPF trop agressif — coupes trop de basses")
    elif hpf_diff < -50:
        print(f"  MacheUp HPF ~{b['hpf_estimate']} Hz — laisse plus de graves")
    else:
        print(f"  ✓ HPF similaire (Δ={hpf_diff:+.0f} Hz)")

    print(f"\n[BPM]")
    bpm_diff = abs(a["bpm"] - b["bpm"])
    if bpm_diff > 2:
        print(f"  ⚠ BPMs différents : {a['bpm']} vs {b['bpm']} — pas les mêmes chansons ou tempo-ratio différent")
    else:
        print(f"  ✓ BPMs proches ({a['bpm']} vs {b['bpm']})")


# ── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    paths = sys.argv[1:]
    labels = []
    for p in paths:
        basename = os.path.splitext(os.path.basename(p))[0]
        if "rave" in basename.lower():
            labels.append("rave.dj")
        elif any(x in basename.lower() for x in ["macheup", "mashup", "mixed"]):
            labels.append("MacheUp")
        else:
            labels.append(basename[:20])

    results = []
    for path, label in zip(paths, labels):
        if not os.path.exists(path):
            print(f"[ERREUR] Fichier introuvable : {path}")
            continue
        results.append(analyze(path, label))

    if results:
        output_dir = os.path.dirname(paths[0]) or "."
        compare_and_plot(results, output_dir)
        interpret(results)

    print("\n[✓] Analyse terminée.")
