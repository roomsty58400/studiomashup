# Spec — MACHEUPDJ (console DJ 2 decks façon VirtualDJ)

30 juillet 2026. Cadrage initial avant développement — à faire évoluer au fil de l'implémentation, même esprit que `spec-mashup-editor-timeline.md`.

## Contexte

Demande : une nouvelle page "MACHEUPDJ", à côté des pages existantes (Mixer/Decks A-B, Clip Editor, Mashup Wheel), qui reprend le visuel et les fonctions d'une vraie console DJ façon VirtualDJ (capture d'écran fournie) — 2 decks avec jog wheel, FX, pads (Stems 2.0 / hotcues / slicer / sampler), boucle, et une section centrale MASTER (volume, casque, effet master, crossfader, enregistrement/diffusion).

Constat technique décisif (cf. discussion de cadrage) : une bonne partie de ces fonctions — scratch, FX en temps réel, pitch fader, boucle précise — nécessitent un accès direct au signal audio décodé via Web Audio (`AudioBufferSourceNode`, `GainNode`, etc.). C'est possible pour un fichier **uploadé**, mais **impossible pour une piste YouTube jouée via l'iframe** (l'API YouTube ne donne accès qu'à play/pause/seek/volume, jamais au flux audio brut). Le Deck.jsx actuel (Decks A-E, Mixer) est construit autour de la recherche YouTube — MACHEUPDJ a donc besoin d'un moteur de lecture différent, pas juste d'un nouvel habillage visuel sur le Deck existant.

**Décision de cadrage (30/07)** : MACHEUPDJ cible **l'upload local en priorité** — c'est la seule façon d'avoir la vraie expérience (scratch/FX/pitch/boucle précise). YouTube reste éventuellement possible plus tard, en mode dégradé (transport + cue par seek uniquement, jamais de scratch/FX/pitch), mais n'est pas dans le scope v1.

## Existant réutilisable

