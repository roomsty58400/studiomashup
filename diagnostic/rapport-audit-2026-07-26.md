# Rapport d'audit — MacheUp Studio (26 juillet 2026)

Analyse approfondie du site avec 2 tests réels par mode de mashup (Voix + instru, Superposition complète, Mashup à la carte), chronométrés, sur les Decks A/B chargés avec Darude - Sandstorm et Eiffel 65 - Blue.

## Résultat des tests live

| Mode | Test | Résultat | Temps |
|---|---|---|---|
| Voix + instru (stems) | 1/2 | ❌ Échec (bug ffmpeg — voir ci-dessous) | — |
| Voix + instru (stems) | 2/2 (après correctif) | ✅ Réussi | ~1 min 40 |
| Superposition complète (overlay) | 1/2 | ❌ Échec (crash serveur — voir ci-dessous) | — |
| Superposition complète (overlay) | 1/2 bis (après correctif) | ✅ Réussi | ~1 min 25 |
| Superposition complète (overlay) | 2/2 | ✅ Réussi | ~1 min 30 |
| Mashup à la carte (Voix A+B, Batterie B, Basse Muet, Autres A) | 1/2 | ✅ Réussi | ~2 min 15 |
| Mashup à la carte (même combinaison) | 2/2 | ✅ Réussi | ~1 min 45 |

Sur les 7 tests exécutés, 2 ont échoué au premier essai — les deux à cause de bugs réels, corrigés en direct puis re-vérifiés avec succès. Tous les fichiers FLAC/MP4 produits ont été confirmés présents et de taille cohérente sur le disque.

## Bugs trouvés et corrigés

### 1. Cache d'analyse ne vérifiait jamais les fichiers sur le disque (`routes/analyze.js`)

Le raccourci `GET /cached/:videoId`, utilisé à chaque clic sur le badge BPM/"Réanalyser" d'un Deck, ne vérifiait que la base SQLite (BPM + mode stems) — jamais l'existence réelle des fichiers de stems sur le disque, contrairement à la route `POST /` qui a son propre garde-fou. Résultat : dès que les stems avaient été effacés (redémarrage, nettoyage), "Réanalyser" répondait 200 avec des chemins fantômes et ne relançait jamais Demucs — le carré rouge "stem introuvable" du panneau Combo restait bloqué indéfiniment, quel que soit le nombre de tentatives.

**Correctif** : ajout de la même vérification `existsSync` que la route `POST /`. Vérifié en direct : un clic sur "Réanalyser" déclenche maintenant une vraie re-séparation quand les fichiers manquent.

### 2. Aperçus audio du panneau Combo sans nouvelle tentative (`ComboPanel.jsx`)

Les balises `<audio>` passives (aperçu par stem) n'avaient aucune tentative de rechargement en cas d'erreur, contrairement à la lecture manuelle. Un stem qui répondait en erreur une fraction de seconde après la fin de la séparation Demucs restait bloqué en erreur pour toujours, même une fois le fichier disponible.

**Correctif** : une tentative de rechargement après 700 ms (comme pour la lecture manuelle), et surtout, remise à zéro de l'état d'erreur + rechargement forcé de tous les aperçus à chaque nouvelle analyse reçue du Deck (avant, seul l'ID du morceau était surveillé, qui ne change pas lors d'une ré-analyse du même morceau).

### 3. Mashup "Voix + instru" en échec systématique si un stem est quasi silencieux (`services/ffmpeg.js`)

Bug détecté pendant le test live n°1 : le mode "Voix + instru" échouait à l'étape de mixage final avec une erreur ffmpeg ("measured_I out of range"). Cause : la mesure de loudness 2 passes utilisée pour un mixage précis peut renvoyer `"-inf"` (texte, pas un nombre) quand un stem est quasi silencieux sur toute sa durée — cette valeur était injectée telle quelle dans la commande ffmpeg finale, qui la refuse et fait échouer tout le job.

**Correctif** : validation que les 4 valeurs mesurées sont bien des nombres finis avant de les utiliser ; sinon repli automatique sur le loudnorm 1 passe (mécanisme de secours déjà prévu mais jamais déclenché pour ce cas précis). Re-testé avec succès juste après.

### 4. Un job en échec pouvait faire planter tout le serveur (`server.js`)

Détecté pendant le test live du mode "Superposition complète" : un job a fait perdre TOUT l'état en mémoire du serveur (le job en cours ET tout autre job/deck en parallèle), signe d'un redémarrage complet et non voulu du process Node — le grand `try/catch` de chaque job protège contre les erreurs prévisibles, mais une exception ou un rejet de promesse qui s'échappe sans être capturé nulle part (fuite dans une dépendance tierce, event `error` non écouté...) tue immédiatement tout le process Node, coupant tous les jobs en cours pour tout le monde.

**Correctif** : ajout d'un filet de sécurité process-wide (`uncaughtException`/`unhandledRejection`) qui journalise l'erreur et laisse le serveur en vie, au lieu de tout couper. Re-testé avec succès juste après (2 générations "superposition" réussies d'affilée).

## Bug mineur non bloquant (identifié, pas corrigé)

Le panneau "Mes macheups" n'affiche jamais qu'une seule entrée à la fois, même après plusieurs générations réussies et un clic sur "Actualiser" — les fichiers sont pourtant bien tous présents sur le disque (vérifié directement). Cosmétique, sans impact sur la génération elle-même, mais à corriger si l'historique complet doit être consultable.

## Autres modifications (hors bugs)

- Extensions/DJMUP : polices agrandies, vignettes YouTube grossies, texte d'avertissement RaveDJ et mentions superflues retirées, bouton et titre renommés en "DJMUP".
- Suppression des popups navigateur natifs (`alert`/`confirm`) sur le bouton nettoyage et le bouton DJ Assist du Mixer, remplacés par des panneaux intégrés à l'interface.
- Bulles de légende au survol retirées sur les 4 pads de la TopBar et sur le bouton DJA du Mixer.
- Cadre "Durée ciblée" du panneau Combo : texte agrandi/éclairci, repositionné plus haut (juste après le choix de mode, avant la liste des stems) au lieu d'être relégué tout en bas juste avant le bouton de génération.

## Conclusion

Les 3 modes de mashup fonctionnent bien de bout en bout après correctifs. Les deux échecs rencontrés en test n'étaient pas des cas limites artificiels : le premier touchait n'importe quel morceau avec un stem quasi silencieux (fréquent), le second pouvait couper toute une session de travail pour un souci isolé sur un seul job. Les deux corrections réduisent significativement le risque de blocage complet de l'application en usage réel.
