# Rapport d'audit — MacheUp Studio — 25/08/2026

Contexte : suite à la clé API YouTube devenue invalide (voir échange du jour), analyse approfondie demandée sur deux volets : test fonctionnel du site en conditions réelles, et audit du code (en particulier tout ce qui a changé depuis le dernier audit du 26/07/2026).

## 1. Test fonctionnel en direct — **non réalisé**

Le backend (port 3001) et le frontend (port 5173) ne tournaient pas au moment de l'audit, et l'extension Chrome (nécessaire pour piloter ton navigateur depuis Claude) n'était pas connectée malgré son activation de ton côté.

**Pour débloquer ce volet**, il faudrait :
- Lancer l'appli (`start.ps1` / `start.bat`)
- Réinstaller/reconnecter l'extension Chrome (redémarrage complet de Chrome parfois nécessaire), en vérifiant que tu es connecté sur claude.ai avec le même compte que cette session

Dis-le-moi une fois fait et je referai le test fonctionnel (recherche YouTube avec la nouvelle clé, séparation stems, génération de mashup, export, DJPLAYLIST/MACHEUPDJ).

## 2. Ce qui a changé depuis l'audit du 26/07

Beaucoup de mouvement en un mois : nouvelle fonctionnalité **DJPLAYLIST** (assistant IA "décris la soirée", analyse en lot BPM/énergie, bibliothèque façon VirtualDJ avec dossier persistant), nouvelle page **MACHEUPDJ** (console 2 decks), un correctif critique (l'import PDF empêchait tout le backend de démarrer), et l'application des recommandations laissées ouvertes par l'audit précédent.

## 3. Vérification des points laissés ouverts en juillet — tous résolus

| Point ouvert (audit du 26/07) | État constaté aujourd'hui |
|---|---|
| Téléchargements cassés en cross-origin (pas de `Content-Disposition`) | **Corrigé** — `res.download()` généralisé à `mashup.js`, `stems.js`, `clipEditor.js`, `radio.js` ; helper centralisé `frontend/src/utils/download.js` |
| Pas de verrou anti-doublon sur `mashupMulti.js`, `mashupWheel.js`, `stems.js` | **Corrigé** — verrou généralisé aux 3 routes |
| Maps de jobs en mémoire jamais purgées | **Corrigé** — `services/jobCleanup.js` (purge toutes les 15 min, TTL 2h sur les jobs terminés), branché sur 9 routes |
| SSRF résiduel (DNS rebinding) | **Corrigé** — `urlSafety.js` résout maintenant le DNS et vérifie les IP obtenues, pas seulement l'hôte littéral |
| Secret de session par défaut codé en dur | **Corrigé** — secret aléatoire généré par démarrage si absent de `.env`, avec avertissement clair au lieu d'une valeur fixe |

Bilan : le dev qui a bossé dessus depuis juillet a traité sérieusement toute la liste, rien n'a été laissé de côté.

## 4. Deux crashs critiques corrigés en cours de route

- **Import PDF cassait tout le serveur** : `pdf-parse` (via `pdfjs-dist`/`@napi-rs/canvas`) plantait au chargement du module sur certaines machines Windows/Node, et comme le fichier était importé en haut de `server.js`, ça empêchait *tout* le backend de redémarrer — pas seulement l'import PDF. Corrigé par un import dynamique paresseux (chargé seulement quand un PDF est vraiment soumis).
- **Même risque identifié préventivement sur `sharp`** (génération de pochettes IA) et corrigé de la même façon avant qu'il ne cause le même type de panne.

Bon réflexe de fond à retenir pour la suite : tout package avec des dépendances natives (bindings compilés) devrait être importé dynamiquement plutôt qu'en haut de fichier, pour qu'un échec reste local à la route concernée.

## 5. Nouveau : vérification des clés API du projet

Après la découverte de la clé YouTube invalide, j'ai vérifié les autres clés présentes dans `backend/.env` :

- **YT_API_KEY** : invalide au début de la session → remplacée aujourd'hui, testée OK (200, vraies données)
- **GEMINI_API_KEY** : testée en direct → **valide**, répond normalement (liste de modèles Gemini 2.5)
- **AUDD_API_KEY** (reconnaissance façon Shazam) : non testée — l'API AudD attend un fichier audio en POST, pas un simple GET, donc pas de test rapide possible depuis ici. Le code gère déjà proprement le cas "quota anonyme épuisé, ajoute une clé" (`routes/recognize.js`), donc pas d'urgence si elle n'a jamais servi.

## 6. Nouvelles observations (mineures)

- **Code mort** : dans `backend/services/coverArt.js`, la fonction `fetchAlbumArt` a été désactivée le 02/08 (bannissement par l'API iTunes) et retourne toujours `null` — mais le `cache` (Map) et le `CACHE_TTL_MS` déclarés en haut du fichier ne servent plus à rien. Sans impact (juste un peu de nettoyage possible si tu repasses dans ce fichier).
- **DJPLAYLIST / bibliothèque persistante** (`frontend/src/utils/libraryDb.js`) : code propre, bien pensé — gère déjà les cas piégeux (dossiers OneDrive "à la demande" avec fichiers non téléchargés, dossiers illisibles, formats audio manquants) avec des compteurs de diagnostic clairs plutôt que des échecs silencieux. Rien à signaler.
- **`backend/routes/macheupdj.js`** (séparation de stems pour la console 2 decks) : pas de risque de traversée de chemin, les IDs de job sont générés côté serveur (UUID), les noms de fichiers uploadés sont contraints à une liste blanche d'extensions. Propre.
- **Points mineurs déjà connus et sciemment non traités** (usage perso, pas de risque réel) : accessibilité clavier basique (focus/Échap) sur les fenêtres flottantes, quelques `fetch` sans vérification `res.ok`, caches lyrics/Suno non bornés. Toujours vrai, toujours de priorité basse — je ne les ai pas retraités faute de nouvel élément qui changerait cette priorité.

## Prochaine étape

Le point bloquant pour aller plus loin, c'est le test en conditions réelles : démarre l'appli et vérifie côté Chrome que l'extension Claude se reconnecte, et je termine le test fonctionnel complet (nouvelle clé YouTube comprise).
