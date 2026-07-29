# RaveDJ vs MacheUp — dissection technique et pistes d'optimisation

*Juillet 2026 — basé sur l'automatisation Puppeteer déjà en place (services/ravedjAutomation.js) et l'analyse directe de 2 rendus RaveDJ générés cette session.*

## Méthodologie et limites honnêtes

Deux mashups RaveDJ ont été générés via l'automatisation existante et analysés de deux façons :

1. **Analyse binaire du conteneur MP4** (parsing direct des atomes `mvhd`/`mdhd`/`tkhd`) — fiable à 100%, c'est ce qui a permis de confirmer les durées réelles (1:49 et 3:08) dans l'échange précédent.
2. **Analyse audio "maison" en JavaScript** (Web Audio API, decodeAudioData + enveloppe RMS + autocorrélation grossière) — exécutée à la volée dans un onglet de navigateur, **beaucoup moins rigoureuse** que le pipeline Python/Librosa que MacheUp utilise pour lui-même. Les BPM estimés ci-dessous sont probablement affectés par des erreurs d'octave (un phénomène que le code de MacheUp connaît déjà et corrige explicitement — cf. `safeTempoRatio` dans `ffmpeg.js`) : à prendre comme indices, pas comme mesures de référence.

Échantillon : **2 rendus seulement**, une seule paire de morceaux chacun. Les constats ci-dessous sont des tendances observées, pas des certitudes statistiques sur "comment RaveDJ fonctionne dans tous les cas". Une validation plus rigoureuse (faire tourner le VRAI analyseur Python de MacheUp — `librosa.beat.beat_track`, détection de clé par chroma — directement sur un rendu RaveDJ téléchargé) est proposée en fin de document comme prochaine étape, pas encore réalisée (nécessite une petite route backend supplémentaire, cf. plus bas).

## Ce qui a été observé chez RaveDJ

| Constat | Preuve | Fiabilité |
|---|---|---|
| Durée de sortie variable selon la paire de morceaux (1:49 vs 3:08 sur 2 tests) | Parsing binaire `mvhd`/`mdhd`, fiable | Élevée |
| Pas de coupure nette (silence puis reprise) détectée au point de plus forte variation d'énergie sur les 2 fichiers | Zoom sur l'enveloppe RMS (fenêtres 50ms) autour du point de rupture — texture rythmique continue, aucun creux de silence | Moyenne (2 échantillons) |
| Période rythmique dominante estimée identique entre 1ère et 2e moitié du morceau (les 2 fichiers) | Autocorrélation de l'enveloppe RMS | Faible-moyenne (méthode grossière, sujette aux erreurs d'octave) |
| Débit d'encodage vidéo ~200 kB/s, cohérent entre les 2 fichiers | Content-Length / durée | Élevée mais peu informatif (encodage standard) |

## Hypothèse principale (à valider, pas confirmée)

L'absence de coupure nette combinée à une texture dense et continue sur toute la durée suggère que RaveDJ **superpose les 2 morceaux en (quasi) continu** plutôt que de faire un enchaînement séquentiel façon "DJ mix" (intro A → transition → B). C'est cohérent avec le concept marketing de RaveDJ ("mashup", pas "mix").

Ce qui n'a **pas** été observé : aucun passage clairement identifiable comme "voix seule" ou "instru seul" dans les 2 fichiers analysés — contrairement à ce qu'on attendrait d'une vraie séparation de sources (Demucs-style). Ça suggère (hypothèse, pas certitude) que RaveDJ mélange probablement les **mix complets** des 2 morceaux (avec calage tempo/tonalité), sans isoler voix/instru comme le fait MacheUp — plus simple/rapide à calculer à grande échelle pour un service gratuit, mais mécaniquement plus "chargé"/moins propre qu'une vraie séparation de stems.

## Comparatif avec le pipeline MacheUp actuel

Relecture de `services/ffmpeg.js` et `services/workers/analyzer_worker.py` : le pipeline MacheUp est déjà nettement plus sophistiqué que ce que l'observation de RaveDJ suggère de son côté.

