# Rapport de diagnostic — MacheUp Studio (v3, 26 juillet 2026)

3ème passe d'audit, plus poussée que les 2 précédentes (`rapport-audit-2026-07-26.md` et `-v2.md`) : 3 sous-agents en parallèle ont relu l'intégralité du code (pas des extraits) — un sur le frontend, un sur le backend, un dédié à la vérification stricte des 6 correctifs de la v2. Les 6 correctifs de la v2 sont **tous confirmés conformes**, sans exception (verrou analyze, `resolveOutputPath` durci, `/open-external` en `execFile`, les 3 grilles responsives, le champ DJMUP qui se vide, et les 2 pollings avec `res.ok`).

Les nouveaux constats ci-dessous sont classés par gravité. Ceux marqués **CORRIGÉ** ont été traités dans la foulée ; les autres sont listés pour arbitrage.

## Corrigé pendant cet audit

### 1. SSRF via `/api/radio` — URL de flux arbitraire non filtrée

`GET /api/radio/now-playing?url=...` et `POST /api/radio/record/start` acceptaient n'importe quelle URL fournie par le client sans restriction, contrairement à `mediaProxy.js`/`diag.js` qui limitent déjà leurs proxys à `rave.dj`. Une simple balise `<img src="http://localhost:3001/api/radio/now-playing?url=http://192.168.1.1/...">` sur une page web quelconque ouverte dans le même navigateur pouvait déclencher un scan du réseau local depuis ce backend (le CORS empêche de LIRE la réponse depuis cette page, pas d'ENVOYER la requête) ; `/record/start` allait plus loin en écrivant sur le disque le contenu d'une URL arbitraire via ffmpeg.

