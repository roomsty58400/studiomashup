import React, { useState, useEffect, useRef } from "react";
import { fetchLyrics } from "../utils/mediaCache.js";

// Décode toutes les entités HTML (&#39; → ', &amp; → &, etc.)
function decodeHtml(str) {
  const txt = document.createElement("textarea");
  txt.innerHTML = str || "";
  return txt.value;
}

export default function LyricsModal({ video, onClose }) {
  const [lyrics, setLyrics] = useState(null);
  const [meta, setMeta] = useState(null); // { source, parsedArtist, parsedSong }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!video) return;
    setLyrics(null);
    setMeta(null);
    setError(null);
    setCopied(false);
    setLoading(true);

    // Passe par le cache partagé : si le Deck a déjà préchargé ce morceau en
    // arrière-plan, la réponse arrive instantanément (pas de spinner visible).
    fetchLyrics(video.title, video.channel)
      .then(data => {
        if (!data) throw new Error("Réponse vide du serveur");
        if (data.error) throw new Error(data.error);
        setLyrics(data.lyrics);
        setMeta({ source: data.source, artist: data.parsedArtist, song: data.parsedSong });
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [video]);

  const handleCopy = () => {
    if (!lyrics) return;
    navigator.clipboard.writeText(lyrics).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!video) return null;

  // Fenêtre FLOTTANTE fermable (retour utilisateur, juillet 2026 — 1ère
  // tentative passée en inline par erreur : "ça s'ouvre en dessous", le
  // besoin réel était l'inverse — rendu en overlay plein écran, centré,
  // par-dessus le Deck, fermable via ✕ ou clic à l'extérieur).
  return (
    <div
      style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", backdropFilter:"blur(8px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background:"#0f0f0f", border:"1px solid #222", borderRadius:14,
          padding:28, width:580, maxWidth:"92vw", maxHeight:"88vh",
          display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,0.8)"
        }}
      >
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16, flexShrink:0 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:"Orbitron,sans-serif", fontSize: 14, fontWeight:900, letterSpacing:3, color:"#00eaff", marginBottom:6 }}>
              📄 LYRICS
            </div>
            {meta ? (
              <>
                <div style={{ fontSize: 16, fontWeight:700, color:"white", marginBottom:2 }}>{meta.song}</div>
                <div style={{ fontSize: 14, color:"#888" }}>{meta.artist}</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 15, fontWeight:600, color:"white", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:440 }}>{decodeHtml(video.title)}</div>
                <div style={{ fontSize: 13, color:"#555", marginTop:2 }}>{decodeHtml(video.channel)}</div>
              </>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ background:"transparent", border:"1px solid #333", color:"#555", borderRadius:6, width:30, height:30, cursor:"pointer", fontSize: 17, flexShrink:0, marginLeft:12 }}
          >✕</button>
        </div>

        {/* Body */}
        <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column", minHeight:0 }}>

          {/* Loading */}
          {loading && (
            <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, color:"#555" }}>
              <div style={{ width:30, height:30, border:"3px solid #222", borderTop:"3px solid #00eaff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
              <div style={{ fontSize: 13, letterSpacing:2, textTransform:"uppercase" }}>Identification de la chanson…</div>
              <div style={{ fontSize: 12, color:"#333" }}>Recherche sur 4 sources en parallèle</div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* Erreur */}
          {!loading && error && (
            <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10, padding:"0 16px", textAlign:"center" }}>
              <div style={{ fontSize: 28 }}>😔</div>
              <div style={{ fontSize: 15, color:"#ff5555" }}>Paroles introuvables</div>
              <div style={{ fontSize: 13, color:"#444", maxWidth:360 }}>{error}</div>
              <div style={{ marginTop:10, display:"flex", gap:12 }}>
                {[
                  ["Genius", `https://genius.com/search?q=${encodeURIComponent(decodeHtml(video.title))}`],
                  ["AZLyrics", `https://www.azlyrics.com/search.php?q=${encodeURIComponent(decodeHtml(video.title))}`],
                ].map(([label, url]) => (
                  <a key={label} href={url} target="_blank" rel="noreferrer"
                    style={{ fontSize: 13, color:"#00eaff", textDecoration:"none", border:"1px solid #00eaff33", padding:"5px 12px", borderRadius:6 }}>
                    {label} ↗
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Paroles */}
          {!loading && lyrics && (
            <>
              {/* Barre actions */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, flexShrink:0 }}>
                <div style={{ fontSize: 12, color:"#333", letterSpacing:1 }}>
                  via <span style={{ color:"#444" }}>{meta?.source}</span>
                </div>
                <button
                  onClick={handleCopy}
                  style={{
                    background: copied ? "#00eaff18" : "#161616",
                    border: `1px solid ${copied ? "#00eaff" : "#2a2a2a"}`,
                    color: copied ? "#00eaff" : "#888",
                    borderRadius:6, padding:"5px 16px",
                    cursor:"pointer", fontSize: 13, fontWeight:700, letterSpacing:1,
                    transition:"all 0.15s"
                  }}
                >
                  {copied ? "✓ COPIÉ" : "⎘ COPIER"}
                </button>
              </div>

              {/* Zone texte */}
              <div
                style={{
                  flex:1, overflowY:"auto", background:"#080808",
                  border:"1px solid #1c1c1c", borderRadius:8,
                  padding:"18px 20px", fontSize: 15, lineHeight:1.9,
                  color:"#bbb", whiteSpace:"pre-wrap", wordBreak:"break-word",
                  fontFamily:"'Courier New', monospace"
                }}
              >
                {lyrics}
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
