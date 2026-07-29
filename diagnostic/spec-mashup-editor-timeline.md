# Spec — Mashup Editor (timeline multi-stems façon Fadr)

30 juillet 2026. Cadrage initial avant développement — à faire évoluer au fil de l'implémentation.

## Contexte

Le studio actuel (Decks A-E + ComboPanel) permet déjà de piocher, pour chaque catégorie de stem (voix/batterie/basse/autres), sa source parmi jusqu'à 5 morceaux — mais toujours en **pistes entières** : impossible de dire "la voix de X à partir de 0:45, en boucle sur 8 mesures, pendant que la batterie de Y tourne en continu depuis le début". C'est exactement ce que permet [Fadr Remix](https://fadr.com/remix) avec sa timeline de clips glissables/rognables/bouclables, synchronisés automatiquement en clé/tempo.

Studiomashup a déjà la quasi-totalité du back nécessaire : analyse BPM/clé/structure automatique et mise en cache par morceau, séparation Demucs en cache, scoring de compatibilité (`MashupWheel`), génération multi-sources (`mashupMulti.js`, 3-5 pistes), et même un moteur de prévisualisation live avec pitch/tempo réellement modifiés dans le navigateur (`soundtouchjs`, déjà utilisé par `ComboPanel.jsx`). Le morceau qui manque vraiment : une **timeline visuelle où chaque stem devient un clip positionnable dans le temps**, pas juste une grille "stem → source".

## Décisions de cadrage (30/07)

- **Nouvelle page à côté** du studio actuel — aucune régression sur Decks/ComboPanel/Mixer, coexistence assumée. Fusion ou remplacement à rediscuter une fois la page validée à l'usage.
- **v1 en "blocs simples"** : chaque clip est un rectangle positionné/dimensionné (position, durée, zone de trim, boucle) — pas de vraie forme d'onde dessinée. Fidélité visuelle façon Fadr en v2 si le concept fait ses preuves.
- **Lecture en temps réel** pendant l'édition (glisser/rogner un clip doit s'entendre immédiatement), en réutilisant TEL QUEL le moteur `soundtouchjs` déjà éprouvé dans `ComboPanel.jsx`.
- **2 clips simultanés en v1** (révisé le 30/07 — capacité identique à l'existant, zéro inconnu technique côté moteur audio). Le plafond doit être une constante de config, pas une paire A/B câblée en dur, pour pouvoir le relever plus tard (3, 5, 7...) sans réécrire le moteur de lecture. Voir décision résolue plus bas.
- **Ajout retenu pour une itération rapprochée** : suggestions IA par *style de remix* (house, lofi, hardstyle...), dans l'esprit du panneau IA·DJA existant (Prudent/Équilibré/Audacieux) mais orienté genre plutôt que niveau d'audace.

## Objectifs

1. Positionner, rogner et boucler un stem dans le temps, indépendamment des autres clips du remix.
2. Garder l'aperçu audio réactif en temps réel pendant la manipulation des clips.
3. Réutiliser au maximum le back existant (analyse, cache stems, scoring, moteur de rendu ffmpeg) plutôt que dupliquer.
4. Zéro régression sur le studio actuel — page séparée.
5. Poser une architecture qui n'interdit pas une v2 "vraies waveforms" sans tout réécrire.

## Non-objectifs (v1)

- **Vraies waveforms dessinées** — blocs simples pour cette version ; prévu en v2 si le concept convainc à l'usage.
- **Bibliothèque de morceaux "libres de droits"** type packs Fadr — Studiomashup pioche sur YouTube/upload, pas de catalogue interne à construire.
- **Remplacement du studio actuel** — coexistence, pas de migration forcée.
- **Édition audio fine par clip** (effets, EQ) — hors scope v1 ; seuls position/trim/loop/volume sont couverts.
- **Multi-utilisateurs / persistance serveur du brouillon** — cohérent avec le reste de l'app (mono-utilisateur) ; une session éphémère (mémoire ou localStorage) suffit en v1.

## User stories

- En tant qu'utilisateur, je veux ajouter un stem précis d'un morceau déjà analysé sur une timeline, pour construire un remix en piochant des fragments plutôt que des morceaux entiers.
- Je veux déplacer un clip dans le temps (glisser horizontalement), pour décider quand il intervient dans le remix.
- Je veux rogner le début/la fin d'un clip, pour n'utiliser qu'un passage précis d'un stem.
- Je veux boucler un clip sur une durée donnée, pour répéter un riff/une boucle sans le dupliquer manuellement.
- Je veux entendre le résultat en temps réel pendant que je glisse/rogne, avec clé et tempo synchronisés automatiquement sur le tempo maître du remix.
- Je veux un contrôle global de clé/tempo qui resynchronise tous les clips d'un coup.
- Je veux qu'on me propose un point de départ (quels stems, quel placement) selon un style de remix choisi, pour ne pas partir d'une page blanche.
- Je veux exporter le remix final en FLAC/MP4 une fois satisfait, avec un rendu fidèle à ce que j'ai construit.
- *Cas limite* : un clip dont le fichier stem source a disparu du disque (cache expiré, nettoyage manuel) doit afficher une erreur claire sur CE clip plutôt que de faire planter tout le rendu.
- *Cas limite* : tenter d'ajouter un 3e clip au-delà de la limite v1 doit être bloqué avec un message explicite, pas une dégradation silencieuse des perfs.

## Exigences

### P0 — sans ça la page n'a pas de sens

- Nouvelle route/page frontend avec une timeline horizontale à plusieurs pistes.
- Ajout de clip : piocher un morceau déjà analysé + un stem (voix/batterie/basse/autre) → crée un bloc positionné sur la timeline.
- Manipulation : glisser (position), poignées de rognage gauche/droite (trim in/out), poignée de boucle (répétition sur une durée) — mêmes interactions que Fadr.
- 2 clips simultanés en v1 (plafond en constante de config, pas en dur) ; message bloquant clair au-delà.
- Lecture temps réel du mélange pendant l'édition, moteur `soundtouchjs` réutilisé tel quel (même charge que l'existant, aucun nouveau risque de perf), chaque clip resynchronisé sur le tempo/la clé maître.
- Contrôle global clé/tempo du remix, recalcule le ratio pitch/tempo de chaque clip actif.
- **Nouvel endpoint de rendu backend** (extension de `mashupMulti.js` ou route dédiée) capable de produire un export FLAC/MP4 à partir d'une timeline de clips positionnés/rognés/bouclés — `mashupMulti.js` actuel ne sait combiner que des stems ENTIERS, pas des fragments dans le temps. C'est la pièce backend manquante, et le plus gros inconnu technique du projet.
- État de session survit à un rechargement accidentel (localStorage suffit, pas besoin de persistance serveur — cf. non-objectifs).