**Correctif** : nouveau `services/urlSafety.js` (`assertPublicHttpUrl`) qui rejette les protocoles autres que http/https et les hôtes en boucle locale/réseau privé (`localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, équivalents IPv6). Appliqué aux 2 routes, et re-vérifié à CHAQUE redirection HTTP suivie par `fetchIcyTitle` (`services/icyMetadata.js`) pour éviter qu'une URL publique légitime redirige ensuite vers une adresse interne. Portée volontairement limitée : pas de résolution DNS pour détecter un éventuel "DNS rebinding" (durdissement plus complet, hors de portée raisonnable pour une appli desktop non exposée à Internet).

### 2. Pas de verrou anti-doublon sur `POST /api/mashup` — la route la plus utilisée de l'app

Le verrou ajouté en v2 ne couvrait que `/api/analyze`. `routes/mashup.js` (chaque création de mashup, donc la route la plus sollicitée) n'avait aucune protection : un double-clic sur "Générer" relançait 2 pipelines complets en parallèle (téléchargement + Demucs GPU + ffmpeg) pour la même paire, avec le même risque de collision d'écriture dans le cache de stems partagé.

**Correctif** : même pattern qu'`analyze.js` — verrou en mémoire par `(idA, idB, mode, stemMode, durationMode)`, uniquement pour les paires YouTube (un upload de fichier local génère de toute façon un nom unique à chaque fois, pas de vraie collision possible). Une 2ème requête pour la même paire reçoit le `jobId` déjà en cours.

### 3. Extension de fichier uploadé non validée avant réutilisation dans une commande shell

`routes/mashup.js` (upload direct) et `routes/clipEditor.js` (upload de piste retravaillée) dérivaient le nom de fichier disque de `extname(file.originalname)` — fourni tel quel par le client — puis ce chemin est réinjecté sans échappement dans des commandes `ffmpeg` (`exec()` avec interpolation de chaîne, `services/clipEditor.js`). Sur Windows, NTFS interdit déjà le caractère `"` dans un nom de fichier, ce qui bloque en pratique l'évasion la plus simple — mais s'appuyer sur cette limite incidente du système de fichiers plutôt que sur une validation explicite est fragile.

**Correctif** : whitelist explicite d'extensions audio connues (`.mp3/.wav/.flac/.m4a/.ogg/.aac/.opus/.webm`), repli sur `.mp3` sinon — dans les 2 fichiers concernés.

### 4. Nettoyage de code mort

`backend/services/.sync-check-icyMetadata.js` (fichier de vérification temporaire, jamais retiré, non référencé nulle part) supprimé.

### 5. Fuite `AudioContext` — épuise une limite navigateur, casse l'aperçu live des stems

`ComboPanel.jsx` et `Deck.jsx` créent chacun un `AudioContext` (moteur d'aperçu live des stems / visualiseur de fichier uploadé) mais ne le fermaient jamais. Problème concret : `ComboPanel` n'est monté QUE si on est en mode 2 decks (`isDuo`), et les Decks C/D/E peuvent être ajoutés/retirés (`removeDeck()`) — chaque passage 2 ↔ multi-decks, ou ajout/retrait d'un deck avec fichier local, laissait un `AudioContext` ouvert indéfiniment. Les navigateurs (Chrome en tête) limitent le nombre d'`AudioContext` non fermés par onglet (~4-6) : après plusieurs allers-retours, `new AudioContext()` finissait par échouer silencieusement et l'aperçu live des stems (fonction centrale du panneau COMBO) cessait de fonctionner jusqu'à un rechargement de page complet.

**Correctif** : fermeture explicite (`.close()`) de l'`AudioContext` au démontage des 2 composants.

### 6. Fuite de `setInterval` — suivi de progression YouTube dupliqué en arrière-plan

Dans `Deck.jsx`, l'intervalle de suivi de progression (`onStateChange` du lecteur YouTube) était réassigné à chaque événement `PLAYING` sans annuler le précédent. Si 2 événements `PLAYING` arrivaient d'affilée (resynchronisation après un `seekTo`, changement de qualité auto...), l'ancien intervalle continuait de tourner indéfiniment en parallèle, invisible pour le cleanup de démontage qui ne connaît que le dernier assigné.

**Correctif** : `clearInterval()` systématique juste avant toute réassignation.

### 7. Race condition sur la pioche aléatoire (Mashup Wheel + DJMUP)

`drawRandomMatch` (dans les 2 pages) lance un `fetch` non annulable sans aucune protection anti-obsolescence, contrairement à tous les autres pollings de l'app. Si le Deck A change PENDANT que la requête est en vol, sa réponse tardive pouvait écraser l'état avec un résultat calculé pour l'ANCIEN morceau, affiché à tort comme valide.

**Correctif** : garde par génération (réutilisation du `generationRef` déjà existant dans `MashupWheel.jsx`, ajout d'un équivalent dans `Ext.jsx`) — un résultat qui arrive après un changement de Deck A est désormais silencieusement ignoré.

## Vérifié — les 6 correctifs de la v2 tiennent la route

Passe de vérification stricte (cas limites testés sur `resolveOutputPath` : traversée `../`, url `null`, préfixes trompeurs — tous bloqués correctement) : **aucun problème trouvé**, rien à rouvrir.

## Points restants (non corrigés — à trancher avec toi)

- **Téléchargements probablement cassés en cross-origin** : `/outputs` est servi par `express.static` (server.js) SANS en-tête `Content-Disposition`. Les boutons "⬇ FLAC/MP4/pochette/stems" de `CoverGenerator.jsx`, `MashupProgressModal.jsx`, `MashupStudio.jsx`, `Mixer.jsx` (branche FLAC), `ClipEditor.jsx` (stems) et `MashupsBar.jsx` (qui utilise carrément `window.open` — ouvre le fichier au lieu de le télécharger) reposent sur l'attribut HTML `download`, que les navigateurs ignorent en cross-origin (frontend :5173 → backend :3001 = origines différentes). `routes/stems.js` et `routes/clipEditor.js` ont déjà le bon pattern ailleurs (`res.download()` qui force `Content-Disposition`) — à généraliser aux autres si tu confirmes que ces boutons ne téléchargent effectivement pas chez toi. Je ne l'ai pas corrigé seul : ça touche ~6 fichiers frontend + plusieurs routes backend à créer, et mériterait un test réel dans ton navigateur d'abord.
- **SSRF résiduel (DNS rebinding)** : le garde-fou ajouté sur `/api/radio` bloque les IP privées littérales, mais pas un nom de domaine public qui résoudrait vers une IP interne. Risque faible et sophistiqué à exploiter, mentionné pour transparence.
- **Pas de verrou anti-doublon sur les autres routes lourdes** : `mashupMulti.js`, `mashupWheel.js` (`/start`), `stems.js` (`/start`) ont le même risque de double-lancement qu'`analyze.js`/`mashup.js` avant correctif — non traité cette fois (route par route, à généraliser si tu veux).
- **`Maps` de jobs en mémoire jamais purgées** : `mashupWheel.js`, `mashupMulti.js`, `stems.js`, `clipEditor.js`, `ravedjAuto.js`, `radio.js` (recordings) grossissent indéfiniment sur une session serveur longue (pas de TTL/purge). Impact limité pour un usage perso avec redémarrages fréquents.
- **Cohérence recherche/lien collé** : seul `Ext.jsx` sait reconnaître un lien YouTube collé directement dans son champ de recherche — coller un lien dans `Deck.jsx` (Studio/MachWheel) ou `ClipEditor.jsx` lance une recherche texte inefficace. À généraliser si utile.
- **Accessibilité de base** : aucune fenêtre flottante (Lyrics/Prompt Suno/Shazam/DjAssist/pochette/mentions légales) ne gère le focus clavier ni la touche Échap ; plusieurs boutons ✕/icônes seules sans `aria-label`. Cohérent avec un usage perso, à améliorer seulement si ça gêne réellement.
- **Détails mineurs** : quelques `fetch` ponctuels (hors polling, déjà tous corrects) sans vérification `res.ok` dans `MashupStudio.jsx`/`CoverGenerator.jsx`/`ClipEditor.jsx` ; caches `lyricsCache`/`sunoCache` non bornés ; secret de session par défaut codé en dur si `.env` absent ; enregistrement radio non coupé si le client ferme la connexion avant `/stop` (le garde-fou dur à 20 min limite l'impact).

## Vérification finale

Build frontend (esbuild, 360.7kb) et syntaxe de tous les fichiers backend modifiés (`node --check`) : tous OK, aucune régression.
