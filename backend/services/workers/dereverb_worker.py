import sys, os, json, traceback

# ── Worker dé-reverb persistant (audit perf juillet 2026) ───────────────────
# Miroir de demucs_worker.py / analyzer_worker.py, pour audio-separator (UVR
# DeEcho-DeReverb) : jusqu'ici, services/dereverb.js relançait un process
# Python neuf (venv dédié C:\audio-separator-env) À CHAQUE appel via la CLI
# ("python -m audio_separator.utils.cli ..."), qui paie l'import de torch/
# onnxruntime ET le rechargement du modèle depuis le disque à chaque fois —
# exactement le problème déjà résolu pour Demucs et Librosa, jamais corrigé
# ici. Un process persistant garde le modèle chargé en mémoire en permanence.
#
# Protocole IDENTIQUE aux 2 autres workers : une ligne JSON par job sur
# stdin, une ligne JSON par réponse sur stdout. {"type":"ready"} signale la
# fin du chargement. Une exception AU DÉMARRAGE (import, modèle) est fatale
# ({"type":"fatal"}) — c'est alors à dereverb.js de retomber sur l'ancien
# mode CLI (jamais l'inverse). Une exception PENDANT un job ne casse que CE
# job.
#
# INCERTITUDE CONNUE (à valider empiriquement, cf. commentaire dans
# dereverb.js) : la doc publique du package audio-separator ne liste PAS de
# paramètre "use_cuda" pour la classe Separator (contrairement au flag CLI
# "--use_cuda" utilisé par l'ancien mode) — la sélection GPU semble automatique
# dans les versions récentes (détection onnxruntime CUDAExecutionProvider),
# mais la version réellement installée dans le venv dédié peut différer. On
# tente le paramètre par optimisme (repli silencieux si absent), et le
# comportement réel doit être vérifié dans les logs serveur après coup.

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

try:
    from audio_separator.separator import Separator
except Exception as e:
    emit({"type": "fatal", "error": f"import impossible ({e.__class__.__name__}: {e}) — package audio-separator absent de cet environnement Python"})
    sys.exit(1)

MODEL = os.environ.get("DEREVERB_MODEL", "UVR-DeEcho-DeReverb.pth")
MODEL_DIR = os.environ.get("DEREVERB_MODEL_DIR") or None
TRY_CUDA = os.environ.get("DEREVERB_USE_CUDA") == "1"

def build_separator(use_cuda):
    kwargs = dict(model_file_dir=MODEL_DIR, output_format="FLAC")
    if use_cuda:
        kwargs["use_cuda"] = True
    return Separator(**kwargs)

try:
    try:
        separator = build_separator(TRY_CUDA)
        cuda_kwarg_accepted = True
    except TypeError:
        # Version installée sans le paramètre "use_cuda" au constructeur —
        # repli sans ce réglage explicite (device choisi automatiquement par
        # la lib elle-même selon ce qui est disponible dans l'environnement).
        separator = build_separator(False)
        cuda_kwarg_accepted = False
except Exception as e:
    emit({"type": "fatal", "error": f"initialisation Separator impossible : {e}"})
    sys.exit(1)

try:
    separator.load_model(model_filename=MODEL)
except Exception as e:
    emit({"type": "fatal", "error": f"chargement du modèle '{MODEL}' impossible : {e}"})
    sys.exit(1)

emit({
    "type": "ready",
    "model": MODEL,
    "cudaRequested": TRY_CUDA,
    "cudaKwargAccepted": cuda_kwarg_accepted,
})

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
        input_path = req["inputPath"]
        output_dir = req["outputDir"]
        os.makedirs(output_dir, exist_ok=True)
        # Mutation directe de l'attribut plutôt qu'un paramètre de separate() :
        # la lib ne documente pas de façon de changer le dossier de sortie
        # APRÈS construction autrement — à valider empiriquement (cf. en-tête
        # de ce fichier) ; si ça échoue, l'exception est capturée ci-dessous
        # et remontée comme un échec de CE job seulement, dereverb.js retombe
        # alors sur le mode CLI pour cet appel.
        separator.output_dir = output_dir
        separator.separate(input_path)
        # On ne fait PAS confiance à la valeur de retour de separate() pour la
        # liste des fichiers produits (son format exact — noms relatifs ou
        # chemins complets — n'est pas garanti selon la version) : dereverb.js
        # relit le dossier de sortie lui-même (readdirSync), exactement comme
        # pour l'ancien mode CLI — même logique de reconnaissance de fichier,
        # aucune duplication de cette heuristique ici.
        emit({"id": job_id, "ok": True, "result": {"outputDir": output_dir}})
    except Exception as e:
        emit({"id": job_id, "ok": False, "error": f"{e.__class__.__name__}: {e}"})
        sys.stderr.write(traceback.format_exc() + "\n")
        sys.stderr.flush()
