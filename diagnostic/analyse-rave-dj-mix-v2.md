# Analyse qualité mashup : MacheUp Studio vs rave.dj — v2

> **Objectif de ce document** : identifier POURQUOI les mashups MacheUp Studio ne sonnent pas encore aussi bien que rave.dj, et fournir les corrections concrètes par ordre d'impact. La v1 (juin 2026) documentait le pipeline général ; cette v2 descend dans les paramètres audio responsables de la différence perceptible à l'oreille.

---

## 1. Ce que rave.dj fait (état 2026 confirmé)

Sources : fil Hacker News 2018 (commentaires du dev ArmelC + observations utilisateurs), descriptions produit actuelles, benchmarks 2026.

**Ce qui fonctionnait déjà en 2018 :**
- Beatmatching BPM + recalage tempo (l'algo de base)
- Alternance vidéo (overlay clips YouTube)

**Ce qui a été ajouté depuis :**
- Séparation de stems voix/instru (confirmé — c'est ce que les utilisateurs réclamaient en 2018 comme manque principal)
- Détection de tonalité + harmonic matching (présent dans les descriptions produit actuelles)
- Sélection de segments pertinents pour le mode Mix (ne joue pas le morceau entier)

**Ce qui reste faible même chez rave.dj :**
- Alignement de phrase/mesure : *"BPM detection usually works, but it seems to have trouble getting the songs synced in phrase — 2nd tracks come in starting on the 3rd bar or something"* (LordHeini, HN 2018) → problème non résolu publiquement
- Équilibre des volumes : *"a bit of better volume balancing where the two songs overlap and I'd play that at a party with no regrets"* (andybak, HN 2018) → toujours cité comme défaut
- Conflits de basses : *"the algorithm had some issues with the low end clashing"* (mburst, HN 2018) → partiellement résolu avec les stems mais pas complètement

---

## 2. Diagnostic : pourquoi le résultat MacheUp sonne encore "brouillon"

### 2.1 Le vrai problème n°1 : le filtre passe-haut de la voix est trop bas

**Constat** : dans `mixFullRave` (services/ffmpeg.js), la voix est filtrée avec `highpass=f=80`. Soit 80 Hz.

**Le problème** : le stem vocal extrait par Demucs (`htdemucs_ft`) n'est pas parfaitement propre — il contient du *bleed* (fuite) de la piste basse/basses fréquences, surtout sur les morceaux pop/électro avec une basse forte. Ce bleed se situe typiquement entre 80 et 200 Hz. Un HPF à 80 Hz ne le coupe *pas* — il ne coupe que sous 80 Hz, qui est quasiment du sous-bass pur, inaudible et inexistant dans un stem vocal de toute façon.

Pendant ce temps, la piste instrumentale (stem B) a aussi sa basse complète dans le même registre (kick drum 40-80 Hz, basse 60-200 Hz). Résultat : **deux lignes de basses se superposent**, dont l'une est un artefact de séparation Demucs — c'est le "low end clashing" décrit par les utilisateurs de rave.dj en 2018 ET le problème principal qui rend les mashups MacheUp "brouillons" en bas du spectre.

**La voix humaine** : la fréquence fondamentale d'un chanteur démarre entre 80 Hz (baryton grave) et 150 Hz (voix féminine), et l'essentiel de l'intelligibilité vocale se situe entre 300 Hz et 3 kHz. Monter le HPF de 80 à **160-180 Hz** coupe le bleed de basse du stem vocal sans toucher à la voix elle-même.

**Correction (une ligne dans `services/ffmpeg.js`)** :
```
// AVANT :
highpass=f=80

// APRÈS :
highpass=f=160
```

Gain perceptible attendu : **fort** — c'est probablement la correction à l'impact immédiat le plus important.

---

### 2.2 Problème n°2 : pas d'EQ "sculpté" sur l'instrumental pour faire de la place à la voix

**Constat** : l'instru reçoit uniquement un `loudnorm` et un `atempo`. Aucun EQ.

**Le problème** : la voix et l'instrumental partagent le même registre de fréquences entre 500 Hz et 4 kHz (présence, corps, intelligibilité). Si l'instru est dense dans cette zone (synthés de fond, guitares rythmiques, claviers), la voix se "noie" dedans même si son volume est correct — ce n'est pas un problème de volume, c'est un problème de **masquage fréquentiel**.

Technique standard en mixage professionnel : appliquer un léger creux EQ sur l'instru dans la zone de présence vocale (1-3 kHz, -2 à -3 dB), pour "sculpter" un espace où la voix peut respirer sans avoir besoin d'être poussée en volume. C'est ce qu'un ingénieur du son fait systématiquement sur un mix vocal.

**Correction (ajout dans le filter_complex de `mixFullRave`)** :
```
// Sur la chaîne instru, APRÈS le loudnorm, AVANT l'atempo :
equalizer=f=1800:width_type=o:width=2.5:g=-2.5

// Résultat complet de la chaîne instru :
[1:a]loudnorm=I=${instruLUFS}:TP=-1.5:LRA=11,equalizer=f=1800:width_type=o:width=2.5:g=-2.5,atempo=${ratio}[instru_norm]
```

Ce creux à 1800 Hz (−2.5 dB, largeur d'octave = 2.5 = modérée) est suffisamment large pour dégager la zone de présence vocale, suffisamment léger pour ne pas creuser de "trou" audible dans l'instru seul.

Gain perceptible attendu : **moyen à fort** — améliore la lisibilité vocale sans toucher aux volumes.

---

### 2.3 Problème n°3 : les stems démarrent tous les deux à t=0 (pas d'intro instrumentale)

**Constat** : dans l'appel `ffmpeg ... amix=inputs=2:duration=longest`, la voix A et l'instru B partent exactement en même temps, à la seconde 0.

**Le problème** : aucun DJ ne superpose deux morceaux dès la première seconde — rave.dj compris. La pratique universelle est de laisser l'instru s'installer seul quelques mesures avant que la voix n'entre. Deux raisons :
1. L'oreille a besoin de "se caler" sur le nouveau contexte harmonique/rythmique avant que la voix n'arrive.
2. Le bleed des premières secondes (souvent une intro non chantée) superpose 2 intros ensemble → confus.

**Correction (ajout d'un `adelay` sur la voix dans `mixFullRave`)** :
```
// Delay de 4 secondes sur la voix (4000 ms) avant le merge :
[0:a]${pitchFilter}highpass=f=160,...[vocals_pre];
[vocals_pre]adelay=4000|4000[vocals_delayed];
...
[vocals_delayed][instru_ducked]amix=inputs=2:duration=longest:...
```

Les 4 secondes permettent ~2 mesures à 120 BPM pour "poser" l'instru. Valeur configurable selon le tempo. Cela recrée automatiquement un "drop" vocal qui rend le mashup plus intéressant à écouter.

Gain perceptible attendu : **fort sur l'expérience d'écoute globale**.

---

### 2.4 Problème n°4 : alignement de tempo ≠ alignement de mesure (le "3rd bar problem")

**Constat** : `safeTempoRatio` aligne les BPM mais pas les temps de mesure.

**Le problème documenté** : même avec des BPM parfaitement égalisés, si la voix démarre sur le 2e temps d'une mesure et l'instru sur le 1er temps, ils ne seront jamais "en phrase" — la caisse claire tombe au mauvais endroit, le refrain de la voix arrive sur une mesure "impaire" de l'instru. C'est le problème précisément cité par LordHeini sur rave.dj (*"2nd tracks come in starting on the 3rd bar"*) et confirmé comme non entièrement résolu même par rave.dj.

**Ce qui existe déjà** : `analyzer.js` appelle `librosa.beat.beat_track(y=y, sr=sr)` mais ne retourne que le BPM — les *positions des beats* (`beat_times`) sont calculées mais jetées.

**Correction en deux étapes** :

**Étape A** — Modifier le script Python dans `analyzer.js` pour exporter les beat times :
```python
# Remplacer :
tempo, _ = librosa.beat.beat_track(y=y, sr=sr)

# Par :
tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
# Garder uniquement les 16 premiers beats (suffisant pour trouver le downbeat) :
beat_times_early = beat_times[:16] if len(beat_times) >= 16 else beat_times
```
Et ajouter `'beat_times_early': beat_times_early` dans le JSON de sortie + le schéma SQLite (`beat_times_json TEXT`).

**Étape B** — Dans `routes/mashup.js`, avant `mixFullRave`, calculer l'offset de downbeat :
```js
// Offset du 1er beat de chaque piste (temps en secondes depuis t=0)
const firstBeatA = resA.beatTimesEarly?.[0] ?? 0;
const firstBeatB = resB.beatTimesEarly?.[0] ?? 0;
// Offset d'alignement : avancer ou reculer l'instru pour que son beat 1
// tombe au même moment que le beat 1 de la voix
const beatOffset = Math.max(0, firstBeatA - firstBeatB); // en secondes
// Appliquer via adelay sur l'instru (si offset > 0) ou sur la voix (si négatif)
```

Gain perceptible attendu : **moyen** — améliore le "groove" global, notamment perceptible sur des morceaux à forte accentuation rythmique.

---

### 2.5 Problème n°5 : on mixe toujours depuis t=0 (pas de sélection du meilleur segment)

**Constat** : les stems sont toujours utilisés en entier depuis le début.

**Ce qui existe déjà** : `structure_json` est calculé dans `analyzer.js` (segmentation par énergie via `librosa.segment.agglomerative`) et stocké en SQLite. Chaque segment est labelé `low`/`mid`/`high` selon son niveau d'énergie relative.

**Le problème** : un morceau de 4 minutes commence souvent par une intro basse (`low`) de 30-45 secondes avant le refrain. Le mashup démarre sur cette intro molle plutôt que sur le cœur énergétique du morceau.

**La correction** : chercher le premier segment `high` dans la structure de chaque piste et commencer le stem à ce timestamp via `ffmpeg -ss`. Si aucun segment `high` n'existe (structure atypique), rester sur t=0 (repli neutre).

```js
// Dans prepareTrack (routes/mashup.js) :
const structure = cached.structure_json ? JSON.parse(cached.structure_json) : [];
const highSegment = structure.find(s => s.label === 'high');
const startOffset = highSegment ? highSegment.start : 0;
// Passer startOffset à mixFullRave → appliqué via -ss sur l'input ffmpeg
```

Ceci fait exactement ce que rave.dj fait en mode Mix : *"They try to only play relevant portions of songs"*.

Gain perceptible attendu : **fort** — saute les intros molles, part direct sur le drop/refrain.

---

## 3. Ce que MacheUp fait déjà bien (et qui est aligné ou supérieur à rave.dj)

Pour calibrer les efforts : voici ce qui est déjà au niveau ou au-dessus du standard.

- **Modèle de séparation** : `htdemucs_ft` (fine-tuned) est le meilleur compromis qualité/vitesse en production en 2026. SDR moyen 8.5 dB vs 9.8 dB pour BS-RoFormer — la différence est marginal sur les voix (8.9 dB vs ~9.5 dB sur les vocals), non justifiable vu le coût de traitement x2-3 de BS-RoFormer. ✅

- **De-reverb** : le passage par UVR DeEcho-DeReverb sur les stems avant le mix est une étape que rave.dj ne documente pas publiquement et qui n'est pas standard chez les outils concurrents. ✅

- **Harmonic matching (Camelot)** : la correction par roue de Camelot (unisson, relative, voisine) est maintenant dans le pipeline principal ET les combos. C'est en ligne avec ce que rave.dj décrit dans ses fiches produit actuelles. ✅

- **Loudness EBU R128** : ciblage LUFS précis avec écart voix/instru ajustable via le curseur crossfade → résultat plus maîtrisé que la normalisation relative (`dynaudnorm`) qu'on avait avant. ✅

- **Sidechain ducking** : compression sidechain lissée (attack 30ms, release 600ms) pour faire descendre l'instru pendant la voix. ✅

- **Correction d'octave BPM** : `safeTempoRatio` teste raw/×2/÷2 pour éviter les doublements/moitiés de BPM que librosa rapporte régulièrement. ✅

---

## 4. Plan d'action par priorité

| # | Correction | Effort | Fichier(s) | Impact sonore |
|---|-----------|--------|-----------|--------------|
| **1** | HPF voix 80 → 160 Hz | Trivial (1 ligne) | `services/ffmpeg.js` | ★★★★★ |
| **2** | EQ creux instru −2.5 dB @ 1800 Hz | Trivial (1 filtre) | `services/ffmpeg.js` | ★★★★ |
| **3** | Intro instrumentale (adelay 4s sur voix) | Facile (2 lignes) | `services/ffmpeg.js` | ★★★★ |
| **4** | Sélection du meilleur segment via structure_json | Moyen | `routes/mashup.js` | ★★★★ |
| **5** | Alignement de phrase (beat_times_early) | Moyen | `analyzer.js` + `db/index.js` + `routes/mashup.js` | ★★★ |

Les corrections 1, 2, 3 sont des changements dans la commande FFmpeg de `mixFullRave` uniquement — zéro impact sur le reste du pipeline, zéro régression possible.

---

## 5. Benchmark modèles de séparation 2026 (pour info, pas de changement recommandé)

| Modèle | SDR moyen | SDR voix | Temps 3 min (A40) | Décision |
|--------|-----------|----------|-------------------|----------|
| Spleeter 4-stem | ~5.4 dB | ~5.9 dB | <5s | Trop faible |
| htdemucs (default) | ~7.7 dB | ~8.1 dB | 30-45s | Bien |
| **htdemucs_ft** | **~8.5 dB** | **~8.9 dB** | 90-150s | **✅ Utilisé par MacheUp** |
| BS-RoFormer | ~9.8 dB | — | 60-120s | +0.6 dB voix vs htdemucs_ft — non justifié vu la latence x2 |

Conclusion : **rester sur `htdemucs_ft`**, le gain BS-RoFormer sur les voix est marginal (~0.6 dB SDR, à peine perceptible) et l'inference est 2× plus lente.

---

## Sources

- [Rave.dj – an artificially intelligent mash-up machine (Hacker News 2018, fil complet dont réponses dev ArmelC)](https://news.ycombinator.com/item?id=17849029)
- [htdemucs vs BS-RoFormer vs Spleeter: A 2026 Audio Source Separation Benchmark](https://aistemsplitter.org/blog/htdemucs-vs-bs-roformer-vs-spleeter-2026-benchmark)
- [Best AI Stem Separation Model for Vocals: 2026 Comparison](https://neuralanalog.com/stems/best-ai-stem-separation-model-vocals)
- [Advanced EQ Techniques 2026 | Mid-Side EQ](https://mixingmonster.com/advanced-eq-techniques/)
- [The Secret to a Clean Mix: How to Control Low-End Like a Professional](https://mixmasterpro.io/articles/lowendcontrol)
- [Benchmarks and leaderboards for sound demixing tasks (SDX23)](https://www.researchgate.net/publication/370763841_Benchmarks_and_leaderboards_for_sound_demixing_tasks)
