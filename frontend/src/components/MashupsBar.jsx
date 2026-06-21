import React, { useState, useRef } from "react";

export default function MashupsBar({ mashups = [], onDelete }) {
  // Petit player partagé : un seul <audio> pour toutes les cartes (au lieu
  // d'un par carte) — démarrer la lecture d'une carte met automatiquement en
  // pause la précédente, comme un vrai player de playlist.
  const [playingId, setPlayingId] = useState(null);
  const audioRef = useRef(null);

  // Aperçu audio rapide via la piste FLAC (toujours présente, même quand le
  // MP4 n'a pas pu être généré — ex: pistes locales uploadées). Les urls
  // stockées dans `mashups` sont déjà complètes (http://localhost:3001/...).
  const togglePlay = (m) => {
    const el = audioRef.current;
    if (!el) return;
    if (playingId === m.id) {
      el.pause();
      setPlayingId(null);
      return;
    }
    el.src = m.flacUrl;
    el.play().catch(() => {});
    setPlayingId(m.id);
  };

  return (
    <div className="mashups-bar">
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} style={{ display: "none" }} />
      <div className="mashups-bar-header">
        <div className="mashups-bar-title">
          <span className="bar-icon">⊞</span>
          Mes MacheUps
          <span className="mashups-count">[{mashups.length}]</span>
        </div>
        <button className="refresh-btn">↺ ACTUALISER</button>
      </div>

      <div className="mashups-list">
        {mashups.length === 0 ? (
          <div className="mashup-empty">
            Aucun macheup pour l'instant — charge deux pistes et lance CREATE MACHEUP.
          </div>
        ) : (
          mashups.map(m => (
            <div key={m.id} className="mashup-item">
              {/* Vignette pochette + bouton play superposé */}
              <div style={{
                width: 44, height: 44, borderRadius: 6, flexShrink: 0,
                overflow: "hidden", background: "#111", position: "relative",
                border: "1px solid rgba(255,255,255,0.06)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {m.cover ? (
                  <img src={m.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ fontSize: 19, opacity: 0.25 }}>🎵</span>
                )}
                <button
                  onClick={() => togglePlay(m)}
                  title={playingId === m.id ? "Pause" : "Lire ce mashup"}
                  style={{
                    position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                    background: playingId === m.id ? "rgba(0,234,255,0.25)" : "rgba(0,0,0,0.35)",
                    border: "none", color: "white", fontSize: 16, cursor: "pointer",
                    opacity: playingId === m.id ? 1 : 0, transition: "opacity 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = 1; }}
                  onMouseLeave={e => { if (playingId !== m.id) e.currentTarget.style.opacity = 0; }}
                >
                  {playingId === m.id ? "⏸" : "▶"}
                </button>
              </div>

              <div className="mashup-info" style={{ flex: 1, minWidth: 0 }}>
                <div className="title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</div>
                <div className="format">FLAC{m.mp4Url ? " + MP4" : ""}</div>
              </div>
              {/* FLAC + MP4 sont générés ensemble — un bouton de téléchargement
                  par format dispo, au lieu d'un seul fichier par carte. */}
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button className="dl-btn" title="Télécharger en FLAC"
                  onClick={() => window.open(m.flacUrl, "_blank")}>
                  ⬇ FLAC
                </button>
                {m.mp4Url && (
                  <button className="dl-btn" title="Télécharger en MP4"
                    onClick={() => window.open(m.mp4Url, "_blank")}>
                    ⬇ MP4
                  </button>
                )}
              </div>
              <button
                onClick={() => onDelete && onDelete(m.id)}
                title="Supprimer ce mashup"
                style={{
                  background: "transparent", border: "1px solid rgba(255,60,60,0.2)",
                  color: "rgba(255,80,80,0.45)", borderRadius: 6,
                  width: 28, height: 28, cursor: "pointer", fontSize: 15,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0, transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,60,60,0.12)"; e.currentTarget.style.color = "#ff5050"; e.currentTarget.style.borderColor = "rgba(255,60,60,0.5)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,80,80,0.45)"; e.currentTarget.style.borderColor = "rgba(255,60,60,0.2)"; }}
              >✕</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
