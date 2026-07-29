import React, { useState, useEffect, useRef } from "react";
import Footer from "../components/Footer.jsx";

// Page "EXT." (4e pad du bloc MACHEUP / CLIP EDITOR / MACHEUP WHEEL / EXT.,
// cf. TopBar.jsx) — conteneur pour les outils/extensions du site.
//
// ── Fenêtre d'émulation RaveDJ (juillet 2026, demande explicite) ──────────
// "créer une fenêtre émulation qui puisse à la fois émuler la page de
// rave.dj et utiliser deck A et deck B et laisser rave.dj me proposer sa
// solution" — comparer le résultat "maison" (MacheUp) à celui d'un service
// tiers de référence, sur LES MÊMES 2 morceaux, sans quitter l'app.
//
// Ce qui est RÉELLEMENT possible ici, vérifié en conditions réelles avant
// d'écrire ce composant (pas supposé) :
//  - rave.dj PEUT être affiché dans un <iframe> — testé directement (aucun
//    en-tête X-Frame-Options/CSP ne bloque l'affichage, contrairement à
//    beaucoup de sites qui l'interdisent).
//  - EN REVANCHE, un iframe pointant vers un AUTRE domaine (cross-origin)
//    est totalement opaque en JavaScript, par sécurité navigateur : notre
//    code ne peut ni lire ni écrire quoi que ce soit dans la page rave.dj
//    affichée (pas de remplissage automatique de son champ de recherche).
//    Aucune URL publique de rave.dj ne permet non plus de pré-remplir les 2
//    morceaux via ses paramètres (essayé plusieurs formats plausibles en
//    conditions réelles — aucun ne fonctionne, rave.dj renvoie "Page not
//    found"). Le "utiliser Deck A et B" se traduit donc concrètement par :
//    copier en 1 clic le lien YouTube de chaque Deck, à coller soi-même
//    dans la recherche rave.dj affichée juste à côté — 2 clics au lieu de
//    ressaisir manuellement titre/artiste. Honnête plutôt que de prétendre
//    à un remplissage automatique qui n'est techniquement pas possible.
//  - Le résultat produit par rave.dj (côté rave.dj, sur SES serveurs) reste
//    entièrement dans son propre cadre — MacheUp n'y touche pas et ne peut
//    pas le récupérer (toujours la même barrière cross-origin).
//
// ── Tentative de masquage des zones promo (juillet 2026) ─────────────────
// Demande : masquer les carrousels "Trending Mashups/Mixes/DJs", "Gagnants
// des défis" et les 2 cartes de mode, rayés en rouge sur 2 captures fournies.
// Un overlay pixel par-dessus l'iframe ne peut pas fonctionner (cross-origin
// = scroll interne invisible depuis notre page). Solution tentée : un proxy
// backend (routes/ext.js) qui sert une copie de la page rave.dj avec un
// script injecté masquant ces zones par leur texte réel. TESTÉE EN CONDITIONS
// RÉELLES : la page proxyée reste blanche — l'app RaveDJ (React) démarre
// (son bundle JS s'exécute, ex. init Firebase visible en console) mais ne
// rend RIEN à l'écran une fois servie depuis un autre domaine que rave.dj
// (0 élément `.app`/`.features-category` dans le DOM après chargement) : elle
// dépend très probablement d'appels internes (API, auth, cookies de session)
// restreints à son propre domaine, qui échouent silencieusement hors de
// rave.dj — sans doute pour des raisons de CORS. Casser l'app entière pour
// masquer 4 carrousels n'est pas un compromis acceptable : le proxy a donc
// été abandonné, revenu à l'iframe directe (fonctionnelle) ci-dessous, zones
// promo visibles. routes/ext.js reste dans le repo si l'idée est reprise un
// jour (ex. si rave.dj expose une vraie API sans ces restrictions).
//
// ── Automatisation "en fenêtre masquée" (juillet 2026, demande explicite) ──
// "automatiser en fenêtre masquée ... pour pas qu'on voit ces manips" — le JS
// de CETTE page ne peut toujours pas piloter l'iframe RaveDJ (même barrière
// cross-origin que ci-dessus). La séquence (coller lien A, entrée, attendre,
// coller lien B, entrée, attendre, valider "CRÉER UN MASHUP") est donc
// exécutée côté BACKEND par un Chromium headless dédié (Puppeteer,
// services/ravedjAutomation.js) — aucune fenêtre n'apparaît jamais à
// l'écran, ce n'est pas cet iframe-ci qui est piloté. Bouton "🤖 AUTO"
// ci-dessous : lance le job, affiche juste une étiquette de progression
// pendant que ça tourne en arrière-plan, remplit automatiquement le lecteur
// de rendu une fois terminé.
// Limite honnête : nécessite `puppeteer` installé côté backend (npm install,
// geste que l'utilisateur doit faire lui-même une fois) — non testable de
// bout en bout par Claude avant le premier essai réel (RaveDJ est un site
// tiers, ses sélecteurs peuvent changer sans préavis).
const API = "http://localhost:3001";

