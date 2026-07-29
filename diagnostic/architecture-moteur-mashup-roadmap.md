# Roadmap technique — moteur de mashup StudioMashup

Document de cadrage rédigé à partir d'un cahier des charges complet (style "moteur RaveDJ local, Android + PC") fourni par l'utilisateur, confronté à l'état réel du code de StudioMashup au 24/07/2026.

**Cadrage retenu** (décidé avec l'utilisateur avant rédaction) :
- Livrable = document d'architecture, pas de code écrit dans cette passe.
- Portée Android = vision future, non engagée maintenant. On reste sur la stack actuelle (Node.js/Express + React + Python/librosa/Demucs + ffmpeg).
- Priorité = optimiser et compléter le pipeline de traitement existant avant d'ajouter de nouvelles capacités IA (vidéo, gestes, recherche sémantique...).

Le cahier des charges original est très large (20 sections). Plutôt que de le paraphraser section par section, ce document part de **ce qui existe déjà** dans le code, identifie **les écarts réels**, et propose une **roadmap en phases** — chaque phase livrable indépendamment, sans réécriture.

---

## 1. État des lieux — mapping cahier des charges → code existant

| Module du cahier des charges | État dans StudioMashup | Fichiers concernés |
|---|---|---|
| Import média (formats, extraction) | ✅ Fait pour l'essentiel (YouTube via yt-dlp, upload probable) — extraction audio robuste avec repli si format déjà cible | `services/ytdlp.js`, `services/ffmpeg.js` (`extractAudio`) |
| Analyse audio — BPM/tempo/beats | ✅ Fait (Librosa `beat_track`, grille de beats complète) | `services/analyzer.js`, `services/workers/analyzer_worker.py` |
| Analyse audio — structure (intro/couplet/refrain...) | ⚠️ Partiel — segmentation par énergie/timbre (clustering agglomératif), 3 labels (`low/mid/high`), pas de sémantique verse/chorus/drop | `analyzer_worker.py::analyze_track` |
| Détection clé musicale / Camelot / mode | ✅ Fait (Krumhansl-Schmuckler, confiance mesurée) | `analyzer.js`, `services/ffmpeg.js` (transposition) |
| Analyse fréquentielle (FFT/MFCC/chroma) | ✅ Fait (MFCC, chroma_cens, chroma_cqt, centroïde spectral) | `analyzer_worker.py` |
| Détection kicks/snares/hi-hats individuels | ❌ Absent (on a l'énergie RMS globale, pas la détection d'onset par instrument) | — |
| Détection drops/breaks/silences explicite | ❌ Absent (proxy indirect via les niveaux d'énergie de `structure`) | — |
| Danceability / groove | ❌ Absent | — |
| Score de compatibilité audio (BPM/clé/énergie/structure/spectral) | ✅ Fait, avec pondération justifiée et verrou anti-décrochage vocal | `services/scoring.js` |
| Time-stretch sans changement de hauteur | ✅ Fait (rubberband si compilé dans ffmpeg, repli atempo) | `services/ffmpeg.js` (`safeTempoRatio`, `buildTempoSchedule` — correction même PAR SEGMENT) |
| Pitch-shift ±6 demi-tons, formants préservés | ✅ Fait (rubberband `formant=preserved`, budget auto ±2, manuel jusqu'à ±6) | `services/ffmpeg.js` |
| Beat matching (alignement temps/mesures) | ✅ Fait pour la voix vs l'instru (délai calé sur mesure entière, ancrage sur un vrai beat détecté) | `services/ffmpeg.js` (`buildTempoSchedule`), `routes/mashup.js` (`snapToMeasureBoundary`) |
| Crossfades / filtres / sidechain / automation | ✅ Fait et déjà assez avancé (loudnorm 2-passes, sidechain multibande, glue compressor, de-ess, EQ de présence) | `services/ffmpeg.js` (`mixFullRave`, `mixFullRaveDuo`) |
| **Analyse vidéo (cuts, mouvement, IA de contenu)** | ❌ **Absent quasi totalement** | — |
| **Sync cuts vidéo sur kick/snare/drop** | ❌ **Absent** — montage vidéo actuel = segments de durée fixe (6–14s) qui alternent A/B, sans lien avec le contenu musical réel | `services/ffmpeg.js` (`buildAlternatingFilter`) |
| Effets vidéo (flash, zoom, speed ramp, glitch...) | ❌ Absent (seul un fondu `xfade=fade` existe) | `services/ffmpeg.js` |
| IA de sélection des meilleurs passages | ⚠️ Existe côté **audio** uniquement (segment "high energy" choisi pour la voix, cf. `pickBestSegmentPair`), rien côté vidéo | `routes/mashup.js` |
| Construction narrative (intro/montée/drop/climax) | ❌ Absent — le mashup actuel est un mix continu, pas une structure narrative pilotée | — |
| Multi-sources (3, 4, 5 morceaux) | ⚠️ Partiel — jusqu'à 2 pistes voix + 1 instrumental composite en mode "à la carte" (4/6 stems), pas de N morceaux génériques | `services/ffmpeg.js` (`alignAndCombineStems`, `mixFullRaveDuo`) |
| Rendu multi-résolution/codec | ⚠️ Partiel — 1920×1080 fixe, H.264 (NVENC ou libx264), pas de 4K/AV1/HEVC | `services/ffmpeg.js` (`ENCODE_GPU`/`ENCODE_CPU`) |
| Prévisualisation temps réel / timeline éditable | ❌ Absent — génération = boîte noire, pas d'édition manuelle après coup | — |
| Cache des analyses | ✅ Fait et robuste (SQLite, vérification d'existence disque avant confiance au cache) | `db/schema.sql`, `db/index.js`, `routes/analyze.js` |
| Multithreading / GPU / workers persistants | ✅ Fait (juste renforcé cette session — worker Python persistant pour Librosa et Demucs, files GPU/CPU dédiées) | `services/workerPool.js`, `services/gpuQueue.js`, `services/cpuQueue.js` |
| Séparation de stems (voix/batterie/basse/instruments) | ✅ **Déjà fait** — le cahier des charges le liste en section 20 "futur", mais c'est déjà l'un des modules les plus aboutis de StudioMashup (Demucs, modes 2/4/6 stems, mashup "à la carte" par stem) | `services/demucs.js`, `routes/analyze.js`, `components/ComboPanel.jsx` |
| Lyrics sync, gestes/poses, recherche sémantique, transitions IA, export projet éditable, Android | ❌ Absent — vision long terme, cf. section 6 | — |

**Lecture de ce tableau** : le pipeline **audio** est déjà proche de ce que décrit le cahier des charges (parfois plus avancé — la correction de tempo par segment ou le verrou anti-décrochage vocal n'ont pas d'équivalent explicite dans le document fourni). Le vrai écart est **presque entièrement côté vidéo** : StudioMashup sait aujourd'hui produire un montage alterné à durée fixe, mais ne regarde jamais le contenu réel des vidéos ni le contenu musical pour décider où couper.

---

## 2. Architecture modulaire cible

Le cahier des charges demande une architecture modulaire ; c'est déjà globalement le cas côté backend (chaque fichier de `services/` a une responsabilité unique). Proposition pour formaliser et étendre proprement, sans tout réécrire :

```
backend/
  services/
    import/              (existant : ytdlp.js, ffmpeg.js::extractAudio)
    audio-analysis/       (existant : analyzer.js + analyzer_worker.py)
      └─ NOUVEAU : onset-detection (kicks/snares), danceability
    video-analysis/        ★ NOUVEAU MODULE
      └─ scene-detection.js   (ffmpeg scdet / freezedetect)
      └─ motion-analysis.js   (optical flow léger, ffmpeg vectorscope/signalstats)
      └─ (futur) content-ai.js (détection visage/scène via modèle local)
    compatibility/        (existant : scoring.js — à étendre avec un sous-score vidéo)
    sync/                  ★ NOUVEAU MODULE
      └─ beat-grid.js       (déjà les briques dans ffmpeg.js — à extraire/formaliser)
      └─ video-cut-planner.js (décide OÙ couper la vidéo selon la grille de beats)
    stems/                (existant : demucs.js, dereverb.js)
    mixing/                (existant : ffmpeg.js — mixFullRave/mixFullRaveDuo/alignAndCombineStems)
    video-generation/      ★ NOUVEAU MODULE (remplace buildAlternatingFilter par un planner piloté par la musique)
    export/                (existant : ffmpeg.js — exportMP3/FLAC/MP4)
    cache/                 (existant : db/index.js + vérification disque)
    workers/               (existant : workerPool.js, gpuQueue.js, cpuQueue.js — pattern à réutiliser pour tout nouveau traitement lourd)
```

Principe directeur (déjà appliqué avec succès pour Demucs/Librosa cette session) : **tout traitement lourd et répétitif passe par un worker persistant** (`PersistentWorker`, cf. `workerPool.js`) plutôt qu'un process relancé à chaque appel. C'est le mécanisme qui donnera le plus de gain pour les futurs modules vidéo (charger un modèle de détection de scène/visage une seule fois, pas à chaque vidéo).

---

## 3. Roadmap priorisée

### Phase 0 — Fiabilité (fait cette session)
- Worker Demucs persistant réparé (résolution robuste de l'interpréteur Python, mirroring `analyzer.js`).
- Détection CUDA fiabilisée (timeout 8s → 25s, causait des faux repli CPU).

### Phase 1 — Optimisation du pipeline audio existant (priorité immédiate)
Objectif : réduire encore les temps de traitement et la dette technique, sans nouvelle fonctionnalité visible.

1. **Analyse incrémentale réelle.** Actuellement, changer de `stemMode` (2→4→6) relance une séparation Demucs complète même si la voix a déjà été isolée dans un mode antérieur. Piste : ne recalculer QUE les stems manquants du nouveau mode quand c'est possible (ex. mode 4→6 : `vocals/drums/bass/other` sont déjà bons, seuls `guitar/piano` manquent — mais Demucs ne permet pas d'extraire un sous-ensemble a posteriori avec un modèle différent, donc ce point demande d'abord de vérifier si `htdemucs_6s` peut réutiliser un stem déjà calculé ; sinon, au minimum, prévenir l'utilisateur du coût avant de relancer).
2. **Nettoyage du code mort.** `services/mashupEngine.js` est un stub obsolète (`amix` 50/50 sans crossfade) totalement supplanté par `mixFullRave`/`mixFullRaveDuo` dans `ffmpeg.js` — à supprimer pour éviter toute confusion future.
3. **Étendre le pattern worker persistant au dé-reverb** (`dereverb.js`) — vérifié dans cette session : ce module spawn encore un process Python par appel (`PersistentWorker`/`registerWorker` absents du fichier), donc il paie le rechargement complet de son modèle à chaque utilisation, exactement le problème déjà résolu pour Demucs et Librosa. Même gain attendu.
4. **Mutualiser `resolveDemucsPython`/`resolvePythonCmd`.** Deux implémentations quasi identiques existent maintenant (`demucs.js`, `analyzer.js`) — à factoriser dans un module partagé (`services/pythonResolver.js`) pour que le prochain module Python (ex. futur `content-ai.js`) en bénéficie automatiquement.
5. **Réévaluer la sérialisation stricte A→B** dans `routes/mashup.js` (actuellement tout le pipeline de la piste A tourne avant celui de B, à cause d'un bug de collision yt-dlp déjà rencontré). Piste sûre : isoler chaque téléchargement yt-dlp dans un répertoire de travail dédié (`--paths` yt-dlp) pour supprimer la cause du bug plutôt que la conséquence, ce qui permettrait de reparalléliser A/B sans risque.

### Phase 2 — Compléter l'analyse audio (structure musicale plus fine) ✅ fait (24/07/2026)
Le cahier des charges veut intro/couplet/refrain/pont, drops, kicks/snares individuels. Réalisé en pur Librosa (déjà dans le pipeline), sans nouvelle dépendance lourde :
- **Onset detection par bande de fréquence** (`librosa.onset.onset_detect` sur les basses ≈ kick 20-150Hz, sur 150Hz-6kHz ≈ snare/hi-hat) — `kick_times`/`snare_times`, nouveaux champs à côté de `beat_times` déjà exporté. Implémenté dans `analyzer.js` ET `analyzer_worker.py` (logiquement identiques), persistés en base (`kick_times_json`/`snare_times_json`). Testé en conditions réelles : 573 kicks / 546 snares détectés sur un morceau de 200s (16s de calcul via le worker persistant déjà chaud).
- **Détection de drop** : pic brutal de la DÉRIVÉE du RMS lissé (~0.5s), avec seuil sur le niveau atteint — champ `drops`/`drops_json`. Testé en conditions réelles : 18 drops détectés sur le même morceau. ⚠️ Réglage à affiner à l'usage : la fréquence observée (~1 tous les 11s) suggère un seuil probablement trop permissif pour un vrai "drop" au sens EDM — capte aussi des montées de refrain/pont. Fonctionnellement correct, tuning à revisiter si le signal se montre trop bruité en pratique.
- **Labels sémantiques de structure** (intro/couplet/refrain) : toujours non fait — nécessiterait un modèle dédié (`msaf` ou classifieur léger), à ne considérer que si le proxy énergie/timbre actuel se montre limitant en pratique.

### Phase 3 — Module d'analyse vidéo ✅ fait (24/07/2026, sans les items IA)
C'était la partie qui manquait le plus par rapport au cahier des charges. Livré **sans aucun modèle IA/GPU vidéo** — uniquement des filtres ffmpeg déjà disponibles, conformément au plan initial.

1. **Détection de coupes/scènes** ✅ — `services/videoAnalysis.js::detectSceneCuts()`, basé sur `ffmpeg -vf "select='gt(scene,0.4)',showinfo"`. Testé en conditions réelles sur une vraie vidéo 1080p/175s du cache : 41 coupures détectées en 1.7s.
2. **Rythme visuel** ✅ — `visualRhythm()` (cuts/seconde, durée de plan moyenne), dérivé trivialement des coupures détectées.
3. **Détection de segments figés** ✅ (scope réduit) — `detectFrozenSegments()` via le filtre `freezedetect` (repère les plans statiques/gelés à éviter). Le "vectorscope/mouvement global en continu" évoqué initialement n'a PAS été implémenté (aurait demandé un post-traitement notable des logs `signalstats` frame-par-frame sans bénéfice clair pour le planner de coupes) — seul le repérage des segments figés (exclusion) a été retenu, suffisant pour l'usage réel (éviter un extrait plat).
4. **Sync cuts vidéo ↔ musique** ✅ — `services/videoCutPlanner.js::planMusicSyncedCuts()` : durée de segment calée sur le beat grid réel (`beat_times`, arrondie à la mesure 4/4 la plus proche), position de départ dans chaque vidéo source accrochée à la coupure de plan détectée la plus proche (± 1.5s). `services/ffmpeg.js::buildAlternatingFilter` généralisé en `buildFilterFromPlan` (accepte un plan de segments explicite) — refactor **strictement rétro-compatible** (l'ancien montage à durée fixe passe désormais par cette même fonction générique, avec un plan équivalent à l'ancien calcul, donc zéro changement de comportement pour l'existant). `buildSilentVideoMontage` accepte un paramètre optionnel `musicSync` ({beatTimes, structure}), avec repli automatique et silencieux vers l'ancien montage à durée fixe si les données manquent ou si la détection de scène échoue/timeout. Câblé dans `routes/mashup.js` (modes "full" et "stems") — utilise la piste voix comme référence rythmique. Testé en conditions réelles (planner + détection scène sur vidéo 1080p réelle).

Non fait dans cette passe (hors scope initial, cf. Phase 4) : narration structurée intro/montée/drop/climax pilotée par `structure`/`drops` — le planner actuel cale les COUPURES sur le beat grid, mais ne module pas encore le RYTHME du montage (segments plus courts/dynamiques) selon les sections d'énergie ou les drops détectés en Phase 2. Piste naturelle pour une itération suivante, une fois observé à l'usage.

### Phase 4 — IA de contenu vidéo (visage/scène/danse/pyrotechnie...)
Ce que demande le cahier des charges en section 3 ("détection du chanteur, visage, groupe, danse, pyrotechnie...") nécessite un vrai modèle de vision (détection d'objets/visages), donc une dépendance GPU supplémentaire côté vidéo (aujourd'hui le GPU est déjà sollicité par Demucs/dé-reverb — `gpuQueue.js` devra arbitrer un 3ᵉ consommateur). À ne considérer qu'après la Phase 3, une fois qu'on sait déjà couper juste sur la seule base des scènes/rythme — l'IA de contenu n'est un gain net que si la Phase 3 est déjà solide, sinon elle ajoute de la complexité sans bénéfice mesurable.

### Phase 5 — Multi-sources génériques (3 à 5 morceaux) ✅ backend + interface faits (24/07/2026)
Le moteur de combinaison (`alignAndCombineStems`, `combineTracks`) était en réalité **déjà générique pour N pistes** — aucune modification nécessaire. Le vrai travail était côté ROUTE et vidéo, tous deux strictement câblés pour 2 sources (A/B) :

- **`services/trackPreparation.js`** (nouveau) : extraction des helpers PURS de `routes/mashup.js` (scoring `pickBestSegmentPair`, `snapToMeasureBoundary`, `parseStructure`/`parseBeatTimes`, `normalizeStemMode`/`nonVocalPartsForMode`, `resolveOutputPath`) — logique strictement inchangée, juste rendue réutilisable. `prepareTrack` (le chemin "à froid" — téléchargement + Demucs + dé-reverb, ~200 lignes) n'a **volontairement PAS** été touché ni extrait : trop risqué de modifier le chemin le plus utilisé de l'app pour ce premier jet. Non-régression vérifiée en conditions réelles (import du module complet sans erreur).
- **`services/videoCutPlanner.js::planMultiSourceCuts`** + **`services/ffmpeg.js::buildMultiSourceVideoMontage`** (nouveaux, additifs) : généralisation du planner Phase 3 et du montage vidéo à N sources en round-robin (au lieu de 2 en alternance stricte). `buildFilterFromPlan` (Phase 3) généralisé pour calculer dynamiquement l'indice ffmpeg du watermark (`[N:v]` au lieu de `[2:v]` fixe) — corrige un bug latent qui aurait cassé le watermark sur tout montage à N≠2 sources.
- **`routes/mashupMulti.js`** (nouveau, `POST /api/mashup-multi`) : mashup "à la carte" à 3-5 morceaux — `stemSelection` par INDEX (0..N-1) au lieu de "A"/"B". Route strictement additive, montée sur un préfixe dédié (`/api/mashup-multi`, pas `/api/mashup`) pour zéro risque de collision avec les routes existantes.
- **Choix de scope délibéré** (décision utilisateur, "backend d'abord") : cette route EXIGE que chaque piste référencée soit déjà analysée/séparée (même mode 4/6 stems) — pas de téléchargement/Demucs "à froid" ici. Une piste non prête retourne une erreur explicite plutôt qu'un ré-essai automatique. C'est un choix cohérent avec le flux existant (chaque piste passe déjà par un Deck avant d'être utilisable dans un mashup).
- **Interface (24/07/2026, additive)** : nouvel écran séparé `frontend/src/pages/MashupMultiStudio.jsx` (onglet "🧬 MULTI" dans TopBar.jsx), décision explicite après exploration du frontend existant — `Deck.jsx`/`Mixer.jsx`/`ComboPanel.jsx`/`MashupStudio.jsx` (12 fichiers) sont profondément verrouillés sur 2 pistes (state dupliqué xA/xB, crossfader binaire, sélecteur de stems à 4 états A/AB/B/mute) ; les généraliser en profondeur aurait été le changement le plus risqué de cette passe sur le chemin le plus utilisé de l'app. À la place :
  - `Deck.jsx` réutilisé TEL QUEL en N instances (il était déjà conçu par instance) — 2 props optionnelles ajoutées (`label`, `colorKey`), rétrocompatibles, pour découpler l'identifiant unique par deck (`side`, nécessaire pour l'id du lecteur YouTube — collision sinon) du libellé affiché et de la palette cyan/magenta alternée.
  - `MashupProgressModal.jsx` réutilisé TEL QUEL — 1 prop optionnelle ajoutée (`statusUrlBase`, défaut `/api/mashup` inchangé) pour pointer vers `/api/mashup-multi/:id/status` sans dupliquer le composant.
  - Nouveau sélecteur "provenance de chaque stem" (1 parmi N pistes actives par stem Demucs) — version multi-sources simplifiée du sélecteur à 4 états de `ComboPanel.jsx`, qui correspond exactement au contrat index-based de `POST /api/mashup-multi` (`stemSelection: { [part]: index }`).
  - Sélecteurs 3/4/5 pistes et 4/6 stems, slider de fondu, titre, bouton de génération, barre de progression et lecteur du résultat (FLAC/MP4) — tous nouveaux, dans le seul fichier `MashupMultiStudio.jsx`.
  - Hors scope volontaire pour cette passe : génération de pochette IA et titre auto (routes `/api/cover`/`/api/titles` sont 2-pistes spécifiques) — le titre est un simple champ texte pour l'instant.
  - **Vérifié** : syntaxe + résolution des imports (esbuild, parse + bundle réel), logs HMR Vite (rechargements réussis sans erreur sur les 5 fichiers touchés), et re-confirmation en interrogeant directement le serveur Vite en cours d'exécution (HTTP 200 sur les 5 modules). Test de clic bout-en-bout dans un navigateur NON effectué cette session (extension Chrome non connectée, Edge accessible en lecture seule uniquement) — à faire à l'usage ou en connectant l'extension.
- **Testé en conditions réelles (2 passes)** :
  - *Passe 1* : import de `routes/mashup.js` + `routes/mashupMulti.js` sans erreur (non-régression du chemin existant confirmée) ; un premier test de bout en bout sur 3 pistes réelles a échoué au tout premier garde-fou (fichiers de stems introuvables sur le disque) — cause identifiée : `cleanup.js` (qui vide `data/outputs` à chaque démarrage/arrêt du serveur) a été déclenché plusieurs fois par les redémarrages automatiques (`node --watch`) consécutifs aux modifications de fichiers, ce qui a périmé le cache de test. Le garde-fou a réagi exactement comme prévu (erreur claire, pas de plantage). Cette même passe a aussi révélé deux bugs réels sous charge (timeout `execAsync` à 300000ms trop court pour un encodage CPU pur multi-sources, et un crash `EBUSY` non rattrapé dans le `finally` de nettoyage de `tmpDir`) — tous deux corrigés (timeout porté à 900000ms, `rm()` du tmpDir enveloppé dans un `.catch()` avec log d'avertissement, dans `mashup.js` ET `mashupMulti.js`).
  - *Passe 2* (après rafraîchissement des stems et application des deux correctifs ci-dessus) : pipeline rejoué de bout en bout sur 3 pistes réelles (mode 4 stems, vidéos 1080p en cache). Résultat : alignement des stems ✅, mixage ✅, planification du montage vidéo (12 segments / 3 sources) ✅, export FLAC ✅ (fichier produit et stable, ~19.5 Mo), aucun crash, aucun kill prématuré. Le seul point qui n'a **pas** abouti dans la fenêtre de test (18 min) est l'export MP4 final : sur cette machine, le décodage CUDA et l'encodage NVENC échouent tous les deux (limitation matérielle/driver préexistante, non liée à ce chantier), forçant un encodage 100% CPU/libx264 du montage 3 sources (~190s, 12 transitions xfade + watermark) — confirmé encore en cours d'écriture (fichier `silent.mp4` toujours en croissance) plus de 5 minutes après l'expiration du timeout de mon script de test, preuve que l'encodage aurait fini par aboutir mais est simplement trop lent en CPU pur pour ce scénario. Aucun bug de code identifié à ce stade — c'est une limite de performance matérielle, pas une régression introduite par cette phase.
  - **Recommandation** : soit investiguer pourquoi CUDA/NVENC échouent sur cette machine (accélération GPU indisponible alors que le pilote semble présent — anomalie déjà notée séparément avec la détection rubberband), soit réduire la complexity du montage CPU de repli (moins de segments, pas de watermark/marqueurs de debug) pour un scénario "CPU only" dégradé mais rapide.

---

## 4. Vision future (hors scope immédiat, à documenter mais pas construire)

Ces items du cahier des charges restent pertinents à terme mais n'ont pas d'impact sur "optimiser le traitement" — listés ici pour ne pas les perdre :

- **Synchronisation automatique des paroles (lyrics alignment).** Faisable en local avec un modèle d'alignement forcé (ex. whisper + alignment), viendrait enrichir `structure_json` d'un niveau texte.
- **Reconnaissance gestes/poses/chorégraphies.** Nécessite un modèle pose estimation (MediaPipe ou équivalent) — grosse dépendance, à ne considérer qu'après la Phase 4.
- **Recherche sémantique de séquences** ("montre tous les passages avec guitare"). Découle naturellement de la Phase 4 (détection de contenu) + Phase 2 (stems déjà séparés : la présence de guitare est déjà accessible via le stem `guitar` en mode 6 stems).
- **Génération de transitions assistée par IA.** Amélioration incrémentale de la Phase 3 (le planner de coupes pourrait apprendre les préférences plutôt que suivre des règles fixes).
- **Export de projet éditable (JSON/XML).** Techniquement simple une fois qu'un vrai plan de montage existe (Phase 3) — sérialiser ce plan est immédiat ; le vrai travail est le format d'interopérabilité (EDL, FCPXML...) si l'objectif est la compatibilité avec un logiciel de montage tiers.
- **Portage Android (Kotlin/Compose/Media3/FFmpegKit/TensorFlow Lite).** Le plus gros chantier du cahier des charges — mériterait son propre document de cadrage le moment venu. Deux voies possibles à évaluer alors : (a) réécriture native complète comme décrit, ou (b) réutiliser le moteur serveur existant (Node/Python) via une architecture client-serveur locale (le téléphone pilote un petit serveur embarqué ou distant sur le même réseau) — beaucoup moins de travail si le local strict n'est pas une contrainte absolue.
- **Modes DJ / Manuel / IA / Rapide / Qualité.** Ce sont surtout des préréglages de paramètres déjà existants (crossfade, stemMode, budget de pitch-shift manuel) — faisable côté frontend une fois la Phase 3 en place, sans changement moteur.

---

## 5. Recommandation de séquencement

1. Phase 1 (nettoyage + fiabilité) — quelques jours, faible risque.
2. Phase 3 (analyse vidéo par filtres ffmpeg, sans IA) — le meilleur rapport impact/effort, rapproche concrètement StudioMashup de RaveDJ côté visuel.
3. Phase 2 (structure audio plus fine) — en parallèle ou juste après, indépendant de la vidéo.
4. Phase 5 (multi-sources) — une fois 1-3 stabilisées.
5. Phase 4 (IA de contenu vidéo) — seulement si la Phase 3 seule ne suffit pas à l'usage.
6. Vision future (lyrics, gestes, recherche sémantique, Android) — non engagée, à revisiter avec un document dédié le moment venu.

Ce document ne contient aucune modification de code — c'est un plan de travail à valider avant de démarrer l'implémentation de l'une de ces phases.
