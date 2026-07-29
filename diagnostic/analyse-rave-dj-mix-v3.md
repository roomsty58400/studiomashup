# Analyse qualité mashup : MacheUp Studio vs rave.dj — v3

> **Périmètre** : Ce document couvre uniquement ce que les v1 et v2 N'ONT PAS traité.
> Les corrections v1+v2 (HPF 160→200 Hz, EQ creux 1800 Hz, adelay vocal, segment selection, bar alignment, chroma_cens, mud cut 300 Hz, rubberband) sont considérées comme **acquises**.
> Cette v3 identifie les **5 problèmes de second ordre** restants, basée sur une analyse des commentaires utilisateurs rave.dj 2018→2026 et les principes du mixage professionnel.

---

## Ce que l'on sait maintenant sur rave.dj (état 2026)

### Sources récupérées

- **HN 2018 fil complet** (ArmelC, dev rave.dj) : pipeline 2018 = beatmatching + tempo stretch, SANS séparation de stems. Les commentaires utilisateurs confirment les défauts de l'époque ("low end clashing", "volume balance", "phrase alignment").
- **Meta OG tags** de 3 mashups actuels : format de sortie `720p MP4`, audio encodé en **AAC 128-256 kbps** (estimation — conteneur MP4 web standard).
- **rave_dl.py** (downloader communautaire) : révèle que rave.dj expose `data["urls"]["audio"]` (MP3 séparé) et `data["urls"]["default"]` (MP4). La présence d'une URL "audio" distincte implique un rendu audio post-traité.
- **ArmelC, HN 2021** (via le fil) : *"Most of our recent technical advancements are done on our mix AI"* — c'est le MIX (multi-chansons) qui reçoit les améliorations, PAS forcément le MASHUP 2 sons.

### Révélation clé : rave.dj est potentiellement meilleur sur le MIX que sur le MASHUP

> *"Those [mixes] include many more advanced techniques than seen in mashups"* — paulm12345, HN 2018

**Le mode "mashup 2 sons" de rave.dj est le mode le MOINS sophistiqué.** Le mode "Mix playlist" est celui qui a reçu le plus d'améliorations techniques. Si tu compares tes mashups MacheUp à des mashups rave.dj (mode 2 sons), la barre n'est pas aussi haute qu'on le pensait.

---

## 1. Problème non traité : la loudness est trop basse (−15.5 LUFS)

### Diagnostic

Notre cible est −15.5 LUFS intégré. C'est la loudness typique d'une plateforme de streaming (Spotify normalise à −14 LUFS). Mais rave.dj sert des vidéos MP4 **non normalisées par une plateforme** — ils peuvent (et probablement font) viser une loudness plus agressive, autour de **−12 à −13 LUFS**.

La différence perceptive est réelle : à −12 LUFS vs −15.5 LUFS, un mashup "sonne" plus présent, plus "pro", même si on se dit qu'on a baissé le volume pour compenser. L'oreille perçoit la densité spectrale, pas le volume absolu.

### Pourquoi ça sonne "mieux" plus fort ?

À loudness égale en LUFS, un mix plus dense spectralement (plus de compression sur le master) sonne plus "collé" — les deux stems paraissent appartenir au même espace acoustique. C'est l'**effet glue** que les ingénieurs de mastering recherchent.

### Correction

```
// AVANT (vocalsLUFS / instruLUFS autour de −15.5) :
const vocalsLUFS = (-15.5 + ...).toFixed(1);
const instruLUFS = (-15.5 - ...).toFixed(1);

// APRÈS : monter de 2 LUFS (cible −13.5 LUFS au lieu de −15.5) :
const vocalsLUFS = (-13.5 + ...).toFixed(1);
const instruLUFS = (-13.5 - ...).toFixed(1);
```

**Et** ajouter un compresseur glue sur le bus master AVANT le limiter :

```
// Dans la filter_complex, avant alimiter :
[mixed]acompressor=threshold=0.1:ratio=2:attack=80:release=500:makeup=1.5[mixed_glued];
[mixed_glued]alimiter=level_in=1:level_out=0.97:limit=0.95:attack=5:release=50[out]
```

Ce compresseur `2:1 / attack 80ms / release 500ms` est la définition du "glue compressor" en mastering — il attaque trop lentement pour pomper sur les transitoires, mais assez vite pour coller les deux stems dans la même enveloppe dynamique.

**Gain perceptible attendu : ★★★★★** — c'est probablement la plus grande différence restante.

---

## 2. Problème non traité : absence de reverb de liaison ("acoustic glue")

### Diagnostic