- **Séparation 4 stems** (`separateStemsFull`, déjà branchée pour ClipEditor/FadrMacheUp) — réutilisable telle quelle pour le panneau "Stems 2.0" (voix/batterie/basse/autres).
- **Pattern solo/mute par stem** (ComboPanel.jsx) — logique déjà éprouvée (5 états : solo A / solo B / les deux / muet), à adapter en mute/solo simple par stem et par deck (pas de "provenance A/B" ici, chaque deck a ses propres stems).
- **Moteur pitch/tempo temps réel** (`soundtouchjs`, déjà utilisé dans ComboPanel pour 2 sources simultanées) — réutilisable pour le fader de pitch.
- **`AudioBufferSourceNode.loop`/`loopStart`/`loopEnd`** (natif Web Audio, précision à l'échantillon) — pas encore utilisé dans l'app, mais c'est le mécanisme standard pour une boucle DJ propre.
- **Pattern de page + routage** (`App.jsx` : un fichier par page dans `pages/`, import + rendu conditionnel) — MacheupDJ.jsx suit le même schéma que MashupWheel.jsx/ClipEditor.jsx.

## Décisions de cadrage (30/07)

- **Nouvelle page à côté** des pages existantes — aucune régression sur Decks/ComboPanel/Mixer/Clip Editor/Mashup Wheel.
- **Upload local prioritaire** pour la v1 — c'est la condition pour avoir un vrai scratch/FX/pitch. YouTube hors scope v1 (cf. plus haut).
- **Périmètre v1 = "cœur du mixage"** (choix retenu parmi 3 options) :
  - **Dans v1** : 2 decks upload, jog wheel + scratch, fader de pitch, boucle (IN/OUT), hot cues, Stems 2.0 (mute/solo par stem, par deck), crossfader + section master (volume, VU-mètres).
  - **Plus tard (P1/P2)** : slicer, sampler, FX par deck (flanger etc.), enregistrement/diffusion (ENR/BCAST), onglet Vidéo/Scratch vidéo, cue casque séparé.

## Objectifs (v1)

1. Charger un fichier audio local sur chacun des 2 decks et le manipuler comme sur une vraie platine (scratch, pitch, boucle, cue).
2. Séparer chaque deck en 4 stems et pouvoir couper/isoler chacun indépendamment pendant la lecture (Stems 2.0).
3. Mixer les 2 decks en direct via un crossfader + un volume master, avec un vrai retour visuel (VU-mètres).
4. Poser une architecture audio (Web Audio pur, buffers décodés) qui n'interdit pas d'ajouter FX/slicer/sampler/enregistrement en v2 sans tout réécrire.

## Non-objectifs (v1)

- **Lecture YouTube** — upload local uniquement (cf. contrainte technique ci-dessus). Pourra être ajoutée en mode dégradé (sans scratch/FX/pitch) si le besoin se confirme à l'usage.
- **Kick / HiHat séparés** — la capture VirtualDJ montre 5 pads (Vocal/Instru/Bass/Kick/HiHat), mais le pipeline Demucs de l'app est calé sur 4 stems (voix/batterie/basse/autres) depuis le retrait du mode 6-stems (juillet 2026, cf. `services/demucs.js`). Séparer batterie → kick + hi-hat demande un modèle dédié supplémentaire, hors scope v1 — les pads v1 seront Vocal/Batterie/Basse/Autres (4, pas 5).
- **FX par deck** (flanger, etc.) — v2. Architecturalement compatible (Web Audio permet d'insérer des filtres dans la chaîne), juste pas construit en v1.
- **Slicer / Sampler** — v2.
- **Enregistrement / diffusion (ENR/BCAST/FICHIER)** — v2. Le mix final (sortie du crossfader/master) est techniquement enregistrable via `MediaRecorder` sur le flux Web Audio ; la diffusion pourrait réutiliser l'infra radio existante (`backend/routes/radio.js`) — à évaluer en v2, pas conçu en détail ici.
- **Cue casque séparé du master** — nécessite `AudioContext.setSinkId()` (support navigateur inégal) pour sortir sur 2 périphériques audio différents en simultané ; pas fiable partout, écarté de la v1.
- **Onglet Vidéo** (visible dans la capture, à côté d'Audio/Scratch/Master) — hors scope v1, cette page reste centrée audio.

## User stories

- Je veux glisser un fichier audio sur le deck A et un autre sur le deck B, comme sur une vraie platine.
- Je veux poser un doigt (glisser la souris) sur le jog wheel pour scratcher — le son doit suivre le mouvement, pas juste sauter.
- Je veux régler le pitch (+/- %) d'un deck avec un fader vertical, et entendre le changement en temps réel.
- Je veux poser un point de boucle IN et un point OUT, et que le deck boucle proprement entre les deux sans clic ni décalage.
- Je veux poser des hot cues (jusqu'à quelques points par deck) et y sauter instantanément en cours de lecture.
- Je veux couper/isoler la voix, la batterie, la basse ou le reste de chaque deck en cours de lecture (Stems 2.0), pour préparer une transition ou un mashup live.
- Je veux un crossfader qui bascule progressivement le volume entre A et B, et un volume master qui contrôle la sortie globale.
- *Cas limite* : lancer le scratch/la boucle avant que la séparation des stems soit terminée doit rester possible (le deck joue déjà le fichier brut pendant que Demucs tourne en tâche de fond) — pas d'attente bloquante.
- *Cas limite* : charger un 2e fichier sur un deck déjà en train de jouer doit couper proprement l'ancien (pas de superposition ni de fuite audio).

## Exigences

### P0 — sans ça la page n'a pas de sens

- Nouvelle page/route MACHEUPDJ, visuellement proche de la capture (2 decks + bandeau master central).
- Moteur audio par deck en Web Audio pur (`AudioBufferSourceNode` sur un buffer décodé du fichier uploadé) — pas de `<audio>`/iframe YouTube pour cette page.
- Jog wheel : cercle animé qui tourne pendant la lecture (vitesse liée au tempo/pitch), et réagit au clic-glissé (scratch : modulation de `playbackRate` + repositionnement, proportionnelle au mouvement de souris).
- Fader de pitch (+/- %, comportement vinyle classique : le tempo ET la hauteur changent ensemble via `playbackRate`, pas de key-lock indépendant en v1).
- Boucle : boutons ENTRÉE/SORTIE posent les bornes sur le buffer en cours, lecture en boucle native (`loop`/`loopStart`/`loopEnd`).
- Hot cues : quelques points mémorisables par deck, saut instantané au clic.
- Stems 2.0 : séparation 4 stems automatique en tâche de fond dès le chargement (réutilise `separateStemsFull`), 4 pads mute/solo (voix/batterie/basse/autres) actifs en cours de lecture.
- Crossfader + volume master, mixage réellement live (`GainNode` par deck + master), pas un paramètre de génération après coup.
- VU-mètres simples (niveau de sortie de chaque deck / du master).

### P1 — probable fast-follow, pas bloquant pour une v1 utilisable

- FX par deck (au moins un : flanger ou filtre, avec 1-2 knobs).
- Slicer.
- Sampler (pads déclenchant des sons courts).
- Enregistrement du mix (MediaRecorder sur la sortie master).
- Mode YouTube dégradé (transport + cue par seek, sans scratch/FX/pitch, avec un badge clair indiquant les fonctions désactivées).

### P2 — hors scope v1, à ne pas fermer architecturalement

- Diffusion en direct (BCAST), en s'appuyant sur l'infra radio existante.
- Onglet Vidéo / scratch vidéo.
- Cue casque séparé du master.
- Kick/HiHat séparés (nécessiterait un modèle de séparation percussion dédié, au-delà de Demucs 4-stem).

## Critères de réussite (outil perso, pas de métriques d'entreprise)

- Tu peux charger 2 fichiers, scratcher/boucler/poser des cues sur chacun, couper/isoler leurs stems, et les mixer au crossfader — sans détour par le Mixer/ComboPanel existant.
- Le scratch et la boucle sonnent propres (pas de clic, pas de décalage perceptible) sur un fichier uploadé.
- Charger un nouveau fichier sur un deck déjà actif ne laisse aucune fuite audio (ancien buffer proprement arrêté/déconnecté).

## Décisions résolues (30/07)

- **Pitch fader = comportement vinyle classique** : tempo et hauteur liés via `playbackRate`, pas de key lock en v1 (correspond à l'affichage "+0.0%" de la capture). Le key lock (tonalité fixe malgré le changement de tempo, via soundtouchjs) reste une option P1 si le besoin se confirme à l'usage.
- **4 hot cues par deck** — standard CDJ/MPC, suffisant pour repérer intro/couplet/refrain/outro sans surcharger l'interface.

## Questions ouvertes

- **[Ingénierie, à trancher en phase 1]** Le scratch (modulation de `playbackRate` en temps réel proportionnelle au mouvement de souris) demande un prototype dédié avant d'habiller le reste de la page — c'est le seul vrai inconnu technique du projet (le reste — boucle, cues, stems, crossfader — s'appuie sur des mécanismes Web Audio standards ou déjà éprouvés ailleurs dans l'app).

## Phasage suggéré

1. **Prototype scratch** — dérisquer en premier le seul inconnu technique (jog wheel + `playbackRate` + repositionnement), sur un deck minimal sans le reste de l'habillage.
2. **Moteur 2 decks** — chargement upload, lecture Web Audio pure, pitch fader, boucle, hot cues, sur les 2 decks.
3. **Stems 2.0** — branchement `separateStemsFull` + pads mute/solo par stem et par deck.
4. **Master** — crossfader réel (GainNode), volume master, VU-mètres, habillage visuel final façon capture.
5. **P1** — FX par deck, slicer, sampler, enregistrement, puis évaluation du besoin YouTube dégradé selon l'usage réel de la v1.