| Aspect | RaveDJ (observé/déduit) | MacheUp (déjà en place) |
|---|---|---|
| Séparation des sources | Probablement aucune (mix complets superposés) | Demucs 4/6 stems réels — voix isolée d'un morceau + instru isolé de l'autre |
| Détection BPM | Inconnue, boîte noire | `librosa.beat.beat_track` (vrai beat-tracking), grille de beats complète exportée |
| Calage tempo | Semble constant sur tout le morceau (résultat, pas méthode) | Ratio global **+ correction PAR SEGMENT** (`buildTempoSchedule`) anti-décrochage rythmique, rubberband HQ avec repli atempo sécurisé |
| Détection de tonalité | Inconnue | Chroma CQT/CENS + corrélation profils majeur/mineur → notation Camelot |
| Harmonisation voix/instru | Inconnue | Transposition "roue de Camelot" (unisson/relative/voisine), pas un unisson forcé |
| Structure du morceau | Inconnue (mais durée de sortie variable = sélection d'une portion) | Segmentation chroma+MFCC, détection de "drops", sélection du meilleur segment |
| Post-traitement | Inconnu | Loudnorm EBU R128 2 passes, ducking sidechain lissé, déclick/déclip, EQ de présence, shelf "air" |
| Transition | Continue/superposée (déduit) | Crossfade réglable (3-12s) OU superposition voix/instru façon RaveDJ (mode Full Rave) |

**Constat principal : MacheUp n'a probablement rien à copier de RaveDJ sur le plan technique** — l'architecture stems + Librosa + Camelot + tempo par segment est déjà plus avancée que ce qu'on peut observer chez RaveDJ. La vraie question n'est pas "comment faire pareil que RaveDJ" mais "comment exploiter l'avantage déjà construit".

## Recommandations concrètes

1. **Ne pas chercher à imiter le "flou" de RaveDJ** — son absence apparente de séparation de sources est probablement une limite technique (coût de calcul à grande échelle pour un service gratuit), pas un choix de qualité supérieure. L'avantage stems de MacheUp est un différenciateur réel à mettre en avant, pas à sacrifier.

2. **Ajouter un mode "superposition complète" optionnel**, distinct du mode stems actuel — pour les utilisateurs qui préfèrent un rendu plus dense/brut façon RaveDJ (les 2 morceaux qui jouent "en même temps" sans isolation vocale). Techniquement peu coûteux : `combineTracks`/`mixQuick` existent déjà, il s'agirait surtout d'un nouveau réglage clairement étiqueté dans l'UI plutôt que d'un nouveau moteur.

3. **Vérifier/ajuster la sélection automatique de longueur de sortie.** RaveDJ ne mashe jamais les morceaux entiers bout à bout — il choisit une durée de sortie propre à chaque paire. MacheUp a déjà une logique de sélection de segment (`pickBestSegmentPair`, mentionnée dans les commentaires de `ffmpeg.js`) — vaut le coup de vérifier qu'elle est bien exposée/réglable dans l'UI, ce comportement de longueur "sur mesure" semble apprécié.

4. **Validation rigoureuse en prochaine étape (proposée, pas faite) :** faire tourner le VRAI analyseur Python de MacheUp (`analyzer_worker.py`, Librosa) directement sur un rendu RaveDJ téléchargé, au lieu de mon DSP JavaScript approximatif ci-dessus. Ça donnerait un BPM/une clé/une structure fiables à comparer avec les morceaux sources — actuellement non fait parce que `routes/analyze.js` attend un `videoId` YouTube (téléchargement via yt-dlp), pas une URL directe RaveDJ. Ajout nécessaire : une petite route qui télécharge le rendu RaveDJ côté serveur (même logique que le proxy média déjà en place) puis l'envoie tel quel à l'analyseur existant. Dites-moi si vous voulez que je construise ça — ça transformerait les hypothèses ci-dessus en mesures confirmées.

## En résumé

Rien dans ce qui a été observé ne suggère que RaveDJ utilise une technique que MacheUp ne maîtrise pas déjà, souvent en mieux (séparation réelle de sources, calage tempo par segment, harmonisation Camelot). Le point le plus concret à retenir est la **durée de sortie sur mesure par paire de morceaux**, à vérifier/renforcer côté MacheUp, et l'idée d'un **mode "superposition dense" optionnel** pour les utilisateurs qui préfèrent ce style au style stems actuel.