// Construit l'URL YouTube "canonique" à partir d'un id vidéo — même format
// que celui utilisé partout ailleurs dans l'app pour désigner une source.
const youtubeUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const youtubeEmbedUrl = (id) => `https://www.youtube.com/embed/${id}`;

// ── Correctif "la vidéo ne charge pas" (root-causé en conditions réelles) ──
// Le rendu final RaveDJ (https://assets2.rave.dj/videos/<id>.mp4) est servi
// par leur CDN avec "Content-Type: binary/octet-stream" au lieu de
// "video/mp4" (confirmé via une requête HEAD directe) — un <video> HTML
// refuse de le lire avec cet en-tête générique (reste en chargement infini,
// sans erreur visible). On fait donc passer ces URLs par le petit proxy
// backend (routes/mediaProxy.js) qui reserre le même fichier avec le bon
// Content-Type. Un lien collé manuellement qui n'est PAS un lien rave.dj
// (ex. fichier local déjà servi par notre propre backend) passe, lui,
// directement — pas besoin de proxy, et le proxy le refuserait de toute
// façon (accès restreint à rave.dj, cf. mediaProxy.js).
const mediaSrc = (url) => {
  if (!url) return url;
  try {
    const host = new URL(url).hostname;
    if (host === "rave.dj" || host.endsWith(".rave.dj")) {
      return `${API}/api/media-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {
    // URL non parsable (ne devrait pas arriver) — on la laisse telle quelle.
  }
  return url;
};

// Reconnaît un lien YouTube collé directement (watch?v=, youtu.be/, shorts/,
// embed/) pour en extraire l'id sans repasser par une recherche — même
// tolérance de formats que ce que l'utilisateur pourrait coller depuis la
// barre d'adresse ou le bouton "Partager" de YouTube.
const YOUTUBE_URL_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const extractYoutubeId = (text) => {
  const m = (text || "").match(YOUTUBE_URL_RE);
  return m ? m[1] : null;
};

// ── Carte source d'un Deck (juillet 2026, demande explicite) ─────────────
// "faire apparaitre le contenu youtube de chaque deck, ou si on n'est pas
// passé par la page MacheUp de pouvoir taper des clips dans chaque deck" —
// si un morceau est chargé côté MashupStudio (studioTrack, via currentTracks
// remonté dans App.jsx), on l'affiche directement (lecteur YouTube embarqué).
// Sinon (ou si l'utilisateur veut changer), recherche/collage direct d'un
// lien YouTube ICI, indépendamment de MashupStudio.
// `override`/`onOverrideChange` : remontés au parent (Ext) — nécessaire pour
// que le bouton AUTO sache quel morceau est effectivement affiché sur
// chaque Deck, override ou non.
function DeckSourceCard({ letter, color, studioTrack, override, onOverrideChange }) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const searchAbortRef = useRef(null);
  const debounceRef = useRef(null);

  const track = override || studioTrack;

  // Recherche effective (extraite pour être appelée à la fois par la
  // recherche "au fil de la frappe" ci-dessous et par Entrée/le bouton 🔍).
  const doSearch = async (q) => {
    const id = extractYoutubeId(q);
    if (id) {
      // Lien direct collé : pas besoin de chercher, id connu immédiatement.
      // Titre/chaîne inconnus (pas d'appel API pour un simple lien) — le
      // lecteur embarqué ci-dessous suffit pour identifier le morceau.
      onOverrideChange({ id, title: "", channel: "" });
      setEditing(false);
      setResults([]);
      setSearchError(null);
      return;
    }
    if (!q || q.trim().length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    // Annule la recherche précédente encore en vol (même principe que
    // Deck.jsx) : sans ça, une réponse plus ancienne arrivant après une plus
    // récente écraserait les bons résultats par des résultats obsolètes.
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`${API}/api/youtube/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (Array.isArray(data)) {
        // Plafonné à 6 avant ce correctif — bien en-deçà des 50 résultats
        // que le backend récupère déjà auprès de l'API YouTube
        // (routes/youtube.js, maxResults=50). La liste est déjà dans un
        // conteneur défilant (maxHeight 280 + overflowY auto ci-dessous),
        // donc rien n'empêchait d'en montrer davantage — juste une limite
        // arbitraire trop basse ici (retour utilisateur : "le nombre de
        // clips proposés a l'air réduit").
        setResults(data.slice(0, 25).map(item => ({ id: item.videoId, title: item.title, channel: item.channel, thumb: item.thumbnail })));
      } else {
        setResults([]);
        setSearchError(data?.error || "Recherche YouTube indisponible.");
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      setSearchError(`Recherche impossible : ${e.message}`);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };

  // Recherche automatique "au fil de la frappe" (comme la barre de recherche
  // des Decks dans MashupStudio, cf. Deck.jsx) — corrige le fait que rien ne
  // se passait tant qu'on n'appuyait pas sur Entrée ou ne cliquait pas 🔍,
  // ce qui donnait l'impression qu'aucune proposition n'apparaissait jamais.
  // Debounce 350ms pour ne pas spammer l'API YouTube à chaque caractère.
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 350);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Entrée / bouton 🔍 : recherche immédiate, sans attendre le debounce.
  const runSearch = () => {
    clearTimeout(debounceRef.current);
    doSearch(query);
  };

  const pick = (r) => {
    onOverrideChange(r);
    setEditing(false);
    setResults([]);
    setQuery("");
  };

  return (
    <div style={{
      background: "var(--surface2)", border: `1px solid ${color}55`, borderRadius: 10,
      padding: "10px 12px", flex: 1, minWidth: 0,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6,
      }}>
        <span style={{
          fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 1, fontSize: 14, color,
        }}>
          DECK {letter}
        </span>
      </div>

      {track && !editing ? (
        <>
          {/* Hauteur FIXE (retour utilisateur, juillet 2026 : "fixe la
              hauteur des decks A à B avec les vidéos youtube") — avant,
              paddingTop 56.25% calait la hauteur sur la largeur du ratio
              16:9, ce qui pouvait très légèrement différer entre Deck A et
              Deck B selon leur contenu (titre/chaîne sur 1 ou 2 lignes
              faisant varier la hauteur totale de la carte). Une hauteur en
              pixels fixe garantit que les 2 lecteurs vidéo font toujours
              EXACTEMENT la même hauteur, quel que soit le contenu autour. */}
          <div style={{
            position: "relative", width: "100%", height: 220, marginBottom: 8,
            borderRadius: 6, overflow: "hidden", background: "#000",
          }}>
            <iframe
              key={track.id}
              src={youtubeEmbedUrl(track.id)}
              title={`YouTube Deck ${letter}`}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
              allow="encrypted-media; picture-in-picture"
            />
          </div>
          {/* Titre + chaîne TOUJOURS rendus (avec un espace insécable en
              secours si vides) plutôt que conditionnés à leur présence —
              retour utilisateur, juillet 2026 : "les deux decks n'ont pas la
              même hauteur". Root cause réelle : quand track.channel est
              absent (lien collé directement, ou vidéo sans chaîne connue),
              cette 2e ligne disparaissait entièrement, réduisant la hauteur
              TOTALE de la carte d'une ligne — donnant 2 decks de hauteurs
              différentes même avec la vidéo elle-même déjà fixée à 220px
              juste au-dessus. Toujours réserver les 2 lignes, vides ou non,
              garantit une hauteur de carte identique dans tous les cas. */}
          <div style={{
            fontSize: 15, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", marginBottom: 3, minHeight: 18,
          }} title={track.title || ""}>
            {track.title || " "}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 8, minHeight: 16 }}>
            {track.channel || " "}
          </div>
        </>
      ) : (
        <div>
          {!track && (
            <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.5, marginBottom: 8 }}>
              Aucun morceau chargé sur ce Deck dans MacheUp Studio — cherche un titre ou colle un lien YouTube.
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="Titre, artiste, ou lien YouTube..."
              autoComplete="off"
              name={`ext-deck-search-${letter}`}
              style={{
                flex: 1, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6,
                color: "var(--text)", fontSize: 13, padding: "7px 9px", minWidth: 0,
              }}
            />
            <button onClick={runSearch} disabled={searching} style={{
              padding: "7px 12px", borderRadius: 6, background: `${color}22`,
              border: `1px solid ${color}55`, color, fontSize: 13, fontWeight: 800, cursor: "pointer",
            }}>{searching ? "..." : "🔍"}</button>
            {editing && (
              <button onClick={() => { setEditing(false); setResults([]); }} style={{
                padding: "7px 12px", borderRadius: 6, background: "transparent",
                border: "1px solid var(--border)", color: "var(--muted2)", fontSize: 13, cursor: "pointer",
              }}>✕</button>
            )}
          </div>
          {searchError && (
            <div style={{ fontSize: 12, color: "#ff6666", marginBottom: 6 }}>{searchError}</div>
          )}
          {/* Vignettes agrandies (retour utilisateur, juillet 2026 : "grossir
              les vignettes rendu youtube") — 112x84 (ratio proche des
              miniatures YouTube réelles) au lieu de 48x36, pour que le
              titre/chaîne à côté soit identifiable sans avoir à zoomer. */}
          {results.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
              {results.map(r => (
                <button key={r.id} onClick={() => pick(r)} style={{
                  textAlign: "left", background: "var(--surface)", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "7px 9px", cursor: "pointer", color: "var(--text)",
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  {r.thumb ? (
                    <img src={r.thumb} alt="" style={{ width: 112, height: 84, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 112, height: 84, borderRadius: 6, background: "var(--surface2)", flexShrink: 0 }} />
                  )}
                  <div style={{ overflow: "hidden", minWidth: 0 }}>
                    <div style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                    {r.channel && <div style={{ fontSize: 12, color: "var(--muted2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.channel}</div>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lecteur "rendu seul" (juillet 2026, demande explicite) ────────────────
// "afficher que le rendu ... masquer les portions que je t'ai indiquées" —
// après l'échec du proxy (ci-dessus), rendu obtenu soit via l'automatisation
// masquée (bouton AUTO), soit collé à la main (lien direct .mp4/.mp3 du CDN
// RaveDJ, récupéré via les outils développeur du navigateur une fois le
// rendu terminé). `url`/`onUrlChange` contrôlés par le parent : permet au
// bouton AUTO de remplir ce lecteur automatiquement une fois le job terminé.
function RaveRenderPlayer({ url, onUrlChange, waiting, waitingLabel, elapsed, percent }) {
  const [pending, setPending] = useState("");

  // Vide le champ après chargement (audit juillet 2026, cosmétique) : le
  // lien collé restait affiché indéfiniment dans le champ après un clic sur
  // "CHARGER", laissant croire qu'il n'avait pas été pris en compte alors
  // que la vidéo se chargeait bien juste en dessous.
  const handleLoad = () => {
    const trimmed = pending.trim();
    if (!trimmed) return;
    onUrlChange(trimmed);
    setPending("");
  };

  return (
    <div style={{
      border: "1px solid rgba(0,234,255,0.35)", borderRadius: 12, overflow: "hidden",
      background: "#000", display: "flex", flexDirection: "column", height: "100%",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 10px", background: "var(--surface2)", borderBottom: "1px solid rgba(0,234,255,0.25)",
      }}>
        <span style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, fontSize: 14, letterSpacing: 1, color: "#00eaff" }}>
          🎬 DJMUP PLAYER
        </span>
      </div>
      <div style={{ padding: "8px 10px", display: "flex", gap: 8, background: "#0a0a0a" }}>
        <input
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLoad()}
          placeholder="Colle ici le lien direct .mp4/.mp3 du rendu RaveDJ..."
          style={{
            flex: 1, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 6,
            color: "var(--text)", fontSize: 13, padding: "7px 9px", minWidth: 0,
          }}
        />
        <button onClick={handleLoad} style={{
          padding: "7px 16px", borderRadius: 6, background: "rgba(0,234,255,0.15)",
          border: "1px solid rgba(0,234,255,0.4)", color: "#00eaff", fontSize: 13, fontWeight: 800, cursor: "pointer",
          whiteSpace: "nowrap",
        }}>▶ CHARGER</button>
      </div>
      {url ? (
        <video key={url} src={mediaSrc(url)} controls autoPlay style={{ width: "100%", flex: 1, minHeight: 0, display: "block", background: "#000" }} />
      ) : waiting ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20 }}>
          <div style={{
            fontFamily: "Orbitron,sans-serif", fontSize: 26, fontWeight: 900, color: "#00eaff",
            textShadow: "0 0 12px rgba(0,234,255,0.5)", letterSpacing: 1,
          }}>
            {elapsed}
          </div>
          {/* Pourcentage RÉEL uniquement (jamais inventé) — n'apparaît que si
              RaveDJ affiche lui-même un "NN%" quelque part sur sa page pendant
              la génération ; sinon on s'en tient au chronomètre ci-dessus. */}
          {typeof percent === "number" && (
            <div style={{ width: "80%", maxWidth: 220 }}>
              <div style={{ height: 6, borderRadius: 3, background: "rgba(0,234,255,0.15)", overflow: "hidden" }}>
                <div style={{
                  width: `${percent}%`, height: "100%", background: "#00eaff",
                  transition: "width 0.4s ease", boxShadow: "0 0 8px rgba(0,234,255,0.6)",
                }} />
              </div>
              <div style={{ textAlign: "center", fontSize: 13, color: "#00eaff", marginTop: 4, fontWeight: 700 }}>
                {percent}%
              </div>
            </div>
          )}
          <div style={{ fontSize: 13, color: "var(--muted2)", textAlign: "center", maxWidth: 320 }}>
            {waitingLabel || "Génération en cours sur RaveDJ..."}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "var(--muted2)", textAlign: "center", padding: 20 }}>
          Pas de rendu chargé — lance "🤖 AUTO" ci-dessus, ou colle le lien direct du fichier généré.
        </div>
      )}
    </div>
  );
}

export default function Ext({ trackA = null, trackB = null, presetPair = null }) {
  // Overrides locaux des Decks (recherche/lien collé directement dans cette
  // page) — prennent le pas sur trackA/trackB (venant de MashupStudio) tant
  // qu'ils existent. Remontés ici (plutôt que locaux à DeckSourceCard) pour
  // que le bouton AUTO sache quels morceaux utiliser.
  const [overrideA, setOverrideA] = useState(null);
  const [overrideB, setOverrideB] = useState(null);
  const effectiveA = overrideA || trackA;
  const effectiveB = overrideB || trackB;

  // ── Pioche aléatoire (base de données) — copiée de Mashup Wheel (juillet
  // 2026, demande explicite : "copier la pioche aléatoire présente dans
  // Machwheel dans la page DJMUP") ────────────────────────────────────────
  // Même backend que la roue ③ de Mashup Wheel (GET /api/mashup-wheel/
  // random-match/:videoId, cf. routes/mashupWheel.js — bibliothèque locale
  // uniquement, aucun appel réseau externe, réponse quasi instantanée) :
  // tire au hasard un morceau compatible avec le Deck A affiché ici, et le
  // charge directement en Deck B (pas besoin de naviguer vers Mashup Wheel
  // puis de "renvoyer" la paire — on est déjà sur la page cible).
  const [randomStatus, setRandomStatus] = useState("idle"); // idle | spinning | done | error
  const [randomItem, setRandomItem] = useState(null);
  const [randomError, setRandomError] = useState(null);
  // Garde anti-race (audit juillet 2026, même pattern que MashupWheel.jsx) :
  // incrémenté à chaque changement de Deck A — permet à drawRandomMatch de
  // détecter qu'un résultat qu'il vient de recevoir est en fait obsolète
  // (Deck A a changé PENDANT que le fetch était en vol) et de l'ignorer
  // plutôt que d'afficher/charger en Deck B un candidat calculé pour
  // l'ancien morceau.
  const randomGenRef = useRef(0);

  // Un nouveau Deck A rend la pioche précédente obsolète (compatibilité
  // calculée pour l'ANCIEN morceau) — repart à zéro plutôt que de laisser
  // un résultat périmé affiché.
  useEffect(() => {
    randomGenRef.current++;
    setRandomStatus("idle"); setRandomItem(null); setRandomError(null);
  }, [effectiveA?.id]);

  const drawRandomMatch = async () => {
    if (!effectiveA?.id) return;
    const gen = randomGenRef.current;
    setRandomStatus("spinning"); setRandomError(null);
    try {
      const res = await fetch(`${API}/api/mashup-wheel/random-match/${effectiveA.id}`);
      const data = await res.json();
      if (gen !== randomGenRef.current) return; // Deck A changé entretemps — résultat obsolète, ignoré
      if (!res.ok) throw new Error(data.error || "Tirage impossible");
      setRandomItem(data.item);
      setRandomStatus("done");
      setOverrideB({ id: data.item.videoId, title: data.item.title, channel: data.item.channel || "" });
    } catch (e) {
      if (gen !== randomGenRef.current) return;
      setRandomError(e.message);
      setRandomStatus("error");
    }
  };

  // Mêmes seuils de couleur que Mixer.jsx/MashupWheel.jsx pour la même métrique.
  const scoreColor = (score) => (score >= 70 ? "var(--green)" : score >= 40 ? "#ffaa00" : "#ff8080");

  const [renderUrl, setRenderUrl] = useState("");

  // ── Job d'automatisation masquée (Puppeteer côté backend) ──────────────
  const [autoJobId, setAutoJobId] = useState(null);
  const [autoStatus, setAutoStatus] = useState(null); // {status, step, label, error, mediaUrl}
  const pollRef = useRef(null);

  // ── Décompte pendant l'attente (demande explicite) ──────────────────────
  // La génération côté RaveDJ (étape la plus longue, jusqu'à 15 min) ne donne
  // aucune indication de progression réelle (pas de %, RaveDJ ne l'expose
  // pas) — plutôt qu'un faux décompte vers une durée devinée (mensonger si
  // faux), un chronomètre qui compte le temps écoulé depuis le lancement :
  // au moins l'utilisateur voit que ça avance, sans promesse non tenable.
  const [elapsedSec, setElapsedSec] = useState(0);
  const elapsedRef = useRef(null);
  useEffect(() => {
    if (!autoJobId) {
      clearInterval(elapsedRef.current);
      return;
    }
    setElapsedSec(0);
    elapsedRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(elapsedRef.current);
  }, [autoJobId]);
  const formatElapsed = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  useEffect(() => {
    if (!autoJobId) return;
    const poll = async () => {
      try {
        const res = await fetch(`${API}/api/ravedj-auto/${autoJobId}/status`);
        const data = await res.json();
        // Vérification res.ok ajoutée (audit juillet 2026) : sans ça, un 404
        // "Job introuvable" (même cause que le bug déjà rencontré côté
        // Mashup Wheel — job en mémoire perdu après un redémarrage backend)
        // était traité comme un statut normal : ni "done" ni "error", le
        // polling continuait indéfiniment sans jamais rien afficher.
        if (!res.ok) {
          setAutoStatus({ status: "error", error: data.error || `Erreur serveur (${res.status})` });
          clearInterval(pollRef.current);
          setAutoJobId(null);
          return;
        }
        setAutoStatus(data);
        if (data.status === "done") {
          if (data.mediaUrl) setRenderUrl(data.mediaUrl);
          clearInterval(pollRef.current);
          setAutoJobId(null);
        } else if (data.status === "error") {
          clearInterval(pollRef.current);
          setAutoJobId(null);
        }
      } catch {
        // Erreur réseau ponctuelle pendant le polling — retentera au prochain
        // intervalle, pas la peine d'interrompre le job pour ça.
      }
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoJobId]);

  // Prend a/b en paramètres explicites (plutôt que de relire effectiveA/B)
  // pour pouvoir être appelée juste après setOverrideA/B (cf. useEffect
  // presetPair ci-dessous) sans dépendre du re-render React — même principe
  // que playNodeAt/startAnalyzeFor ailleurs dans l'app (closure obsolète
  // sinon, l'état ne serait pas encore à jour au moment de l'appel).
  const startAutoFor = async (a, b) => {
    if (!a?.id || !b?.id) return;
    setAutoStatus({ status: "running", step: 0, label: "Démarrage..." });
    try {
      const res = await fetch(`${API}/api/ravedj-auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urlA: youtubeUrl(a.id), urlB: youtubeUrl(b.id) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAutoStatus({ status: "error", error: data.error || "Échec du démarrage" });
        return;
      }
      setAutoJobId(data.jobId);
    } catch (e) {
      setAutoStatus({ status: "error", error: `Backend injoignable : ${e.message}` });
    }
  };
  const startAuto = () => startAutoFor(effectiveA, effectiveB);

  // ── Pioche envoyée depuis Mashup Wheel (roue ③ "pioche aléatoire — base de
  // données", juillet 2026, demande explicite : "générer un mashup dans
  // DJMUP") — pré-remplit les 2 Decks de cette page ET lance directement
  // l'automatisation RaveDJ si demandé (autoStart), sans étape intermédiaire.
  // presetPair est un NOUVEL objet à chaque envoi (cf. App.jsx::sendToExt),
  // donc cet effet se redéclenche à chaque clic même avec la même paire.
  useEffect(() => {
    if (!presetPair?.trackA || !presetPair?.trackB) return;
    setOverrideA(presetPair.trackA);
    setOverrideB(presetPair.trackB);
    if (presetPair.autoStart) startAutoFor(presetPair.trackA, presetPair.trackB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetPair]);

  const autoRunning = autoStatus?.status === "running";
  const canAuto = !!(effectiveA?.id && effectiveB?.id) && !autoRunning;

  // Cette page empile pas mal de contenu vertical (sources Decks, lecteur de
  // rendu, iframe RaveDJ pleine hauteur) — plus que ce que ".app" (overflow
  // hidden partout ailleurs dans l'appli, cf. styles.css, pages pensées pour
  // tenir dans un seul écran) peut afficher sans scroll. Plutôt que de
  // toucher à la règle globale ".app" (risque de régression sur les autres
  // pages), on autorise le scroll vertical UNIQUEMENT ici, en override local.
  return (
    <div className="app" style={{ overflowY: "auto" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "28px 16px", width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{
            fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 28,
            letterSpacing: 3, color: "#ffaa00", textShadow: "0 0 16px rgba(255,170,0,0.5)",
            textTransform: "uppercase",
          }}>
            🧩 DJMUP
          </div>
        </div>

        {/* ── Bloc gauche (Deck A + Deck B + pioche + AUTO) / Player à droite ──
            Retour utilisateur juillet 2026 : la pioche + le bouton AUTO
            doivent être sous les Decks A/B spécifiquement (pas sous toute la
            rangée ni au-dessus) — le lecteur DJMUP reste à droite, étiré sur
            toute la hauteur du bloc gauche (mêmes deux Decks + les 2 cadres
            juste en dessous), comme le Mixer au centre de MashupStudio.jsx. */}
        <div style={{ display: "flex", gap: 14, marginBottom: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* height: 460 (même hauteur que DJMUP PLAYER) + flex column : la
              rangée Deck A/B prend flex:1 (tout l'espace restant une fois
              retirées la pioche et la barre AUTO), donc le bas de la barre
              AUTO s'aligne toujours exactement sur le bas du Player, quelle
              que soit la hauteur réelle des 2 cadres en dessous des Decks
              (retour utilisateur juillet 2026). */}
          <div style={{ flex: "2 1 560px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0, height: 460 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, flex: 1, minHeight: 0 }}>
              <div style={{ height: "100%", overflowY: "auto" }}>
                <DeckSourceCard letter="A" color="#00eaff" studioTrack={trackA} override={overrideA} onOverrideChange={setOverrideA} />
              </div>
              <div style={{ height: "100%", overflowY: "auto" }}>
                <DeckSourceCard letter="B" color="#cc00ff" studioTrack={trackB} override={overrideB} onOverrideChange={setOverrideB} />
              </div>
            </div>

            {/* ── Pioche aléatoire (base de données) — copiée de Mashup Wheel ──
                Tire un morceau compatible avec le Deck A ci-dessus et le
                charge directement en Deck B. */}
            <div style={{
              display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", flexShrink: 0,
              background: "var(--surface2)", border: "1px solid rgba(255,170,0,0.35)", borderRadius: 8, padding: "10px 12px",
            }}>
              {!effectiveA?.id ? (
                <div style={{ color: "var(--muted2)", fontSize: 13 }}>
                  Charge un morceau sur Deck A pour activer la pioche aléatoire (base de données).
                </div>
              ) : (
                <>
                  <button
                    onClick={drawRandomMatch}
                    disabled={randomStatus === "spinning"}
                    style={{
                      padding: "9px 16px", borderRadius: 6,
                      background: "rgba(255,170,0,0.12)", border: "1px solid rgba(255,170,0,0.45)",
                      color: "#ffaa00", fontSize: 13, fontWeight: 800, cursor: randomStatus === "spinning" ? "default" : "pointer",
                      whiteSpace: "nowrap", letterSpacing: 0.3,
                    }}
                  >{randomStatus === "spinning" ? "🎰 Tirage…" : randomItem ? "🎲 Repiocher (Deck B)" : "🎲 Piocher un morceau compatible (Deck B)"}</button>

                  {randomStatus === "error" && (
                    <div style={{ color: "#ff8080", fontSize: 12.5, flex: "1 1 220px" }}>⚠ {randomError}</div>
                  )}

                  {randomStatus === "done" && randomItem && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 260px", minWidth: 220 }}>
                      <img src={randomItem.thumbnail} alt="" style={{ width: 56, height: 42, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={randomItem.title}>
                          {randomItem.title}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                          {randomItem.channel ? `${randomItem.channel} · ` : ""}
                          <span style={{ color: scoreColor(randomItem.score), fontWeight: 700 }}>{randomItem.score}/100</span>
                          {" · "}{randomItem.bpm} BPM · {randomItem.camelot || "?"}
                          <span style={{ marginLeft: 6, color: "var(--cyan)" }}>· chargé en Deck B ↓</span>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── Bouton AUTO (navigateur masqué) ── */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flexShrink: 0,
              background: "var(--surface2)", border: "1px solid rgba(0,234,255,0.3)", borderRadius: 8, padding: "8px 10px",
            }}>
              <button onClick={startAuto} disabled={!canAuto} style={{
                padding: "9px 18px", borderRadius: 6,
                background: canAuto ? "rgba(0,234,255,0.15)" : "var(--surface)",
                border: `1px solid ${canAuto ? "rgba(0,234,255,0.5)" : "var(--border)"}`,
                color: canAuto ? "#00eaff" : "var(--muted2)",
                fontSize: 14, fontWeight: 800, cursor: canAuto ? "pointer" : "not-allowed", whiteSpace: "nowrap",
              }}>
                {autoRunning ? "⏳ EN COURS..." : "🤖 AUTO"}
              </button>
              <div style={{ fontSize: 13, color: autoStatus?.status === "error" ? "#ff6666" : "var(--muted2)", flex: 1, minWidth: 200 }}>
                {!effectiveA?.id || !effectiveB?.id
                  ? "Charge un morceau sur Deck A et Deck B ci-dessus pour activer l'automatisation."
                  : autoStatus?.status === "error"
                    ? `Échec : ${autoStatus.error}`
                    : autoStatus?.label || "Colle A puis B dans RaveDJ et valide, sans qu'aucune fenêtre ne s'affiche."}
              </div>
              {autoRunning && (
                <div style={{
                  fontFamily: "Orbitron,sans-serif", fontSize: 14, fontWeight: 800, color: "#00eaff",
                  whiteSpace: "nowrap", padding: "4px 10px", background: "rgba(0,234,255,0.1)", borderRadius: 6,
                }}>
                  ⏱ {formatElapsed(elapsedSec)}
                </div>
              )}
            </div>
          </div>

          {/* ── Rendu RaveDJ — colonne de droite, hauteur fixe 460px comme
              précédemment (retour utilisateur juillet 2026 : ne plus
              l'étirer sur toute la hauteur du bloc gauche, qui est devenu
              bien plus haut depuis l'ajout de la pioche + AUTO en dessous
              des Decks). */}
          <div style={{ flex: "1 1 320px", minWidth: 280, height: 460 }}>
            <RaveRenderPlayer
              url={renderUrl}
              onUrlChange={setRenderUrl}
              waiting={autoRunning}
              waitingLabel={autoStatus?.label}
              elapsed={formatElapsed(elapsedSec)}
              percent={typeof autoStatus?.percent === "number" ? autoStatus.percent : null}
            />
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
