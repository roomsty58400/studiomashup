import React, { useState, useRef } from "react";
import { buildDownloadUrl, triggerDownload } from "../utils/download.js";

export default function MashupsBar({ mashups = [], onDelete, onRefresh, onClearAll }) {
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
        <div style={{ display: "flex", gap: 6 }}>
          {/* Correctif juillet 2026 : ce bouton n'avait jusqu'ici AUCUN
              onClick (no-op silencieux) — cf. services/mashupHistory.js et
              routes/mashups.js côté serveur pour la vraie source de vérité
              persistante que ce bouton relit désormais. */}
          <button className="refresh-btn" onClick={() => onRefresh && onRefresh()}>↺ ACTUALISER</button>
          {/* Nouveau (retour utilisateur juillet 2026) : vider tout
              l'historique ET les fichiers FLAC/MP4 correspondants sur le
              disque — pour l'utilisateur qui veut faire le ménage plutôt que
              de supprimer les macheups un par un. */}
          {mashups.length > 0 && (
            <button
              className="refresh-btn"
              title="Supprimer tout l'historique et les fichiers générés"
              onClick={() => onClearAll && onClearAll()}
              style={{ color: "rgba(255,90,90,0.75)", borderColor: "rgba(255,60,60,0.3)" }}
            >🧹 VIDER</button>
          )}
        </div>
      </div>

      <div className="mashups-list">
        {mashups.length === 0 ? (
          <div className="mashup-empty">
            Aucun macheup pour l'instant — charge deux pistes et lance CREATE MACHEUP.
          </div>
        ) : (
          mashups.map(m => (
            <div key={m.id} className="mashup-item">
              {/* Vignette + bouton play superposé. Priorité à une vraie image
                  du clip généré : un <video> sans contrôles, sur sa première
                  image décodée, sert de miniature (au lieu de la pochette IA
                  ou de l'icône générique) — visuellement, on reconnaît tout
                  de suite le clip plutôt qu'une pochette abstraite. */}
              <div style={{
                width: 34, height: 34, borderRadius: 6, flexShrink: 0,
                overflow: "hidden", background: "#111", position: "relative",
                border: "1px solid rgba(255,255,255,0.06)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {m.mp4Url ? (
                  <video src={m.mp4Url} muted preload="metadata" playsInline
                    style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : m.cover ? (
                  <img src={m.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ fontSize: 15, opacity: 0.25 }}>🎵</span>
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
                {/* Étiquette à fond coloré — pour repérer le mashup d'un coup
                    d'œil dans la liste, au lieu d'un simple texte uniforme. */}
                <div className="title" style={{
                  display: "inline-block", maxWidth: "100%", boxSizing: "border-box",
                  background: "rgba(0,234,255,0.12)", border: "1px solid rgba(0,234,255,0.35)",
                  borderRadius: 5, padding: "2px 8px", color: "var(--cyan)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{m.title}</div>
                <div className="format">FLAC{m.mp4Url ? " + MP4" : ""}</div>
              </div>
              {/* FLAC + MP4 sont générés ensemble — un bouton de téléchargement
                  par format dispo, au lieu d'un seul fichier par carte. */}
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {/* window.open ignore Content-Disposition côté cible cross-
                    origin (:5173 → :3001) et se contente d'ouvrir/lire le
                    fichier — triggerDownload passe par la route backend qui
                    force le téléchargement, cf. utils/download.js. */}
                <button className="dl-btn" title="Télécharger en FLAC"
                  onClick={() => triggerDownload(buildDownloadUrl(m.flacUrl, m.title))}>
                  ⬇ FLAC
                </button>
                {m.mp4Url && (
                  <button className="dl-btn" title="Télécharger en MP4"
                    onClick={() => triggerDownload(buildDownloadUrl(m.mp4Url, m.title))}>
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
                  width: 24, height: 24, cursor: "pointer", fontSize: 13,
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
