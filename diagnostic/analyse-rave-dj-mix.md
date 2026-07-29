# Analyse technique : le traitement des clips sur rave.dj (mashup & mix)

## Avertissement méthodologique

RaveDJ (devenu **Rave**, édité par **WeMesh**, basé à Kitchener, Ontario) est un produit **fermé, propriétaire** : il n'existe ni code source public, ni documentation technique officielle détaillée, ni API publiée. Cette analyse combine donc trois types de sources, clairement distinguées ci-dessous :

- des **déclarations officielles** des développeurs (commentaires de "ArmelC", dev chez Rave, sur Hacker News en 2018) ;
- des **descriptions produit actuelles** (pages marketing/agrégateurs décrivant les fonctionnalités du produit tel qu'il est aujourd'hui) ;
- des **observations empiriques** d'utilisateurs (tests réels postés sur Hacker News, avec liens audio, en 2018) qui permettent de déduire ce que l'algorithme fait ou ne fait *pas*.

Aucune de ces sources ne donne le détail exact des modèles ou du code. Le but de ce document n'est donc pas de "percer" rave.dj, mais d'en tirer des **principes de conception transposables** à MacheUp Studio.

## 1. Les deux modes de rave.dj : Mashup (2 pistes) vs Mix (N pistes)

Rave.dj propose deux traitements distincts, et c'est une distinction importante pour la suite :

**Mashup** : 2 morceaux (ou 2 clips vidéo) superposés sur toute leur durée, recalés en tempo. C'est le mode équivalent à ce que fait MacheUp Studio aujourd'hui (Decks A/B → un seul mashup superposé).

**Mix** : un grand nombre de morceaux (les utilisateurs sont explicitement invités à en fournir "50 ou plus", voire une playlist YouTube/Spotify entière) enchaînés en **un set continu façon DJ**, avec transitions. Un commentateur (paulm12345) le décrit ainsi : *"They try to only play relevant portions of songs, includes many other DJ rules that Mashups of 2 songs do not."* — autrement dit, le Mix ne joue pas chaque morceau en entier : il **sélectionne les portions pertinentes** de chacun puis les enchaîne, alors que le Mashup superpose betement les pistes du début à la fin.

C'est cette distinction qui correspond le mieux à "bénéficier du résultat de mashup poussé" : le saut de qualité de rave.dj ne vient pas seulement du recalage tempo/clé, mais de la **sélection intelligente de segments** plutôt que de l'utilisation de la piste entière.

## 2. Le pipeline technique (recoupé entre déclarations officielles et observations)

### 2.1 Détection BPM + recalage tempo (confirmé, "trivial" selon les utilisateurs eux-mêmes)

Tous les témoignages s'accordent : le beatmatching (détection BPM + étirement temporel pour aligner les 2 pistes) fonctionne bien et est qualifié de *"trivial"* par un utilisateur connaisseur du DJing (citation_please, HN 2018) — sous-entendu, ce n'est pas la partie qui fait la différence. C'est exactement l'équivalent de `analyzeAudio` (BPM) + `safeTempoRatio`/`atempo` dans `services/ffmpeg.js` côté MacheUp.

### 2.2 Détection de tonalité + correction harmonique (confirmé dans les descriptions produit actuelles)

Les fiches produit actuelles indiquent explicitement : *"The AI automatically handles key detection, tempo, and transitions"* et *"ensuring the tempo and key are well-matched."* Un commentateur HN de 2018 notait d'ailleurs que la version d'alors n'avait **pas** de key-matching (*"It would be pretty trivial to add key-matching to this thing"* — wavefunction), ce qui a manifestement été ajouté depuis. C'est exactement la fonctionnalité qu'on vient d'affiner dans MacheUp (`camelotAwareShift` dans `services/ffmpeg.js`) — bon signal que l'approche "roue de Camelot" est alignée avec la pratique du secteur, pas une réinvention isolée.

### 2.3 Séparation de pistes (vocals/instruments) — absente en 2018, présente aujourd'hui