### P1 — probable fast-follow, pas bloquant pour une v1 utilisable

- Suggestions IA par **style de remix** (house, lofi, hardstyle...) proposant un placement de clips de départ — extension du panneau IA·DJA existant.
- Volume/pan par clip.
- Undo/redo sur les manipulations de timeline.
- Snap au beat/à la mesure lors du déplacement (en s'appuyant sur `beat_times_json`, déjà calculé par l'analyse existante).

### P2 — hors scope v1, à ne pas fermer architecturalement

- Vraies waveforms dessinées par clip.
- Effets/EQ par clip.
- Export des stems individuels du remix (comme Fadr).
- Bibliothèque de morceaux libres de droits.

## Critères de réussite (pas de métriques d'entreprise — c'est un outil perso)

- Tu peux construire un remix à 2 clips, l'écouter en temps réel pendant que tu ajustes, et exporter un résultat qui correspond à ce que tu as construit — sans détour par le studio actuel.
- Le placement d'un clip (position/trim/loop) dans l'éditeur correspond fidèlement à ce qui sort du rendu final ffmpeg (pas de décalage entre aperçu et export).
- Perdre un onglet par accident ne fait pas perdre le remix en cours (session récupérable).

## Décisions résolues

- **Capacité du moteur de lecture temps réel (30/07)** : plafonnée à 2 clips simultanés en v1 — capacité déjà éprouvée par `ComboPanel.jsx`, aucun prototype de charge nécessaire avant de démarrer. La question "tenir à 7 sources en temps réel" ne se pose plus pour la v1 ; elle redevient pertinente seulement si on relève le plafond plus tard (cf. objectif d'architecture extensible ci-dessus).

## Questions ouvertes

- **[Ingénierie, bloquant avant Phase 1]** Que doit faire le rendu si deux clips du MÊME type de stem se chevauchent dans le temps (ex: deux voix simultanées) ? Mixées ensemble, la dernière déposée gagne, ou interdit par l'UI (chevauchement bloqué au drag) ? Concerne surtout les moments où le plafond de clips sera relevé au-delà de 2 (avec seulement 2 clips, ce cas suppose déjà 2 stems du même type — à trancher quand même, ça peut arriver dès la v1).
- **[Toi]** Le "style de remix" (P1) doit-il influencer uniquement le PLACEMENT suggéré des clips, ou aussi des paramètres de rendu (quantization différente, effets) ? Change fortement la complexité de cette fonctionnalité.
- **[Toi]** Une vraie sauvegarde d'un remix en cours (reprendre plus tard, même après avoir fermé le navigateur) est-elle utile dans ton usage réel, ou une session par visite suffit ?

## Phasage suggéré

1. **Fondations backend** — modèle de données "timeline de clips" (position/trim/loop par clip) + endpoint de rendu ffmpeg capable de les assembler. C'est le seul vrai inconnu technique du projet : à dérisquer en premier, avant toute UI.
2. **UI timeline** — composant React drag/trim/loop en "blocs simples", plafonné à 2 clips, sans suggestions IA.
3. **Lecture live** — brancher `soundtouchjs` sur les 2 clips (capacité déjà connue, pas de scheduling exotique à inventer pour cette v1).
4. **P1** — suggestions par style de remix, snap au beat, undo/redo, puis éventuellement relever le plafond de clips si l'usage à 2 convainc.
