import sys, os, json, traceback

# ── Worker Demucs persistant (audit perf juillet 2026) ──────────────────────
# Contrepartie Python de services/workerPool.js : charge torch + le modèle
# Demucs UNE SEULE FOIS au démarrage (au lieu d'un process/import/rechargement
# de modèle par appel, comme le faisait l'ancien "python -m demucs" relancé à
# chaque séparation depuis services/demucs.js), puis traite tous les jobs
# suivants avec le modèle déjà chaud en RAM/VRAM.
#
# Protocole : une ligne JSON par job sur stdin, une ligne JSON par réponse sur
# stdout (même id). {"type":"ready"} signale la fin du chargement. Toute
# exception PENDANT un job est capturée et renvoyée comme erreur pour CE job
# uniquement — le worker continue de tourner pour les jobs suivants. Une
# exception AU DÉMARRAGE (import, modèle) est fatale et signalée via
# {"type":"fatal"} : c'est alors à services/demucs.js de retomber sur
# l'ancien mode "un process par appel" (jamais l'inverse).

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

try:
    import torch
    from demucs.api import Separator
    import soundfile as sf
except Exception as e:
    emit({"type": "fatal", "error": f"import impossible ({e.__class__.__name__}: {e}) — API demucs.api absente ou dépendance manquante dans cet environnement Python"})
    sys.exit(1)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Modèle chargé au démarrage (le plus courant : mode "4 stems" par défaut).
# DÉPUIS l'ajout du sélecteur 2/4/6 stems (juillet 2026, cf. services/
# demucs.js), chaque job peut demander un modèle DIFFÉRENT ("model" dans le
# JSON reçu) — current_model/separator sont donc mutables, rechargés à la
# volée UNIQUEMENT quand le modèle demandé change (get_separator ci-dessous),
# au lieu d'un unique modèle figé pour toute la durée du process. Un
# changement de mode entre 2 mashups paie donc le rechargement une fois, pas
# à chaque appel dans le même mode.
current_model = os.environ.get("DEMUCS_MODEL", os.environ.get("DEMUCS_MODEL_4", "htdemucs_ft"))

# shifts=0 (au lieu du défaut de l'API demucs.api.Separator, qui est
# shifts=1) : "shifts" fait tourner l'inférence plusieurs fois avec un
# décalage temporel aléatoire à chaque fois, puis moyenne les résultats
# (meilleure qualité marginale, temps de calcul multiplié d'autant). Avec
# shifts=1 (comportement par défaut si on ne le précise pas), Demucs paie
# déjà UNE passe de calcul supplémentaire par séparation pour un gain à
# peine perceptible sur du mashup — shifts=0 désactive complètement ce
# mécanisme (une seule passe, sans décalage) : gain de temps direct, sans
# changement de modèle ni perte de qualité notable en pratique.
SEPARATOR_SHIFTS = 0

try:
    separator = Separator(model=current_model, device=DEVICE, shifts=SEPARATOR_SHIFTS)
except Exception as e:
    emit({"type": "fatal", "error": f"chargement du modèle '{current_model}' impossible sur {DEVICE}: {e}"})
    sys.exit(1)

emit({"type": "ready", "device": DEVICE, "model": current_model})

def get_separator(requested_model):
    global current_model, separator
    if requested_model and requested_model != current_model:
        sys.stderr.write(f"[demucs_worker] changement de modèle : '{current_model}' -> '{requested_model}'\n")
        sys.stderr.flush()
        # Libère explicitement l'ANCIEN modèle AVANT de charger le nouveau
        # (audit perf juillet 2026) : sans ce del + empty_cache(), la ligne
        # suivante ("separator = Separator(...)") construit le NOUVEAU modèle
        # pendant que la référence à l'ancien est encore vivante (le global
        # "separator" n'est réassigné qu'APRÈS la construction complète) — les
        # 2 jeux de poids cohabitent brièvement en VRAM. Sur une carte 6 Go
        # (RTX 2060), htdemucs_ft (ensemble de 4 sous-modèles, mode 2/4 stems)
        # + htdemucs_6s (mode 6 stems) chargés simultanément, même un court
        # instant, peut suffire à déclencher un OOM CUDA lors d'un changement
        # de mode en cours de session. torch.cuda.empty_cache() ne libère que
        # la mémoire mise en cache par l'allocateur PyTorch (jamais celle
        # activement utilisée) — sans danger, juste rend l'espace du modèle
        # supprimé immédiatement disponible plutôt que de laisser le garbage
        # collector Python s'en charger à un moment non déterministe.
        del separator
        if DEVICE == "cuda":
            torch.cuda.empty_cache()
        separator = Separator(model=requested_model, device=DEVICE, shifts=SEPARATOR_SHIFTS)
        current_model = requested_model
    return separator


# ── fp16/autocast sur GPU uniquement ────────────────────────────────────────
# torch.autocast bascule automatiquement les opérations compatibles en
# demi-précision (float16) pendant l'inférence — gain de vitesse et de
# mémoire VRAM sur GPU (cœurs Tensor dédiés au fp16 sur la plupart des cartes
# NVIDIA récentes). Volontairement PAS appliqué sur CPU : le fp16 n'y est pas
# accéléré matériellement (pas de gain, parfois même plus lent), et
# torch.autocast(device_type="cpu", dtype=torch.float16) peut se comporter
# de façon instable selon la version de torch installée.
import contextlib

def inference_context():
    if DEVICE == "cuda":
        return torch.autocast(device_type="cuda", dtype=torch.float16)
    return contextlib.nullcontext()

# Reste vivant pour toute la durée du serveur Node — lit un job JSON par
# ligne stdin, jusqu'à fermeture du flux (shutdown() côté Node).
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
        output_dir = req["outputDir"]
        full_stems = bool(req.get("fullStems", False))
        job_separator = get_separator(req.get("model"))
        os.makedirs(output_dir, exist_ok=True)

        with inference_context():
            _, separated = job_separator.separate_audio_file(wav_path)
        sr = job_separator.samplerate

        saved = {}
        if full_stems:
            for name, tensor in separated.items():
                path = os.path.join(output_dir, f"{name}.flac")
                sf.write(path, tensor.numpy().T, sr)
                saved[name] = path
        else:
            vocals = separated["vocals"]
            no_vocals = None
            for name, tensor in separated.items():
                if name == "vocals":
                    continue
                no_vocals = tensor if no_vocals is None else (no_vocals + tensor)
            vpath = os.path.join(output_dir, "vocals.flac")
            npath = os.path.join(output_dir, "no_vocals.flac")
            sf.write(vpath, vocals.numpy().T, sr)
            sf.write(npath, no_vocals.numpy().T, sr)
            saved = {"vocals": vpath, "no_vocals": npath}

        emit({"id": job_id, "ok": True, "result": saved})
    except Exception as e:
        emit({"id": job_id, "ok": False, "error": f"{e.__class__.__name__}: {e}"})
        sys.stderr.write(traceback.format_exc() + "\n")
        sys.stderr.flush()
