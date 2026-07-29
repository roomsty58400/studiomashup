# Rapport de diagnostic — MacheUp Studio (v2, 26 juillet 2026)

Nouvelle passe d'audit demandée après une longue session de développement (refonte du cadre COMBO, corrections DEMO/preset, ajout de la pioche aléatoire base de données dans Mashup Wheel et DJMUP, correctifs de hauteur/fenêtres flottantes dans DJMUP). Contrairement au rapport du 26 juillet initial, cette passe n'a **pas pu inclure de test live en navigateur** : l'extension Claude in Chrome n'est disponible que sur Chrome, or elle est installée sur Edge de ce côté-ci — l'audit est donc une relecture de code approfondie (frontend + backend), pas une vérification à l'écran.

Méthode : 3 passes indépendantes en parallèle (frontend React, backend Node, vérification ciblée des changements de cette session), puis synthèse et correction des points les plus sérieux.

## Corrigé pendant cet audit

### 1. Faille de sécurité — injection shell via `videoId` (`services/ytdlp.js`)

`downloadAudio`/`downloadVideo` interpolaient `videoId` directement dans une commande shell (`execAsync`) et dans un chemin de cache disque, sans aucune validation. Le frontend ne fournit normalement que des ids YouTube valides, mais rien ne l'imposait côté serveur : un `videoId` malformé (métacaractères shell, ou `../../x`) aurait pu exécuter une commande arbitraire ou écrire hors du dossier de cache.

**Correctif** : un id YouTube valide fait toujours exactement 11 caractères alphanumériques/`_`/`-` — vérifié maintenant au tout début de `downloadAudio`/`downloadVideo` (rejet immédiat sinon), ce qui protège tous les appelants (analyse, mashup, stems, mashup wheel) d'un seul endroit.

### 2. Fuite disque — dossiers d'analyse en échec jamais nettoyés (`routes/analyze.js`)

Un `finally` conservait volontairement le dossier temporaire (audio téléchargé inclus) de **tout** job d'analyse en échec, pour un diagnostic ponctuel d'un crash Python déjà résolu depuis (la reprise automatique en 2 temps de `analyzer.js`). Ce code de diagnostic n'avait jamais été retiré : chaque échec (vidéo indisponible, privée, géo-bloquée...) laissait un dossier complet sur le disque, jamais balayé par `cleanup.js`.

