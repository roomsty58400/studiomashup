import React, { useState, useRef, useEffect } from "react";

// ── DJ Assist ──────────────────────────────────────────────────────────
// Réutilise TEL QUEL le moteur de la roue de suggestions de Mashup Wheel
// (POST /api/mashup-wheel/start + polling du statut, cf. pages/MashupWheel.jsx)
// mais dans une fenêtre modale par-dessus le Mixer plutôt qu'une page dédiée :
// le morceau source est celui déjà chargé/analysé dans le Deck A (pas de
// recherche à refaire ici), et choisir un candidat l'envoie directement dans
// le Deck B (onPick) au lieu de "envoyer vers le studio" (on y est déjà).
const API = "http://localhost:3001";

// Mêmes seuils de couleur que Mixer.jsx / MashupWheel.jsx — cohérence visuelle
// pour la même métrique de compatibilité partout sur le site.
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

const CENTER = 170;
const RADIUS = 138;

export default function DjAssistModal({ sourceTrack, onPick, onClose }) {
  const [status, setStatus] = useState("running"); // running | done | error
  const [step, setStep] = useState("pool");
  const [discoverProgress, setDiscoverProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [resolvedSource, setResolvedSource] = useState(null);
  const [error, setError] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const pollingRef = useRef(false);

  // Bug corrigé (juillet 2026) : en dev, React.StrictMode (cf. main.jsx)
  // monte CHAQUE composant deux fois de suite (monte → démonte → remonte) pour
  // détecter les effets impurs. Le useEffect ci-dessous n'ayant PAS de
  // fonction de nettoyage à l'origine, startWheel() était appelé 2 FOIS à
  // chaque ouverture — 2 vrais jobs créés côté serveur (2 x téléchargement/
  // analyse réels, gaspillage), et surtout 2 boucles de polling écrivant dans
  // le MÊME state en parallèle : le step affiché "flashait" entre les 2 jobs
  // à chaque tick (1.5s), et pouvait rester bloqué indéfiniment sur une étape
  // dépassée si le job le plus lent des deux continuait à écraser l'état du
  // job déjà terminé. Symptôme observé : la fenêtre restait figée sur
  // "Recherche de mashups déjà existants…" sans jamais afficher de résultat.
  //
  // 1er correctif tenté (cancelledRef booléen, remis à false par CHAQUE
  // invocation de l'effet) insuffisant : StrictMode exécute monte→nettoie→
  // remonte de façon SYNCHRONE, donc au moment où le fetch() de la 1ère
  // invocation se résout enfin, le nettoyage ET la 2e invocation ont déjà
  // tourné entre-temps et remis cancelledRef à false — la 1ère invocation ne
  // voyait donc jamais qu'elle avait été annulée. Un simple booléen partagé
  // ne suffit pas à distinguer "ancienne" vs "nouvelle" invocation.
  //
  // Fix définitif : compteur de génération. Chaque appel à startWheel()
  // incrémente generationRef et capture SA PROPRE valeur (gen) dans sa
  // fermeture — contrairement à cancelledRef, cette valeur capturée
  // n'est jamais réécrite par une invocation ultérieure. Toute continuation
  // asynchrone (après fetch, dans tick()) vérifie qu'elle correspond TOUJOURS
  // à la génération courante avant d'écrire dans le state ; sinon elle
  // s'arrête. Le nettoyage de l'effet incrémente aussi generationRef, ce qui
  // invalide proprement la boucle de polling en cas de VRAI démontage (fermeture
  // de la fenêtre), pas seulement le double-montage StrictMode.
  const generationRef = useRef(0);

  const pollJob = (id, gen) => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const tick = async () => {
      if (gen !== generationRef.current) { pollingRef.current = false; return; }
      try {
        const res = await fetch(`${API}/api/mashup-wheel/${id}/status`);
        const data = await res.json();
        if (gen !== generationRef.current) { pollingRef.current = false; return; } // invocation périmée (StrictMode ou fermeture)
        if (!res.ok) { setStatus("error"); setError(data.error || "Job introuvable"); pollingRef.current = false; return; }
        setStep(data.step || null);
        if (data.discoverTotal != null) setDiscoverProgress({ done: data.discoverDone || 0, total: data.discoverTotal });
        if (data.status === "done") {
          setStatus("done"); setItems(data.items || []); setResolvedSource(data.sourceTrack || null);
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

  const startWheel = async () => {
    const gen = ++generationRef.current; // nouvelle génération — invalide toute invocation précédente encore en vol
    setStatus("running"); setStep("pool"); setItems([]); setError(null); setSelectedItem(null);
    try {
      const res = await fetch(`${API}/api/mashup-wheel/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: sourceTrack.id, title: sourceTrack.title, channel: sourceTrack.channel || "" }),
      });
      const data = await res.json();
      if (gen !== generationRef.current) return; // cf. commentaire ci-dessus
      if (!res.ok) throw new Error(data.error || "Échec du lancement");
      pollingRef.current = false;
      pollJob(data.jobId, gen);
    } catch (e) {
      if (gen !== generationRef.current) return;
      setStatus("error"); setError(e.message);
    }
  };

  // Lancée une seule fois à l'ouverture — le morceau source est déjà connu
  // (Deck A, déjà analysé), pas besoin d'attendre une sélection utilisateur.
  useEffect(() => {
    startWheel();
    // Le nettoyage incrémente generationRef (au lieu de le remettre à une
    // valeur fixe) : invalide la génération en cours, que ce soit le
    // double-montage StrictMode ou un vrai démontage — cf. commentaire
    // détaillé ci-dessus.
    return () => { generationRef.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fenêtre déplaçable (retour utilisateur, juillet 2026) ────────────────
  // Position figée au centre à l'origine — glisser-déposer depuis l'en-tête
  // (zone titre, hors bouton ✕) pour la déplacer librement. dragPos est un
  // simple décalage (translate) appliqué par-dessus le centrage flex existant
  // du parent — aucun changement de layout nécessaire, juste un transform.
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const onHeaderMouseDown = (e) => {
    // Ignore les clics sur un élément interactif de l'en-tête (bouton ✕) —
    // seule la zone titre elle-même déclenche le déplacement.
    if (e.target.closest("button")) return;
    dragStateRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: dragPos.x, origY: dragPos.y };
    setIsDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e) => {
      const s = dragStateRef.current;
      if (!s.dragging) return;
      setDragPos({ x: s.origX + (e.clientX - s.startX), y: s.origY + (e.clientY - s.startY) });
    };
    const onUp = () => { dragStateRef.current.dragging = false; setIsDragging(false); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const positioned = items.map((item, i) => {
    const angle = (-90 + (items.length ? (360 / items.length) * i : 0)) * (Math.PI / 180);
    return { ...item, x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle) };
  });

  // Choisir un candidat → le Deck B le charge (MashupStudio.jsx branche ça
  // sur presetVideo, même mécanisme que "Envoyer en MacheUp" depuis Mashup
  // Wheel) → le mashup se lance automatiquement dès que les 2 decks sont
  // prêts → la fenêtre se ferme (onPick fait les deux : sélection + fermeture).
  const handlePick = (item) => {
    onPick({ id: item.videoId, title: item.title, channel: item.channel || "", thumb: item.thumbnail });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "transparent",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, pointerEvents: "none" }}>
      {/* Retour utilisateur : la fenêtre doit s'afficher en popup au milieu de
          la page SANS occulter l'arrière-plan — pas de voile sombre/flou
          derrière. La carte elle-même reste opaque (sinon illisible par-
          dessus le reste de l'UI) et récupère les clics (pointerEvents:auto),
          le clic en dehors (sur la zone transparente) ferme quand même la
          fenêtre via l'overlay fixe ci-dessus. */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, pointerEvents: "auto" }} />
      <div onClick={e => e.stopPropagation()} style={{
        position: "relative", pointerEvents: "auto",
        background: "#0f0f0f", border: "1px solid rgba(0,234,255,0.35)", borderRadius: 14,
        padding: 24, width: 760, maxWidth: "94vw", maxHeight: "90vh", overflowY: "auto",
        boxShadow: "0 20px 60px rgba(0,0,0,0.75), 0 0 50px rgba(0,234,255,0.18)",
        transform: `translate(${dragPos.x}px, ${dragPos.y}px)`,
        // Pas de transition CSS sur transform : elle "traînerait" derrière le
        // curseur pendant le glisser (retard visible à chaque mousemove) —
        // le déplacement doit suivre la souris au pixel près, en instantané.
      }}>
        <div onMouseDown={onHeaderMouseDown} style={{
          display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16,
          cursor: isDragging ? "grabbing" : "grab", userSelect: "none",
        }} title="Glisser pour déplacer la fenêtre">
          <div>
            <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 15, fontWeight: 900, letterSpacing: 3,
              background: "linear-gradient(90deg, var(--cyan), var(--magenta))", WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent", backgroundClip: "text", marginBottom: 6 }}>
              🧭 DJ ASSIST
            </div>
            <div style={{ fontSize: 12, color: "var(--muted2)" }}>
              Suggestions compatibles avec « {sourceTrack.title} » — choisis un clip pour le Deck B.
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #333", color: "#555",
            borderRadius: 6, width: 30, height: 30, cursor: "pointer", fontSize: 17, flexShrink: 0 }}>✕</button>
        </div>

        {status === "running" && (
          <div style={{ minHeight: 340, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 800, letterSpacing: 1, color: "var(--cyan)", textAlign: "center" }}>
              ⏳ {STEP_LABELS[step] || "Recherche en cours…"}
              {step === "analyze" && discoverProgress ? ` (${discoverProgress.done}/${discoverProgress.total})` : ""}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted2)", textAlign: "center", maxWidth: 340 }}>
              Ça peut prendre une minute ou deux si de nouveaux morceaux doivent être téléchargés et analysés pour la 1ère fois.
            </div>
          </div>
        )}

        {status === "error" && (
          <div style={{ minHeight: 340, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center", padding: 24 }}>
            <div style={{ color: "#ff8080", fontWeight: 700 }}>⚠ {error}</div>
            <button className="ghost-btn" onClick={startWheel}>↺ Réessayer</button>
          </div>
        )}

        {status === "done" && items.length === 0 && (
          <div style={{ minHeight: 340, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--muted2)", padding: 24 }}>
            Aucune correspondance trouvée pour l'instant — analyse d'autres morceaux dans MacheUp pour enrichir la roue au fil du temps.
          </div>
        )}

        {status === "done" && items.length > 0 && (
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
            <div style={{ position: "relative", width: CENTER * 2, height: CENTER * 2, flexShrink: 0 }}>
              <svg width={CENTER * 2} height={CENTER * 2} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                {positioned.map(p => (
                  <line key={p.videoId} x1={CENTER} y1={CENTER} x2={p.x} y2={p.y}
                    stroke={p.origin === "existing_mashup" ? PROVEN_COLOR : scoreColor(p.score)}
                    strokeOpacity={0.3 + (p.score / 100) * 0.4}
                    strokeWidth={selectedItem?.videoId === p.videoId ? 2.5 : 1} />
                ))}
              </svg>

              {/* Centre : morceau source (Deck A) */}
              <div title={resolvedSource?.title} style={{
                position: "absolute", left: CENTER - 38, top: CENTER - 38, width: 76, height: 76, borderRadius: "50%",
                border: "3px solid var(--cyan)", overflow: "hidden", boxShadow: "0 0 24px rgba(0,234,255,0.45)",
                zIndex: 2, background: "#000",
              }}>
                <img src={`https://i.ytimg.com/vi/${resolvedSource?.videoId}/mqdefault.jpg`} alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
              {resolvedSource && (
                <div style={{ position: "absolute", left: CENTER - 60, top: CENTER + 42, width: 120, textAlign: "center",
                  fontSize: 10, color: "var(--cyan)", fontWeight: 700, zIndex: 2 }}>
                  {resolvedSource.bpm} BPM · {resolvedSource.camelot || "?"}
                </div>
              )}

              {/* Candidats — taille et couleur du contour proportionnelles au score */}
              {positioned.map(p => {
                const size = 32 + (p.score / 100) * 20;
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
                    <img src={p.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    {proven && (
                      <div style={{ position: "absolute", top: -2, right: -2, fontSize: 11, lineHeight: 1,
                        filter: "drop-shadow(0 0 2px #000)" }}>🔊</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Détail du candidat sélectionné */}
            <div style={{ flex: "1 1 220px", minWidth: 220, maxWidth: 280 }}>
              {!selectedItem ? (
                <div style={{ color: "var(--muted2)", fontSize: 13, padding: "20px 10px", textAlign: "center" }}>
                  Clique sur un point de la roue pour voir le détail de compatibilité.
                </div>
              ) : (
                <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
                  <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                    <img src={selectedItem.thumbnail} alt="" style={{ width: 56, height: 42, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {selectedItem.title}
                      </div>
                      {selectedItem.channel && (
                        <div style={{ fontSize: 10, color: "var(--muted2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
                    <button className="ghost-btn" style={{ flex: 1, borderColor: "rgba(204,0,255,0.4)", color: "var(--magenta)" }}
                      onClick={() => handlePick(selectedItem)}>
                      🎚 Choisir pour Deck B
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}
