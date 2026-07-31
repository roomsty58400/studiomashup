import React, { useState, useRef, useEffect } from "react";
import Deck from "../components/Deck.jsx";
import Footer from "../components/Footer.jsx";
import AlbumArt from "../components/AlbumArt.jsx";

const API = "http://localhost:3001";

// Mêmes seuils de couleur que le score de compatibilité du Mixer (Mixer.jsx)
// — cohérence visuelle entre les 2 pages pour la même métrique.
const scoreColor = (score) => (score >= 70 ? "var(--green)" : score >= 40 ? "#ffaa00" : "#ff8080");

const STEP_LABELS = {
  pool: "Analyse de la bibliothèque locale…",
  discover: "Recherche de nouveaux morceaux compatibles sur YouTube…",
  analyze: "Analyse des candidats découverts…",
  "existing-mashups": "Recherche de mashups déjà existants sur YouTube…",
};

// Candidats "origin: existing_mashup" : trouvés via un mashup/mix RÉEL déjà
// publié sur YouTube (pas une simple estimation BPM/clé) — mis en avant avec
// une couleur dédiée, distincte du dégradé rouge/orange/vert habituel.
const PROVEN_COLOR = "#ffd23f";

export default function MashupWheel({ onSendToStudio, onSendToExt }) {
  // Vidéo choisie dans le Deck (recherche/upload) et résultat de son analyse
  // complète (BPM/clé/structure) — 2 callbacks distincts du Deck, cf. Deck.jsx.
  const [loadedVideo, setLoadedVideo] = useState(null);
  const [analyzedTrack, setAnalyzedTrack] = useState(null);

  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [step, setStep] = useState(null);
  const [discoverProgress, setDiscoverProgress] = useState(null); // { done, total }
  const [items, setItems] = useState([]);
  const [sourceTrack, setSourceTrack] = useState(null);
  const [error, setError] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);

  // ── Roue ③ : pioche aléatoire dans la base de données (juillet 2026,
  // demande explicite : "une seconde roue qui va chercher aléatoirement
  // selon la base de données un clip chanson qui va pouvoir se marier avec
  // le clip du deck A et générer un mashup dans DJMUP") — indépendante de la
  // roue ① ci-dessus (pas besoin d'avoir lancé une recherche), juste besoin
  // que le Deck A soit analysé. Un seul candidat tiré au hasard à la fois
  // (esprit "roue de la fortune"), pas un classement.
  const [randomStatus, setRandomStatus] = useState("idle"); // idle | spinning | done | error
  const [randomItem, setRandomItem] = useState(null);
  const [randomError, setRandomError] = useState(null);

  const pollingRef = useRef(false);
  // Évite de relancer une recherche de correspondances pour le même morceau
  // à chaque re-render (l'effet ci-dessous se déclenche à chaque changement
  // de référence d'analyzedTrack, y compris quand Deck le repasse identique).
  const startedForRef = useRef(null);
  // ── Compteur de génération (même correctif que DjAssistModal.jsx, juillet
  // 2026) ──────────────────────────────────────────────────────────────────
  // Bug réel trouvé lors de la revérification demandée : si l'utilisateur
  // change de morceau dans le Deck PENDANT qu'une recherche est encore en
  // cours (le job précédent tourne toujours côté serveur), l'ancienne boucle
  // de polling (tick() via setTimeout) n'était JAMAIS arrêtée — seul un
  // booléen partagé (pollingRef) empêchait de LANCER un 2e polling en
  // parallèle, mais ne coupait pas celui déjà en vol. Les 2 boucles pouvaient
  // alors écrire dans le même state (step/items/status) en concurrence : un
  // résultat périmé du morceau précédent pouvait écraser l'affichage du
  // nouveau, ou bloquer la roue sur une étape qui ne progresse plus.
  // generationRef incrémenté à chaque startWheel() ; chaque continuation
  // (tick, fetch résolu) vérifie qu'elle appartient toujours à la génération
  // courante avant d'appliquer le moindre setState — la boucle abandonnée
  // continue de tourner "dans le vide" jusqu'à sa fin naturelle mais n'a plus
  // aucun effet visible.
  const generationRef = useRef(0);

  const resetWheel = () => {
    setStatus("idle"); setStep(null); setDiscoverProgress(null);
    setItems([]); setSourceTrack(null); setError(null); setSelectedItem(null);
    resetRandomWheel();
  };

  // Roue ③ (pioche aléatoire) — remise à zéro séparée, réutilisée aussi bien
  // par resetWheel (nouveau morceau chargé) que par le bouton "🎲 Repiocher".
  const resetRandomWheel = () => {
    setRandomStatus("idle"); setRandomItem(null); setRandomError(null);
  };

  const handleLoaded = (data) => {
    setLoadedVideo(data);
    setAnalyzedTrack(null);
    startedForRef.current = null;
    generationRef.current++; // abandonne un éventuel polling en cours pour l'ancien morceau
    resetWheel();
  };

  const handleAnalyzed = (track) => {
    setAnalyzedTrack(track);
    if (!track) {
      startedForRef.current = null;
      generationRef.current++;
      resetWheel();
    }
  };

  // Tire un candidat au hasard dans la bibliothèque locale (backend :
  // GET /api/mashup-wheel/random-match/:videoId, cf. routes/mashupWheel.js —
  // synchrone, aucun appel réseau externe, pas de job/polling nécessaire).
  const drawRandomMatch = async () => {
    if (!analyzedTrack?.bpm) return;
    // Garde anti-race (audit juillet 2026) : ce fetch n'est pas annulable, et
    // sans cette vérification, un changement de Deck A PENDANT que la
    // requête est en vol (peu probable vu que l'endpoint est local/quasi
    // instantané, mais possible) pouvait laisser sa réponse tardive écraser
    // l'état avec un résultat qui correspond en réalité à l'ANCIEN morceau,
    // affiché à tort comme valide pour le nouveau. Même generationRef que le
    // reste de la roue (incrémenté à chaque nouveau morceau chargé/analysé).
    const gen = generationRef.current;
    setRandomStatus("spinning"); setRandomError(null);
    try {
      const res = await fetch(`${API}/api/mashup-wheel/random-match/${analyzedTrack.id}`);
      const data = await res.json();
      if (gen !== generationRef.current) return; // morceau changé entretemps — résultat obsolète, ignoré
      if (!res.ok) throw new Error(data.error || "Tirage impossible");
      setRandomItem(data.item);
      setRandomStatus("done");
    } catch (e) {
      if (gen !== generationRef.current) return;
      setRandomError(e.message);
      setRandomStatus("error");
    }
  };

  // Envoie [Deck A, candidat tiré] vers DJMUP (page EXT.) et lance
  // directement l'automatisation RaveDJ (autoStart) — "générer un mashup
  // dans DJMUP" en un seul clic, sans étape intermédiaire.
  const handleGenerateInDjmup = () => {
    if (!onSendToExt || !loadedVideo || !randomItem) return;
    onSendToExt({
      trackA: { id: loadedVideo.id, title: loadedVideo.title, channel: loadedVideo.channel },
      trackB: { id: randomItem.videoId, title: randomItem.title, channel: randomItem.channel || "" },
      autoStart: true,
    });
  };

  const pollJob = (id, gen) => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const tick = async () => {
      if (gen !== generationRef.current) { pollingRef.current = false; return; }
      try {
        const res = await fetch(`${API}/api/mashup-wheel/${id}/status`);
        const data = await res.json();
        if (gen !== generationRef.current) { pollingRef.current = false; return; }
        if (!res.ok) { setStatus("error"); setError(data.error || "Job introuvable"); pollingRef.current = false; return; }
        setStep(data.step || null);
        if (data.discoverTotal != null) setDiscoverProgress({ done: data.discoverDone || 0, total: data.discoverTotal });
        if (data.status === "done") {
          setStatus("done"); setItems(data.items || []); setSourceTrack(data.sourceTrack || null);
          pollingRef.current = false;
        } else if (data.status === "error") {
          setStatus("error"); setError(data.message || "Erreur inconnue"); pollingRef.current = false;
        } else {
          setTimeout(tick, 1500);
        }
      } catch (e) {
        if (gen !== generationRef.current) { pollingRef.current = false; return; }
        setStatus("error"); setError(e.message); pollingRef.current = false;
      }
    };
    tick();
  };

  const startWheel = async (track) => {
    const gen = ++generationRef.current;
    resetWheel();
    setStatus("running"); setStep("pool");
    try {
      const res = await fetch(`${API}/api/mashup-wheel/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: track.id, title: track.title, channel: loadedVideo?.channel || "" }),
      });
      const data = await res.json();
      if (gen !== generationRef.current) return; // un morceau plus récent a déjà pris le relais
      if (!res.ok) throw new Error(data.error || "Échec du lancement");
      pollingRef.current = false;
      pollJob(data.jobId, gen);
    } catch (e) {
      if (gen !== generationRef.current) return;
      setStatus("error"); setError(e.message);
    }
  };

  // Lancée automatiquement dès que le Deck a fini d'analyser le morceau —
  // aucun clic supplémentaire, même esprit que l'auto-analyse du Deck lui-même.
  useEffect(() => {
    if (!analyzedTrack?.bpm || analyzedTrack.id === startedForRef.current) return;
    startedForRef.current = analyzedTrack.id;
    startWheel(analyzedTrack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzedTrack]);

  const handleSendToStudio = (item) => {
    if (!onSendToStudio || !loadedVideo) return;
    onSendToStudio({
      trackA: { id: loadedVideo.id, title: loadedVideo.title, channel: loadedVideo.channel, thumb: loadedVideo.thumb },
      trackB: { id: item.videoId, title: item.title, channel: item.channel || "", thumb: item.thumbnail },
    });
  };

  // ── Disposition circulaire ──
  // Angle égal entre chaque candidat, en partant du haut (−90°) dans le sens
  // horaire. Les résultats arrivent déjà triés par score décroissant côté
  // serveur : le meilleur match se retrouve donc naturellement en haut de la
  // roue, puis on tourne en s'éloignant en compatibilité décroissante.
  // Rayon agrandi (190→230) suite au relèvement du plafond de propositions
  // côté serveur (MAX_RESULTS 12→24, cf. routes/mashupWheel.js) — sinon les
  // vignettes se seraient chevauchées avec deux fois plus de candidats sur
  // le même cercle.
  const CENTER = 260;
  const RADIUS = 230;
  const positioned = items.map((item, i) => {
    const angle = (-90 + (items.length ? (360 / items.length) * i : 0)) * (Math.PI / 180);
    return { ...item, x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle) };
  });
  // Vignettes légèrement plus petites quand la roue est chargée (>16
  // candidats) — même logique de prévention de chevauchement.
  const crowded = items.length > 16;

  return (
    <div className="app" style={{ paddingBottom: 0 }}>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", padding: "20px 24px 8px" }}>
        {/* Largeur élargie 380→460px (retour utilisateur juillet 2026) : à
            380px, la rangée des 3 boutons Lyrics/Prompt Suno/Shazam
            (.deck-footer, flex:1 chacun + ellipsis) n'avait pas assez de
            place et "✦ PROMPT SUNO" se retrouvait tronqué. */}
        <div style={{ flex: "0 0 460px", minWidth: 400 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>① Choisis un morceau de départ</div>
          {/* Upload local masqué ici : la roue a besoin d'un videoId YouTube
              (recherche de candidats + analyse allégée côté backend) — un
              fichier uploadé n'a pas d'équivalent et ne déclencherait de toute
              façon jamais l'analyse automatique (cf. Deck.jsx, handleFileChange
              n'appelle pas startAnalyzeFor). */}
          {/* side="wheel-A" (pas "A") : depuis que les pages restent montées en
              permanence (App.jsx, cf. commentaire sur le maintien d'état entre
              vues), ce Deck coexiste dans le DOM avec le Deck A du Studio —
              "side" pilote l'id du conteneur YouTube (iframeContainerId =
              yt-player-${side} dans Deck.jsx) : garder "A" créerait un id HTML
              dupliqué (yt-player-A x2) et casserait l'un des 2 lecteurs
              YouTube (le second new YT.Player() ciblant cet id récupérerait
              le mauvais conteneur). label="A" conserve l'affichage identique
              (lettre + couleur cyan) sans toucher à l'identifiant interne. */}
          <Deck side="wheel-A" label="A" colorKey="cyan" onLoaded={handleLoaded} onAnalyzed={handleAnalyzed} hideUpload />
        </div>

        <div style={{ flex: "1 1 520px", minWidth: 480 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>② Roue des correspondances (mix / mashup)</div>

          {!loadedVideo && (
            <div className="clip-frame-placeholder" style={{ minHeight: 460, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>
              Choisis un morceau dans le Deck à gauche (recherche YouTube ou upload) pour faire tourner la roue.
            </div>
          )}

          {loadedVideo && status === "running" && (
            <div style={{ minHeight: 460, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 800, letterSpacing: 1, color: "var(--cyan)", textAlign: "center" }}>
                ⏳ {STEP_LABELS[step] || "Recherche en cours…"}
                {step === "analyze" && discoverProgress ? ` (${discoverProgress.done}/${discoverProgress.total})` : ""}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted2)", textAlign: "center", maxWidth: 360 }}>
                Ça peut prendre une minute ou deux si de nouveaux morceaux doivent être téléchargés et analysés pour la 1ère fois.
              </div>
            </div>
          )}

          {loadedVideo && status === "error" && (
            <div style={{ minHeight: 460, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center", padding: 24 }}>
              <div style={{ color: "#ff8080", fontWeight: 700 }}>⚠ {error}</div>
              {analyzedTrack && (
                <button className="ghost-btn" onClick={() => startWheel(analyzedTrack)}>↺ Réessayer</button>
              )}
            </div>
          )}

          {loadedVideo && status === "done" && items.length === 0 && (
            <div style={{ minHeight: 460, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--muted2)", padding: 24 }}>
              Aucune correspondance trouvée pour l'instant — la bibliothèque est encore petite et la recherche YouTube n'a rien donné de compatible. Analyse d'autres morceaux dans MacheUp pour enrichir la roue au fil du temps.
            </div>
          )}

          {loadedVideo && status === "done" && items.length > 0 && (
            // overflowX: "auto" (audit juillet 2026) : la roue elle-même fait
            // CENTER*2 = 520px de large en dur (coordonnées SVG absolues, pas
            // convertibles en % sans réécrire toute la disposition circulaire).
            // Sous ~560px de large, plutôt que de rogner la roue ou casser la
            // mise en page de la page entière, ce conteneur devient
            // scrollable horizontalement — la roue reste utilisable, juste
            // décalable au doigt/à la molette au lieu d'être entièrement visible d'un coup.
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center", maxWidth: "100%", overflowX: "auto", paddingBottom: 4 }}>
              <div style={{ position: "relative", width: CENTER * 2, height: CENTER * 2, flexShrink: 0 }}>
                <svg width={CENTER * 2} height={CENTER * 2} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  {positioned.map(p => (
                    <line key={p.videoId} x1={CENTER} y1={CENTER} x2={p.x} y2={p.y}
                      stroke={p.origin === "existing_mashup" ? PROVEN_COLOR : scoreColor(p.score)}
                      strokeOpacity={0.3 + (p.score / 100) * 0.4}
                      strokeWidth={selectedItem?.videoId === p.videoId ? 2.5 : 1} />
                  ))}
                </svg>

                {/* Centre : morceau source, choisi dans le Deck */}
                <div title={sourceTrack?.title} style={{
                  position: "absolute", left: CENTER - 46, top: CENTER - 46, width: 92, height: 92, borderRadius: "50%",
                  border: "3px solid var(--cyan)", overflow: "hidden", boxShadow: "0 0 24px rgba(0,234,255,0.45)",
                  zIndex: 2, background: "#000",
                }}>
                  <img src={`https://i.ytimg.com/vi/${sourceTrack?.videoId}/mqdefault.jpg`} alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
                {sourceTrack && (
                  <div style={{ position: "absolute", left: CENTER - 70, top: CENTER + 50, width: 140, textAlign: "center",
                    fontSize: 10, color: "var(--cyan)", fontWeight: 700, zIndex: 2 }}>
                    {sourceTrack.bpm} BPM · {sourceTrack.camelot || "?"}
                  </div>
                )}

                {/* Candidats — taille et couleur du contour proportionnelles au score */}
                {positioned.map(p => {
                  const size = (crowded ? 30 : 38) + (p.score / 100) * (crowded ? 18 : 26);
                  const isSelected = selectedItem?.videoId === p.videoId;
                  const proven = p.origin === "existing_mashup";
                  const ringColor = proven ? PROVEN_COLOR : scoreColor(p.score);
                  return (
                    <div key={p.videoId} onClick={() => setSelectedItem(p)}
                      title={`${p.title} · ${p.score}/100${proven ? " · mashup existant trouvé" : ""}`}
                      style={{
                        position: "absolute", left: p.x - size / 2, top: p.y - size / 2, width: size, height: size,
                        borderRadius: "50%", border: `2.5px solid ${ringColor}`, overflow: "hidden",
                        cursor: "pointer", zIndex: isSelected ? 3 : 1,
                        boxShadow: isSelected ? `0 0 18px ${ringColor}` : proven ? `0 0 10px ${ringColor}` : "none",
                        transform: isSelected ? "scale(1.12)" : "scale(1)", transition: "transform 0.15s ease",
                        background: "#000",
                      }}>
                      {/* Miniature YouTube brute (pas de pochette réelle ici) :
                          la roue peut afficher des dizaines de points en même
                          temps, une recherche de pochette par point dépasserait
                          vite le quota de l'API iTunes pour un gain visuel nul
                          à cette taille. Le vrai artwork n'est chargé que pour
                          la carte de détail ci-dessous, une fois un point choisi. */}
                      <img src={p.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      {proven && (
                        <div style={{ position: "absolute", top: -2, right: -2, fontSize: 12, lineHeight: 1,
                          filter: "drop-shadow(0 0 2px #000)" }}>🔊</div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Détail du candidat sélectionné */}
              <div style={{ flex: "1 1 260px", minWidth: 260, maxWidth: 320 }}>
                {!selectedItem ? (
                  <div style={{ color: "var(--muted2)", fontSize: 13, padding: "20px 10px", textAlign: "center" }}>
                    Clique sur un point de la roue pour voir le détail de compatibilité.
                  </div>
                ) : (
                  <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
                    <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                      <AlbumArt title={selectedItem.title} channel={selectedItem.channel} fallback={selectedItem.thumbnail} alt=""
                        style={{ width: 64, height: 48, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {selectedItem.title}
                        </div>
                        {selectedItem.channel && (
                          <div style={{ fontSize: 11, color: "var(--muted2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {selectedItem.channel}
                          </div>
                        )}
                      </div>
                    </div>

                    {selectedItem.origin === "existing_mashup" && (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 700,
                        color: PROVEN_COLOR, background: "rgba(255,210,63,0.1)", border: `1px solid ${PROVEN_COLOR}55`,
                        borderRadius: 6, padding: "5px 8px", marginBottom: 10,
                      }}>
                        🔊 Mashup existant trouvé — quelqu'un a déjà mixé ces 2 morceaux ensemble.
                        {selectedItem.foundInMashup && (
                          <a href={`https://www.youtube.com/watch?v=${selectedItem.foundInMashup.videoId}`}
                            target="_blank" rel="noreferrer" style={{ color: PROVEN_COLOR, textDecoration: "underline", marginLeft: "auto", flexShrink: 0 }}
                            title={selectedItem.foundInMashup.title}>
                            voir ▸
                          </a>
                        )}
                      </div>
                    )}

                    <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 1, marginBottom: 6, color: scoreColor(selectedItem.score) }}>
                      COMPATIBILITÉ {selectedItem.score}/100
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 8 }}>{selectedItem.mixTypeLabel}</div>

                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted2)", marginBottom: 10 }}>
                      <div style={{ display: "flex", gap: 10 }}>
                        <span title="BPM">⏱ BPM {selectedItem.subscores.bpm}</span>
                        <span title="Clé">🎹 Clé {selectedItem.subscores.key}</span>
                        <span title="Énergie">🔥 Énerg. {selectedItem.subscores.energy}</span>
                      </div>
                      <div style={{ display: "flex", gap: 10 }}>
                        <span title="Structure">📐 Struct. {selectedItem.subscores.structure}</span>
                        <span title="Spectral">🌈 Spectr. {selectedItem.subscores.spectral}</span>
                      </div>
                    </div>

                    <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 10 }}>
                      {selectedItem.bpm} BPM · {selectedItem.camelot || "?"} {selectedItem.keyLabel ? `(${selectedItem.keyLabel})` : ""}
                      {selectedItem.origin === "discovered" && <span style={{ marginLeft: 6, color: "var(--cyan)" }}>· nouveau</span>}
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <a href={`https://www.youtube.com/watch?v=${selectedItem.videoId}`} target="_blank" rel="noreferrer"
                        className="ghost-btn" style={{ flex: 1, textAlign: "center", textDecoration: "none" }}>
                        ▶ YouTube
                      </a>
                      <button className="ghost-btn" style={{ flex: 1, borderColor: "rgba(0,234,255,0.35)", color: "var(--cyan)" }}
                        onClick={() => handleSendToStudio(selectedItem)}>
                        🎚 Envoyer en MacheUp
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Roue ③ : pioche aléatoire (base de données) → DJMUP ────────────
          Indépendante de la roue ① — n'a besoin que du Deck A analysé, pas
          d'avoir lancé de recherche de correspondances au-dessus. */}
      <div style={{ padding: "0 24px 20px" }}>
        <div className="section-label" style={{ marginBottom: 8 }}>③ Pioche aléatoire (base de données) → DJMUP</div>
        <div style={{
          background: "var(--surface2)", border: "1px solid rgba(255,170,0,0.35)", borderRadius: 10,
          padding: "14px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
        }}>
          {!loadedVideo || !analyzedTrack?.bpm ? (
            <div style={{ color: "var(--muted2)", fontSize: 13 }}>
              Choisis et laisse analyser un morceau dans le Deck ① pour activer la pioche.
            </div>
          ) : (
            <>
              <button
                onClick={drawRandomMatch}
                disabled={randomStatus === "spinning"}
                style={{
                  padding: "10px 18px", borderRadius: 7,
                  background: "rgba(255,170,0,0.12)", border: "1px solid rgba(255,170,0,0.45)",
                  color: "#ffaa00", fontSize: 13, fontWeight: 800, cursor: randomStatus === "spinning" ? "default" : "pointer",
                  whiteSpace: "nowrap", letterSpacing: 0.3,
                }}
              >{randomStatus === "spinning" ? "🎰 Tirage…" : randomItem ? "🎲 Repiocher" : "🎲 Piocher un morceau compatible"}</button>

              {randomStatus === "error" && (
                <div style={{ color: "#ff8080", fontSize: 12.5, flex: "1 1 220px" }}>⚠ {randomError}</div>
              )}

              {randomStatus === "done" && randomItem && (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 260px", minWidth: 220 }}>
                    <AlbumArt title={randomItem.title} channel={randomItem.channel} fallback={randomItem.thumbnail} alt=""
                      style={{ width: 64, height: 48, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={randomItem.title}>
                        {randomItem.title}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                        {randomItem.channel ? `${randomItem.channel} · ` : ""}
                        <span style={{ color: scoreColor(randomItem.score), fontWeight: 700 }}>{randomItem.score}/100</span>
                        {" · "}{randomItem.bpm} BPM · {randomItem.camelot || "?"}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={handleGenerateInDjmup}
                    style={{
                      padding: "10px 18px", borderRadius: 7,
                      background: "rgba(0,234,255,0.12)", border: "1px solid rgba(0,234,255,0.45)",
                      color: "var(--cyan)", fontSize: 13, fontWeight: 800, cursor: "pointer",
                      whiteSpace: "nowrap", letterSpacing: 0.3,
                    }}
                  >🎚 Générer un mashup dans DJMUP</button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <Footer />
    </div>
  );
}