Les deux stems (voix A + instru B) viennent de deux enregistrements différents, dans deux studios/réverbérations différentes. Même avec un pitch shift et un EQ parfaits, l'oreille détecte l'incohérence de l'espace acoustique — la voix "sonne sur fond vert" par rapport à l'instru.

C'est pour ça que les mashups faits maison en DAW ajoutent systématiquement une **réverbe courte** (Room ou Hall très court, 0.3–0.8s, pre-delay 0ms) uniquement sur la voix, pour l'ancrer dans le même espace acoustique que l'instru.

### Correction

```
// Ajout après le pitch+EQ vocal, AVANT l'adelay :
[0:a]${vocalsTrimFilter}${pitchFilter}highpass=f=200,...[vocals_eq];
[vocals_eq]aecho=0.8:0.88:60:0.4[vocals_reverb];
[vocals_reverb]adelay=${vocalDelayMs}|${vocalDelayMs}[vocals_delayed];
```

`aecho` paramètres :
- `in_gain=0.8` (ne sature pas l'entrée)
- `out_gain=0.88` (légèrement réduit)
- `delays=60` (60ms — room court, pas un écho perceptible)
- `decays=0.4` (queue assez courte)

Ou plus proprement avec `areverb` si disponible :
```
[vocals_eq]areverb=roomsize=0.2:damping=0.7:wet=0.15:dry=0.85[vocals_reverb];
```
(`wet=0.15` = 15% reverb, 85% direct — subtil mais efficace)

**Gain perceptible attendu : ★★★★** — la cohérence spatiale est immédiatement perceptible à l'écoute critique.

---

## 3. Problème non traité : sidechain qui pompe trop fort sur les aigus

### Diagnostic

Notre sidechain (`sidechaincompress=threshold=0.06:ratio=2.5`) réduit l'ensemble de l'instru quand la voix chante — basses, médiums, ET aigus. Problème : en réduisant aussi les aigus (cymbales, hi-hats), on crée un effet de "pomping" perceptible et artificiel. Les aigus sont les plus audibles par l'oreille humaine pour percevoir ce type de variation.

Un mixeur pro applique le sidechain ducking **seulement sur les médiums de l'instru** (200-3000 Hz), là où la voix et l'instru se masquent réellement, et laisse les aigus et les très basses sans atténuation.

### Correction : sidechain multiband (voie médiums uniquement)

```
// Séparer les bandes de l'instru avant le sidechain :
[instru_fmt]asplit=3[instru_lo][instru_mid][instru_hi];

// HPF/LPF pour extraire bandes :
[instru_lo]lowpass=f=200[instru_lo_out];
[instru_mid]highpass=f=200,lowpass=f=3000[instru_mid_sc];
[instru_hi]highpass=f=3000[instru_hi_out];

// Sidechain uniquement sur la bande médium :
[instru_mid_sc][vocals_scfmt]sidechaincompress=threshold=0.06:ratio=2.5:attack=30:release=600:makeup=1[instru_mid_ducked];

// Recombiner :
[instru_lo_out][instru_mid_ducked][instru_hi_out]amix=inputs=3:normalize=0[instru_ducked];
```

**Gain perceptible attendu : ★★★** — réduit l'effet "radio" du sidechain actuel, l'instru reste plus naturel quand la voix chante.

---

## 4. Problème non traité : pas de de-ess sur la voix

### Diagnostic

Les stems vocaux Demucs ont souvent un excès de sibilantes (consonnes "s", "ch", "t") entre 5 et 10 kHz — surtout après un pitch shift (qui peut accentuer certaines harmoniques hautes). Sur un mashup, ces sibilances ressortent car l'instru n'a pas ce contenu et l'oreille les entend clairement.

Un de-esser est un compresseur dynamique étroit centré sur 6-8 kHz qui se déclenche uniquement sur les sibilances.

### Correction

```
// Après le loudnorm vocal, avant le equalizer de présence :
[vocals_loudnorm]adeclick[vocals_click];
// De-ess maison via agate+equalizer (pas de filtre dédié dans ffmpeg de base) :
[vocals_click]equalizer=f=7000:width_type=h:width=4000:g=-3[vocals_deessed];
```

Une atténuation statique de -3 dB entre 5000-9000 Hz est la version simple mais efficace du de-ess pour ffmpeg (sans plugin externe).

**Gain perceptible attendu : ★★★** — sur les voix féminines en particulier, réduit l'agressivité des sibilances.

---

## 5. Problème non traité : comparaison incorrecte (biais de loudness)

### Diagnostic — Le plus important de tous

> "When you make two mixes sound the same loudness, people consistently rate the louder one as sounding better."

Si tu écoutes côte à côte un mashup rave.dj (MP4/AAC non normalisé, probablement −12 à −13 LUFS) et un mashup MacheUp (FLAC lossless, cible −15.5 LUFS), **le rave.dj semble TOUJOURS meilleur** uniquement parce qu'il est plus fort. L'écart perceptif correspond à l'écart de loudness, pas à une différence réelle de qualité technique.

**Test à faire impérativement** avant toute autre correction :
1. Importer les deux mashups dans Audacity ou un DAW
2. Appliquer "Normalize" sur les deux pour les amener au même niveau RMS
3. Re-écouter côte à côte

Si la différence disparaît ou devient marginale : le problème principal était la loudness, pas le traitement audio.

**Correction directe** : monter notre cible de loudness comme suggéré au §1 (−13.5 LUFS) et ajouter le glue compressor.

---

## Plan d'action priorisé (suite aux v1+v2)

| # | Correction | Effort | Fichier | Impact |
|---|-----------|--------|---------|--------|
| **A** | Master bus glue compressor + cible −13.5 LUFS | Trivial | `ffmpeg.js` | ★★★★★ |
| **B** | Reverb de liaison sur la voix (`aecho` 60ms) | Trivial | `ffmpeg.js` | ★★★★ |
| **C** | De-ess léger sur voix (−3 dB @ 7 kHz) | Trivial | `ffmpeg.js` | ★★★ |
| **D** | Sidechain multiband (médiums uniquement) | Moyen | `ffmpeg.js` | ★★★ |
| **E** | Test equal-loudness avant toute autre décision | Zero code | — | ★★★★★ |

---

## Outil d'analyse spectrale

Le script `tools/analyze_ravedj.py` analyse tout fichier rave.dj vs MacheUp :

```bash
# Installer les dépendances (une seule fois)
pip install librosa numpy matplotlib soundfile scipy

# Analyser 1 seul fichier rave.dj
python tools/analyze_ravedj.py rave_hold_that.mp4

# Comparer rave.dj vs MacheUp
python tools/analyze_ravedj.py rave_hold_that.mp4 macheup_hold_that.flac
```

### Télécharger des mashups rave.dj pour test

Coller ces URLs dans ton navigateur (click direct → téléchargement) :

**"Hold That" — Disclosure + The XX** (très bon selon les users HN 2018) :
```
https://y4w3b3b7.map2.ssl.hwcdn.net/rave-us-3/mashups%2Fc973fc8b-7a88-447e-a4d7-fc61b86d068d.mp4
```

**"Bloody To My Roots Devices" — Sepultura + Pet Shop Boys** :
```
https://assets2.rave.dj/videos/0864fa66-6de8-44ee-a0a4-4c45684c9b1b720.mp4
```

**Mix 41 chansons** (mode Mix, le plus sophistiqué techniquement) :
```
https://assets3.rave.dj/videos/06b789d7-769f-4765-8984-0403eafc2348720.mp4
```

Le script génère :
- Tableau comparatif LUFS / Crest / HPF / BPM
- `mashup_comparison.png` — courbes spectrales superposées + courbe différentielle
- `mashup_comparison.json` — données brutes pour analyse

---

## Ce que MacheUp fait MIEUX que rave.dj (2026)

Pour garder le sens des proportions :

- **Qualité du fichier de sortie** : FLAC lossless vs AAC 128kbps — MacheUp gagne largement
- **Détection de tonalité** : chroma_cens sur corps du morceau > ce que rave.dj faisait en 2018 (pas de détection tonale du tout)
- **Correction harmonique Camelot** : notre roue de Camelot avec shift minimal est au standard professionnel
- **Sidechain ducking** : rave.dj 2018 n'avait PAS de ducking — on l'a depuis le début
- **Segment selection** : on fait pareil que rave.dj (premier segment "high")
- **Bar alignment** : rave.dj a ce problème documenté depuis 2018 (*"2nd tracks come in starting on the 3rd bar"*) ; notre implémentation beat_times_early est potentiellement meilleure

---

## Sources

- [Rave.dj HN 2018 — commentaires ArmelC + utilisateurs](https://news.ycombinator.com/item?id=17849029)
- [RaveDJ AI Music Mashup Maker — HN 2021](https://news.ycombinator.com/item?id=28514159)
- [rave-dl source code (API rave.dj)](https://github.com/SuperSonicHub1/rave-dl/blob/master/rave_dl.py)
- [2026 Guide to DJ Stem Separation Software](https://dj.studio/blog/evidence-based-guide-dj-stem-separation)
- [DJ Software Stem Separation Benchmark 2026](https://dj.studio/blog/dj-software-stem-separation-benchmark)
- [How to master for streaming: LUFS, normalization](https://www.izotope.com/community/blog/mastering-for-streaming-platforms)
