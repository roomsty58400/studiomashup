# MacheUp Studio (Studiomashup)

Application desktop-web pour créer des mashups DJ, du mix automatique jusqu'à la diffusion en soirée : recherche/téléchargement YouTube, analyse audio (BPM, tonalité, structure), séparation de stems (Demucs), mixage automatique ou manuel, export FLAC/MP4, console DJ live et assistant de playlist.

Usage personnel, pensé pour tourner en local (`localhost`), pas pour être exposé sur Internet.

## Pages de l'application

- **MacheUp** — Deck A/B, séparation IA 4 stems (Demucs), analyse BPM/tonalité automatique, moteur de mashup (automatique ou "à la carte" stem par stem), DJ Assist, Combos instantanés.
- **Clip Editor** — retouche et export du mashup vidéo (découpe, watermark, extraction audio/vidéo, pochette).
- **MachWheel** — roue visuelle des correspondances (compatibilité harmonique/énergétique) pour explorer les combinaisons avant de choisir.
- **DJMUP** — comparateur RaveDJ : lance automatiquement une génération sur rave.dj (navigateur headless côté serveur, `services/ravedjAutomation.js`) sur les 2 mêmes morceaux, pour comparer au résultat MacheUp.
- **MACHEUPDJ** — console DJ virtuelle 2 decks façon VirtualDJ (jog wheel/scratch, pitch, boucles, hot cues, stems isolables en direct via pads, bibliothèque locale persistante avec BPM/tonalité à la demande).
- **DJPLAYLIST** — compare une setlist de référence (import PDF/texte ou décrite à l'IA) à la bibliothèque locale, génère un enchaînement calé sur la courbe d'énergie de la soirée.

## Architecture

- **frontend/** — React 18 + Vite, port 5173.
- **backend/** — Node/Express (ESM), port 3001. Base SQLite locale (`backend/data/macheup.db`) qui met en cache les analyses/stems déjà calculés par morceau.
- **backend/services/workers/** — workers Python persistants (Demucs pour la séparation de stems, librosa pour l'analyse BPM/tonalité).
- **backend/diagnostic/** — scripts de test/diagnostic manuels ponctuels (non exécutés par l'appli elle-même, à lancer à la main si besoin de reproduire un problème précis).
- **diagnostic/** (racine) — historique des audits et scripts de maintenance ponctuels côté projet (voir plus bas).

## Prérequis

- **Node.js** 18+ (le backend utilise `node --watch`, disponible depuis Node 18.11).
- **Python 3.10** avec, au minimum : `demucs`, `torch`, `librosa`, `numpy`. Pas de `requirements.txt` formel à ce jour — installer ces paquets dans l'environnement Python que le backend détecte (voir `backend/services/pythonResolver.js` : plusieurs commandes candidates testées dans l'ordre, `PYTHON`/variables d'env dédiées possibles en dernier recours).
- **ffmpeg** installé et sur le PATH (montage/export audio-vidéo).
- **yt-dlp** (téléchargement YouTube, résolu par `services/ytdlp.js`).

## Lancement

Double-cliquer `start.ps1` (ou `start.bat`) à la racine : démarre le backend et le frontend chacun dans sa fenêtre, ouvre le navigateur sur `http://localhost:5173`. Logs enregistrés dans `diagnostic/logs/` (`backend.log` / `frontend.log`).

Lancement manuel équivalent :

```bash
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

## Variables d'environnement (`backend/.env`)

Aucune n'est strictement obligatoire pour démarrer (l'app dégrade proprement avec des avertissements en console), mais plusieurs fonctionnalités en dépendent :

| Variable | Fonction | Obligatoire pour |
|---|---|---|
| `SESSION_SECRET` | Signe le cookie de session (login Google) | Sessions stables entre redémarrages du serveur (sinon secret aléatoire régénéré à chaque démarrage, re-login requis) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Google (Passport) | Connexion Google |
| `GOOGLE_CALLBACK_URL` | URL de callback OAuth Google | Optionnel — défaut `http://localhost:3001/api/auth/google/callback` |
| `AUDD_API_KEY` | Reconnaissance musicale (AudD) | Shazam intégré — clé gratuite sur https://dashboard.audd.io |
| `YT_API_KEY` | Recherche YouTube (API officielle) | Recherche de morceaux (Decks A/B, Clip Editor, MACHEUPDJ) — restreindre la clé par API (YouTube Data API v3 uniquement) ; une clé utilisée aussi côté frontend (`VITE_YOUTUBE_API_KEY`) doit rester séparée si elle est restreinte par referrer HTTP |
| `GEMINI_API_KEY` | Génération de prompts/pochettes/titres IA + assistant DJPLAYLIST | Fonctions IA (CoverGenerator, prompts Suno, titres, "décris la soirée") |
| `HF_TOKEN` | Jeton Hugging Face | Optionnel — évite le warning "unauthenticated requests to the HF Hub" et accélère/déplafonne le téléchargement des modèles Demucs |
| `DEMUCS_MODEL` / `DEMUCS_MODEL_*` | Choix du modèle Demucs | Optionnel — défaut raisonnable sinon |
| `DEMUCS_PYTHON` | Interpréteur Python dédié pour Demucs (venv séparé avec torch+CUDA) | Optionnel — laisser commenté pour garder "python" (PATH système) par défaut |
| `DEREVERB_PYTHON` / `DEREVERB_WORKER` | Interpréteur/worker dé-réverbération | Optionnel |
| `ANALYZER_WORKER` | Interpréteur worker d'analyse | Optionnel |
| `PORT` | Port du backend (défaut 3001) | Optionnel |

Le frontend a ses propres `.env` (`frontend/.env`, `frontend/src/pages/.env`) avec `VITE_YOUTUBE_API_KEY` — nécessaire pour la recherche YouTube côté client. Un `client_secret_*.json` (téléchargé depuis Google Cloud Console) peut aussi être utilisé à la place de `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` selon la configuration — voir `routes/auth.js`. Ces fichiers et tous les `.env` sont volontairement exclus du dépôt (`.gitignore`) : à recréer localement, jamais à committer.

## Nettoyage des fichiers générés

- **En mémoire** : les jobs terminés (mashup, stems, analyse, etc.) sont purgés automatiquement toutes les 15 min (TTL 2h) par `services/jobCleanup.js` — pas d'action nécessaire.
- **Sur disque** : `backend/tmp/`, `backend/cache/`, `backend/data/outputs/` sont exclus du dépôt et peuvent grossir avec l'usage (stems mis en cache, pochettes générées, enregistrements radio...) — rien n'y est purgé automatiquement à ce jour. Nettoyage manuel possible à tout moment (le backend recrée les dossiers nécessaires à la demande) ; à la fermeture propre du serveur (Ctrl+C) ou via le bouton 🧹 du Mixer (`POST /api/cleanup`) pour les fichiers de la session en cours.

## Dossier `diagnostic/`

Contient l'historique des audits internes du projet (sécurité, architecture, bugs corrigés, rapports datés `rapport-audit-*.md`) — utile pour retrouver le contexte d'une décision technique avant d'y retoucher.