C'est le point le plus parlant. En 2018, un utilisateur expérimenté (jjcm) écrivait : *"I really want this to become better, but I feel like it needs to be trained more tricks (vocal separation for one) to really be worth it."* — autrement dit, **rave.dj ne séparait pas voix/instru à l'époque**, ce qui explique la quasi-totalité des plaintes du fil (voix qui se chevauchent, "cacophonie", graves qui se télescopent — mburst : *"the algorithm had some issues with the low end clashing"*). Les descriptions produit actuelles confirment que **la séparation de stems a depuis été ajoutée** ("stem separation to isolate vocals, drums, and instruments"). Ça valide directement le choix déjà fait dans MacheUp (Demucs, `services/demucs.js`) : la séparation de stems n'est pas un détail, c'est ce qui transforme un "beatmatch superposé qui sonne comme deux fêtes voisines" (description d'un utilisateur HN) en un vrai mashup voix/instru propre.

### 2.4 Sélection de segments pertinents (mode Mix uniquement, observée indirectement)

C'est la partie la moins documentée publiquement mais la plus intéressante pour "pousser" un mashup. Pour le Mix multi-pistes, les retours utilisateurs indiquent que l'algorithme ne joue pas les morceaux en entier ni dans un ordre aléatoire : il choisit des **portions représentatives** et les enchaîne avec des règles de DJing (alignement de phrases rythmiques, transitions). Un autre commentaire (thanatropism) observe un **échec caractéristique** quand cette logique manque de repères : face à un morceau électronique en crescendo monotone (sans structure couplet/refrain claire), l'algorithme "ne sait pas quoi faire" — preuve indirecte qu'il s'appuie sur une **détection de structure** (couplet/refrain/montée) pour décider où couper, et que cette détection échoue sur les morceaux atypiques.

### 2.5 Alignement de phrase (bar-aligned), pas seulement de tempo

Un utilisateur (minikomi) félicite un mashup pour avoir *"the phrasing just right"*, tandis qu'un autre (LordHeini, via "DJ AssultPink") note que *"BPM detection usually works, but it seems to have trouble getting the songs synced in phrase — 2nd tracks come in starting on the 3rd bar or something"*. Cela confirme une distinction technique importante, souvent négligée : **synchroniser le tempo (BPM) ne suffit pas** — il faut aussi aligner les pistes sur la grille de mesures (le "1" de chaque mesure), sans quoi l'entrée d'un second morceau "tombe" au milieu d'une mesure et sonne décalé même si le tempo est identique.

### 2.6 Rendu vidéo (overlay des 2 clips sources)

Confirmé dès l'annonce 2018 : quand les 2 entrées sont des vidéos YouTube, rave.dj superpose/enchaîne aussi les flux vidéo (avec un fond animé qui consommait beaucoup de CPU côté client, point critiqué par plusieurs commentateurs). C'est l'équivalent de `exportMP4_916`/`muxVideoAudio` dans MacheUp.

## 3. État des lieux : ce que MacheUp Studio fait déjà (et qui rejoint rave.dj)

- BPM + recalage tempo : `services/analyzer.js` (librosa beat_track) + `safeTempoRatio`/`atempo` dans `services/ffmpeg.js`.
- Détection de tonalité + mode + notation Camelot : `services/analyzer.js` (Krumhansl-Schmuckler), stockée en SQLite (`db/index.js`).
- Correction harmonique façon roue de Camelot (unisson / relative / voisine) : `camelotAwareShift` dans `services/ffmpeg.js` (vient d'être affiné dans cette session).
- Séparation voix/instru (et 4 stems complets) : `services/demucs.js` (Demucs `htdemucs_ft`).
- Nettoyage écho/réverbe sur les stems : `services/dereverb.js` (UVR DeEcho-DeReverb).
- Ducking/sidechain voix→instru + égalisation + loudness : `mixFullRave` dans `services/ffmpeg.js`.
- Rendu vidéo synchronisé : `exportMP4_916`/`muxVideoAudio`.
- Détection de structure par segments (énergie/timbre) : `services/analyzer.js` (`librosa.segment.agglomerative`), stockée (`structure_json`) — **mais utilisée uniquement pour le score de compatibilité affiché dans le Mixer (`services/scoring.js`), jamais pour choisir QUELLE portion du morceau utiliser dans le mix.**

Ce dernier point est la pièce manquante la plus claire par rapport à ce que rave.dj fait dans son mode "Mix" (section 2.4) — et la piste la plus directement exploitable, puisque la donnée existe déjà en base, juste inutilisée à cette fin.

## 4. Recommandations concrètes pour MacheUp Studio

### 4.1 Sélection automatique du "meilleur" segment (le plus gros levier)

Aujourd'hui, `mixFullRave` reçoit toujours les stems **en entier** (voix A complète, instru B complet) — le morceau le plus court impose sa durée, mais aucun choix n'est fait sur QUELLE portion utiliser. Exploiter `structure_json` (déjà calculé, déjà en base) pour repérer automatiquement la section "high energy" la plus longue de chaque morceau (typiquement le refrain) et **découper les stems sur cette plage** avant le mix, plutôt que de partir du début. C'est concrètement un `ffmpeg -ss <début> -t <durée>` appliqué aux fichiers stems avant `mixFullRave`, piloté par les timestamps déjà présents dans `structure`.

### 4.2 Alignement de phrase (bar-aligned), pas seulement de tempo

Actuellement le recalage tempo (`safeTempoRatio`) égalise les BPM mais ne garantit pas que les pistes démarrent sur le même temps de mesure. Détecter le premier "downbeat" de chaque piste (librosa a `librosa.beat.beat_track` qui renvoie déjà les positions de battements — il suffit d'en extraire le premier, et idéalement de repérer un début de mesure via le motif d'accentuation) et caler l'offset de découpe dessus, plutôt que de couper à `t=0` brut.

### 4.3 Étendre l'amélioration harmonique à TOUT le pipeline, pas seulement aux combos

Le `camelotAwareShift` qu'on vient d'ajouter n'est branché que sur `/api/mashup/combine-stems` (les combos). Le mashup principal (`mode === "full"` dans `routes/mashup.js`, l'appel `mixFullRave(resA.stems.vocals, resB.stems.instrumental, ...)`) ne passe **aucune** option `keyVocals`/`keyInstru`/`camelotVocals`/`camelotInstru` aujourd'hui : la voix du Create Macheup principal n'est donc jamais transposée. C'est une incohérence facile à corriger — il suffit de passer les mêmes paramètres (`resA.camelot`, `resB.camelot`, déjà disponibles via `getTrack`/`analysisA`/`analysisB`) à cet appel.

### 4.4 Un mode "Mix" à N pistes, façon rave.dj

Le mode actuel de MacheUp est structurellement un "Mashup" (2 pistes superposées en continu). Un mode "Mix" inspiré de rave.dj — enchaîner 3 morceaux ou plus, chacun réduit à sa meilleure section (cf. 4.1), avec crossfade calé sur le tempo — serait un vrai axe de différenciation, et réutiliserait directement l'infrastructure existante (Demucs, BPM/clé, structure) sans nouvelle dépendance.

### 4.5 Repli "neutre" sur les morceaux à structure atypique

Le cas d'échec documenté en section 2.4 (morceau en crescendo monotone, sans repère couplet/refrain) doit être anticipé : `scoreStructure` dans `services/scoring.js` renvoie déjà 50 (neutre) "si pas de structure exploitable" — la même philosophie de repli doit s'appliquer à la sélection de segment (4.1) : si aucune section "high energy" nette ne se distingue, retomber sur le comportement actuel (depuis le début du morceau) plutôt que de mal choisir.

## Sources

- [Rave.dj – an artificially intelligent mash-up machine (Hacker News, 2018, fil de discussion complet incluant des réponses des développeurs)](https://news.ycombinator.com/item?id=17849029)
- [RaveDJ – AI Music Mashup Maker (Hacker News, 2021)](https://news.ycombinator.com/item?id=28514159)
- [RaveDJ: Features, Pricing, Benefits and Review | AI Parabellum](https://aiparabellum.com/ravedj-ai/)
- [RaveDJ - Music Mixer (site officiel)](https://rave.dj/)
- [10 Best AI Alternatives for RaveDJ (2026 Guide)](https://awesmai.com/tools/best-ai-alternatives-for-ravedj)
- [GitHub - SuperSonicHub1/rave-dl (outil tiers, confirme l'absence d'API publique officielle)](https://github.com/SuperSonicHub1/rave-dl)
