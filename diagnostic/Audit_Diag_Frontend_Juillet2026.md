# Audit diagnostic — pages frontend StudioMashup (25 juillet 2026, v2 — analyse ultra approfondie)

Deuxième passage, bien plus profond que le premier : relecture intégrale (pas d'extraits) de `Deck.jsx` (1203 lignes), `Mixer.jsx` (902), `ComboPanel.jsx` (924), `ClipEditor.jsx` (996), `MashupWheel.jsx` (345), `DjAssistModal.jsx` (377), `CoverGenerator.jsx`, `TopBar.jsx`, `MashupProgressModal.jsx`, `RadioPlayer.jsx` (extraits ciblés), croisé avec le backend (`routes/mashup.js`, `services/ffmpeg.js`). Classé par impact réel.

## 1. Bug critique trouvé et corrigé : race condition sur le polling de `Deck.jsx`

**C'est la découverte la plus importante de cette passe.** `DjAssistModal.jsx` contient un commentaire très détaillé (juillet 2026) documentant un bug déjà diagnostiqué et corrigé : les boucles de polling (`setTimeout` récursif suivant l'état d'un job côté serveur) utilisaient un simple booléen partagé (`pollingRef`) pour empêcher de LANCER un 2e polling en parallèle, mais ne coupaient jamais une boucle déjà en vol. Si l'utilisateur change de morceau pendant qu'une analyse tourne encore, l'ancienne boucle continue d'écrire dans le même state — un résultat périmé peut écraser l'affichage du nouveau morceau, ou le bloquer indéfiniment sur "en cours".

Le correctif retenu (compteur de génération, `generationRef`) a bien été appliqué à `MashupWheel.jsx` et `DjAssistModal.jsx` — **mais jamais reporté sur `Deck.jsx`**, alors que c'est le composant le plus central de toute l'appli (chargé 2 à 5 fois par écran, utilisé partout). `Deck.jsx::pollAnalyze` (BPM/clé/structure) et `Deck.jsx::pollStems` (voix/instru FLAC) avaient exactement la même vulnérabilité : sélectionner rapidement un 2e morceau pendant que l'analyse du 1er tourne encore pouvait faire réapparaître un BPM/clé/badge stems du morceau précédent sur le nouveau, ou bloquer un bouton sur "⏳ en cours" pour de bon. `ClipEditor.jsx::pollJob` avait le même trou (changer de clip pendant une extraction en cours).

**Corrigé aujourd'hui** : le même mécanisme `generationRef` (déjà éprouvé dans ce projet) a été ajouté à `Deck.jsx` (incrémenté dans `handleSelect`/`handleFileChange`/`handleClear` — pas dans les boutons "réessayer", qui restent valides pour le même morceau) et à `ClipEditor.jsx::pollJob`. Vérifié via `esbuild` — passe.

**Non corrigé, même famille, priorité plus basse** : `RadioPlayer.jsx::pollRecordStatus` (enregistrement radio) a le même trou — impact plus faible (un seul flux à la fois, fonctionnalité annexe), laissé tel quel pour l'instant mais à corriger si un jour un souci de badge périmé est signalé dessus.

## 2. Bugs / incohérences confirmés (1ère passe, toujours valides)

### 2.1 Code mort : `components/MashupStudio.jsx`
Toujours non importé nulle part (vérifié à nouveau) — à supprimer.

### 2.2 Réglages manuels (pitch/tempo) désactivent la vidéo sans le dire
Confirmé et précisé : dans `Mixer.jsx`, tout ce cadre est en réalité **masqué en dur** (`const SHOW_ADVANCED_SETTINGS = false`, ligne 39 — retour utilisateur "je ne m'en sers pas") donc inaccessible par ce chemin. Le seul chemin RÉEL vers `tempoRatioOverride`/`pitchShiftOverride` aujourd'hui est la section "Réglages avancés" de `ComboPanel.jsx` (mode à la carte, repliable). Le problème reste entier : aucun message n'y prévient que ce réglage supprime la génération vidéo (`routes/mashup.js` : `if (canMp4 && tempoRatioOverride == null)`).

### 2.3 `silentUrl` récupéré puis jamais affiché — confirmé, inchangé.

## 3. Nouveau : petits détails glanés dans cette 2e passe

- **`TopBar.jsx` ligne 206** : le bouton "⚙ SET" (Paramètres) n'a **aucun `onClick`** — bouton mort, clic sans aucun effet. Purement cosmétique tant qu'aucune page Réglages n'existe, mais à netttoyer (retirer ou câbler) pour éviter la confusion.
- **`Deck.jsx`** : la logique `waitingForAnalysis` (ligne ~1056) calcule un booléen par triple négation (`!isDone && !isRunning && !isError`) au lieu de simplement `stemsStatus === "idle"` — correct, mais illisible ; nitpick de style, pas un bug.
- **`MashupWheel.jsx`/`DjAssistModal.jsx`** : code exemplaire sur ce point précis — le commentaire qui documente l'échec d'un 1er correctif (`cancelledRef` booléen, insuffisant à cause du double-montage React StrictMode) avant d'arriver à la solution `generationRef` est une référence utile si ce genre de bug réapparaît ailleurs.
- **`CoverGenerator.jsx`, `Footer.jsx`** : rien à signaler — composants autonomes, pas d'appel réseau à risque (Footer) ou logique déjà propre (CoverGenerator).

## Priorités mises à jour

1. ~~Corriger la race condition de polling dans `Deck.jsx`/`ClipEditor.jsx`~~ — **fait aujourd'hui.**
2. Avertissement UI réglages manuels (ComboPanel) → pas de vidéo générée.
3. Suppression de `components/MashupStudio.jsx` (dead code).
4. Câbler ou retirer le bouton "⚙ SET" de la TopBar.
5. (Optionnel, faible priorité) Reporter le même correctif `generationRef` sur `RadioPlayer.jsx::pollRecordStatus`.
