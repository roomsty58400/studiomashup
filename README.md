# MacheUp Studio (Studiomashup)

Application desktop-web pour créer des mashups DJ : recherche/téléchargement YouTube, analyse audio (BPM, tonalité, structure), séparation de stems (Demucs), mixage automatique ou manuel, export FLAC/MP4.

Usage personnel, pensé pour tourner en local (`localhost`), pas pour être exposé sur Internet.

## Architecture

- **frontend/** — React 18 + Vite, port 5173.
- **backend/** — Node/Express (ESM), port 3001. Base SQLite locale (`backend/data/macheup.db`) qui met en cache les analyses/stems déjà calculés par morceau.
- **backend/services/workers/** — workers Python persistants (Demucs pour la séparation de stems, librosa pour l'analyse BPM/tonalité).

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
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | OAuth Google (Passport) | Connexion Google |
| `AUDD_API_KEY` | Reconnaissance musicale (AudD) | Shazam intégré — clé gratuite sur https://dashboard.audd.io |
| `YT_API_KEY` | Recherche YouTube (API officielle) | Recherche de morceaux |
| `GEMINI_API_KEY` | Génération de prompts/pochettes/titres IA | Fonctions IA (CoverGenerator, prompts Suno, titres) |
| `DEMUCS_MODEL` / `DEMUCS_MODEL_*` | Choix du modèle Demucs | Optionnel — défaut raisonnable sinon |
| `DEREVERB_PYTHON` / `DEREVERB_WORKER` | Interpréteur/worker dé-réverbération | Optionnel |
| `ANALYZER_WORKER` | Interpréteur worker d'analyse | Optionnel |
| `PORT` | Port du backend (défaut 3001) | Optionnel |

Un `client_secret_*.json` (téléchargé depuis Google Cloud Console) peut aussi être utilisé à la place de `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` selon la configuration — voir `routes/auth.js`. Ces fichiers et `.env` sont volontairement exclus du dépôt (`.gitignore`) : à recréer localement, jamais à committer.

## Nettoyage des fichiers générés

Les mashups/stems/téléchargements temporaires (`backend/tmp/`, `backend/cache/`, `backend/data/outputs/`) sont exclus du dépôt et peuvent grossir avec l'usage. Nettoyage automatique à la fermeture propre du serveur (Ctrl+C), ou à la demande via le bouton 🧹 du Mixer (`POST /api/cleanup`).

## Dossier `diagnostic/`

Contient l'historique des audits internes du projet (sécurité, architecture, bugs corrigés) — utile pour retrouver le contexte d'une décision technique avant d'y retoucher.