**Correctif** : nettoyage systématique restauré. Au passage, 24 scripts Python orphelins (`_analyze_*.py`, artefacts d'avant la relocalisation des scripts temporaires vers `backend/tmp/`) et 2 fichiers FLAC égarés (~31 Mo) à la racine du backend ont été supprimés.

### 3. Aperçu solo d'un stem coupé sans raison (`ComboPanel.jsx`)

La logique de réconciliation du player de combinaison réagissait à **tout** changement de sélection de stem (voix/batterie/basse/autres confondus) : modifier l'état d'un stem pendant l'aperçu solo d'un **autre** stem coupait ce dernier sans raison apparente.

**Correctif** : l'aperçu solo ne s'arrête plus que si c'est le stem **en cours d'écoute lui-même** qui passe à 🔇 Muet — un réglage sur un autre stem n'a plus d'effet sur l'aperçu en cours.

### 4. Nettoyage de code mort (frontend)

7 composants jamais importés nulle part (restes d'anciennes versions de l'app, antérieurs à l'interface actuelle des Decks/Lyrics/Prompt Suno) supprimés : `DeckSearch.jsx`, `AudioUploader.jsx`, `AudioPlayer.jsx`, `Exporter.jsx`, `PromptModal.jsx`, `Toast.jsx`, `ModalBase.jsx`.

## Vérifié — les changements de cette session tiennent la route

Passe de vérification ciblée sur les 7 derniers changements (moteur de position horloge de ComboPanel, refonte du cadre COMBO, correctif `presetAppliedRef`, câblage `sendToExt`/DJMUP, nouvelle route `random-match`, les 2 nouvelles pioches aléatoires, hauteur fixe des Decks DJMUP) : **tous confirmés corrects**, aucune régression trouvée.

Un point à confirmer avec toi plutôt qu'un bug : depuis la suppression du bouton "changer" sur les Decks de DJMUP (à ta demande), il n'existe plus aucun moyen de rouvrir la recherche pour changer la source d'un Deck une fois un morceau chargé sur cette page — seuls les Decks A/B de MacheUp Studio, la pioche aléatoire ou "Mashup Wheel → Générer dans DJMUP" peuvent désormais y déposer un morceau. C'est la conséquence directe et voulue de ta demande, mais je préfère vérifier que c'est bien l'usage prévu avant de considérer le sujet clos.

## Points restants (non corrigés — à trier avec toi)

- **Backend, pas de verrou par `videoId` dans `/api/analyze`** : deux requêtes simultanées pour le même morceau (double-clic, ou 2 Decks chargeant la même vidéo) lancent chacune leur propre séparation Demucs dans le même dossier de sortie — pas de plantage, mais calcul GPU gaspillé et risque de fichiers partiellement écrasés par le perdant de la course.
- **Backend, vérification de confinement de chemin trop permissive** (`services/trackPreparation.js`) : un simple test `startsWith(outputsDir)` sans séparateur de fin — inoffensif aujourd'hui (aucun dossier voisin ne porte un nom qui collisionnerait), mais fragile si un tel dossier apparaît un jour.
- **Backend, route `/open-external`** (`routes/mashup.js`) : outil de dev explicitement marqué "à retirer avant déploiement", interpolation shell non échappée — actuellement peu risqué (chemins UUID/alphanumériques uniquement) mais sans garde-fou si ça change.
- **Frontend, mises en page non responsives** : la rangée Deck A/Deck B/Rendu de DJMUP (3 colonnes fixes), la roue de Mashup Wheel (taille fixe ~520px) et la grille 2 colonnes du cadre COMBO peuvent se retrouver serrées/rognées sous ~900-1000px de large. Pas bloquant à la résolution habituelle d'usage, mais à garder en tête si la fenêtre est redimensionnée en dessous.
- **Frontend, cosmétique** : le champ de collage de lien du lecteur de rendu DJMUP ne se vide pas après chargement ; 2 appels réseau ne vérifient pas `res.ok` avant de lire la réponse JSON (message d'erreur générique au lieu du vrai code HTTP en cas de panne serveur).

## Mise à jour — tous les points restants corrigés (26 juillet 2026, plus tard le même jour)

Les 5 points listés dans "Points restants" ci-dessus ont été traités à la demande :

- **Verrou par `videoId` dans `/api/analyze`** : une 2ème requête pour le même morceau (même `videoId` + même `stemMode`) pendant qu'une analyse tourne déjà reçoit désormais directement le `jobId` en cours, au lieu de déclencher une 2ème séparation Demucs en parallèle sur le même dossier de sortie.
- **`trackPreparation.js`, confinement de chemin** : le test `startsWith(outputsDir)` exige maintenant soit une égalité stricte, soit `outputsDir` suivi du séparateur de chemin — un dossier voisin dont le nom partagerait le même préfixe ne peut plus passer le test par erreur.
- **`/open-external`** : les commandes `exec()` (chaîne shell) ont été remplacées par `execFile()` (argv séparé, VLC ou `explorer.exe` en repli) — le chemin du fichier n'est plus jamais interprété par un shell, quel que soit son contenu.
- **Mises en page non responsives** : la grille 3 colonnes de DJMUP et la grille 2 colonnes du cadre COMBO passent en `repeat(auto-fit, minmax(...))` (colonnes qui basculent à la ligne au lieu de se faire écraser) ; la roue de Mashup Wheel (taille fixe, coordonnées SVG non convertibles facilement en %) devient scrollable horizontalement sous ~560px plutôt que rognée.
- **Cosmétique** : le champ de lien du lecteur DJMUP se vide maintenant après "CHARGER" ; et surtout, en creusant le 2ème point ("2 appels réseau sans `res.ok`"), un vrai bug de la même famille que le "job introuvable" déjà rencontré dans Mashup Wheel a été trouvé et corrigé dans `MashupProgressModal.jsx` (utilisé par MashupStudio pour le suivi de tout mashup/mashup-multi) et dans le polling `ravedj-auto` de DJMUP : un job perdu après un redémarrage backend faisait tourner la roue de progression indéfiniment en silence au lieu d'afficher une erreur claire.

Vérifié : build frontend (esbuild, 360.0kb) et syntaxe backend (`node --check` sur `server.js`, `routes/analyze.js`, `routes/mashup.js`, `services/trackPreparation.js`) tous OK, aucune régression.

## Conclusion

3 bugs réels corrigés en 1ère passe (dont une vraie faille de sécurité, même si le risque pratique reste faible pour une appli strictement locale/usage personnel), plus 1 bug supplémentaire de la famille "job introuvable" trouvé en creusant les points restants, et un nettoyage de fichiers morts/orphelins effectué. L'ensemble des points relevés dans ce rapport est maintenant corrigé.
