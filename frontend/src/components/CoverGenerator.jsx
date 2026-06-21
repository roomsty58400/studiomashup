import React, { useState } from "react";

const FORMATS = [
  { id: "1:1",  label: "1:1",  sub: "Cover album" },
  { id: "16:9", label: "16:9", sub: "Bannière" },
  { id: "9:16", label: "9:16", sub: "TikTok / Reels" },
];

export default function CoverGenerator({ trackA, trackB, onClose, onCoverGenerated }) {
  const artistA = trackA?.channel || "Artist A";
  const artistB = trackB?.channel || "Artist B";
  const defaultTitle = trackA && trackB ? `${artistA} × ${artistB}` : "MON MACHEUP";

  const [mashupTitle, setMashupTitle] = useState(defaultTitle);
  const [format, setFormat]   = useState("1:1");
  const [imageUrl, setImageUrl] = useState(null);
  const [prompt, setPrompt]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  const hasTracks = trackA && trackB;

  const generate = async () => {
    setLoading(true); setError(null); setImageUrl(null); setImgLoaded(false);
    try {
      const res = await fetch("http://localhost:3001/api/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleA:  trackA?.title   || "Track A",
          artistA: artistA,
          titleB:  trackB?.title   || "Track B",
          artistB: artistB,
          mashupTitle: mashupTitle.trim() || defaultTitle,
          format,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const fullUrl = `http://localhost:3001${data.url}`;
      setImageUrl(fullUrl);
      if (onCoverGenerated) onCoverGenerated(fullUrl);
      setPrompt(data.prompt || "");
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `cover-${Date.now()}.png`;
    a.target = "_blank";
    a.click();
  };

  return (
    <div style={{
      position:"fixed", inset:0,
      background:"rgba(0,0,0,0.92)", backdropFilter:"blur(12px)",
      display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background:"#0c0c0c", border:"1px solid #222", borderRadius:16,
        width:820, maxWidth:"95vw", maxHeight:"92vh", overflow:"hidden",
        display:"flex", flexDirection:"column",
        boxShadow:"0 0 0 1px rgba(204,0,255,0.1), 0 24px 80px rgba(0,0,0,0.9)"
      }}>

        {/* Header */}
        <div style={{
          display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"18px 24px", borderBottom:"1px solid #1a1a1a",
          background:"linear-gradient(90deg, rgba(204,0,255,0.05) 0%, transparent 100%)"
        }}>
          <div>
            <div style={{ fontFamily:"Orbitron,sans-serif", fontSize: 15, fontWeight:900, letterSpacing:4, color:"#cc00ff" }}>
              ✦ GÉNÉRATEUR DE POCHETTE · NEON
            </div>
            <div style={{ fontSize: 13, color:"#444", marginTop:4, letterSpacing:1 }}>
              {hasTracks
                ? `${trackA.title} × ${trackB.title}`
                : "Chargez deux pistes dans les decks"}
            </div>
          </div>
          <button onClick={onClose} style={{
            background:"transparent", border:"1px solid #333", color:"#555",
            borderRadius:6, width:30, height:30, cursor:"pointer", fontSize: 17
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ display:"flex", flex:1, overflow:"hidden", minHeight:0 }}>

          {/* Panneau gauche — contrôles */}
          <div style={{
            width:260, padding:"20px 18px", borderRight:"1px solid #1a1a1a",
            overflowY:"auto", display:"flex", flexDirection:"column", gap:20
          }}>

            {/* Thumbnails */}
            {hasTracks && (
              <div style={{ display:"flex", gap:8 }}>
                {[trackA, trackB].map((t, i) => (
                  <div key={i} style={{ flex:1, position:"relative" }}>
                    {(t.thumb || t.thumbnail) && (
                      <img src={t.thumb || t.thumbnail} alt="" style={{
                        width:"100%", aspectRatio:"16/9", objectFit:"cover",
                        borderRadius:6, opacity:0.7
                      }} />
                    )}
                    <div style={{
                      position:"absolute", bottom:0, left:0, right:0,
                      background:"linear-gradient(transparent, rgba(0,0,0,0.9))",
                      borderRadius:"0 0 6px 6px", padding:"4px 6px",
                      fontSize: 11, color:"#aaa", letterSpacing:0.5,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"
                    }}>{t.channel}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Titre du mashup */}
            <div>
              <div style={{ fontSize: 11, color:"#444", letterSpacing:2, textTransform:"uppercase", marginBottom:8 }}>
                Titre du macheup
              </div>
              <input
                value={mashupTitle}
                onChange={e => setMashupTitle(e.target.value)}
                placeholder="Ex: Electric Dreams"
                style={{
                  width:"100%", background:"#111", border:"1px solid #2a2a2a",
                  borderRadius:8, padding:"9px 12px", color:"white",
                  fontSize: 14, letterSpacing:1, fontFamily:"inherit",
                  boxSizing:"border-box", outline:"none",
                  transition:"border-color 0.2s"
                }}
                onFocus={e => e.target.style.borderColor="#cc00ff"}
                onBlur={e => e.target.style.borderColor="#2a2a2a"}
              />
              <div style={{ fontSize: 11, color:"#333", marginTop:5 }}>
                Affiché sur la pochette avec {artistA} × {artistB}
              </div>
            </div>

            {/* Style badge NEON */}
            <div style={{
              background:"rgba(0,234,255,0.05)",
              border:"1px solid rgba(0,234,255,0.15)",
              borderRadius:10, padding:"12px 14px", textAlign:"center"
            }}>
              <div style={{ fontSize: 22, marginBottom:4 }}>🌆</div>
              <div style={{ fontSize: 13, fontWeight:900, color:"#00eaff", letterSpacing:3 }}>NEON</div>
              <div style={{ fontSize: 11, color:"#334", marginTop:3 }}>Néon & glow cyberpunk</div>
            </div>

            {/* Format */}
            <div>
              <div style={{ fontSize: 11, color:"#444", letterSpacing:2, textTransform:"uppercase", marginBottom:10 }}>Format</div>
              <div style={{ display:"flex", gap:6 }}>
                {FORMATS.map(f => (
                  <button key={f.id} onClick={() => setFormat(f.id)} style={{
                    flex:1, background: format === f.id ? "rgba(204,0,255,0.15)" : "#111",
                    border: `1px solid ${format === f.id ? "#cc00ff" : "#1e1e1e"}`,
                    borderRadius:8, padding:"8px 4px", cursor:"pointer", transition:"all 0.15s"
                  }}>
                    <div style={{ fontSize: 13, fontWeight:700, color: format === f.id ? "#cc00ff" : "#666" }}>{f.label}</div>
                    <div style={{ fontSize: 11, color:"#333", marginTop:2 }}>{f.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Bouton générer */}
            <button onClick={generate} disabled={loading || !hasTracks} style={{
              background: hasTracks ? "linear-gradient(135deg, rgba(204,0,255,0.3), rgba(0,234,255,0.15))" : "#111",
              border: `1px solid ${hasTracks ? "#cc00ff" : "#222"}`,
              borderRadius:10, padding:"12px 16px", cursor: hasTracks ? "pointer" : "not-allowed",
              color: hasTracks ? "#cc00ff" : "#333", fontSize: 14, fontWeight:900,
              letterSpacing:2, transition:"all 0.2s",
              opacity: loading ? 0.7 : 1
            }}>
              {loading ? "⏳ Génération…" : imageUrl ? "↺ REGÉNÉRER" : "✦ GÉNÉRER"}
            </button>

            {!hasTracks && (
              <div style={{ fontSize: 12, color:"#444", textAlign:"center", lineHeight:1.6 }}>
                Chargez une vidéo dans chaque deck pour activer la génération.
              </div>
            )}
          </div>

          {/* Panneau droit — aperçu */}
          <div style={{
            flex:1, display:"flex", flexDirection:"column",
            alignItems:"center", justifyContent:"center",
            padding:24, gap:16, background:"#080808"
          }}>
            {/* Zone image */}
            <div style={{
              width:"100%", maxWidth:420,
              aspectRatio: format === "9:16" ? "9/16" : format === "16:9" ? "16/9" : "1/1",
              background:"#111", borderRadius:12, border:"1px solid #1e1e1e",
              display:"flex", alignItems:"center", justifyContent:"center",
              overflow:"hidden", position:"relative",
              boxShadow: imageUrl ? "0 0 40px rgba(204,0,255,0.15), 0 0 80px rgba(0,0,0,0.8)" : "none",
              transition:"box-shadow 0.5s"
            }}>
              {loading && (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14 }}>
                  <div style={{
                    width:40, height:40, border:"3px solid #cc00ff22",
                    borderTop:"3px solid #cc00ff", borderRadius:"50%",
                    animation:"spin 0.8s linear infinite"
                  }} />
                  <div style={{ fontSize: 13, color:"#555", letterSpacing:2 }}>GÉNÉRATION IA…</div>
                  <div style={{ fontSize: 11, color:"#333" }}>Gemini · style NEON</div>
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              )}

              {!loading && error && (
                <div style={{ textAlign:"center", padding:20 }}>
                  <div style={{ fontSize: 24, marginBottom:8 }}>⚠️</div>
                  <div style={{ fontSize: 13, color:"#ff5555", maxWidth:280, lineHeight:1.6 }}>{error}</div>
                </div>
              )}

              {!loading && !error && !imageUrl && (
                <div style={{ textAlign:"center", color:"#2a2a2a" }}>
                  <div style={{ fontSize: 48, marginBottom:8 }}>🖼</div>
                  <div style={{ fontSize: 13, letterSpacing:2, textTransform:"uppercase" }}>Aperçu</div>
                </div>
              )}

              {imageUrl && (
                <>
                  {!imgLoaded && (
                    <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", background:"#111" }}>
                      <div style={{ width:32, height:32, border:"3px solid #cc00ff22", borderTop:"3px solid #cc00ff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
                    </div>
                  )}
                  <img
                    src={imageUrl}
                    alt="Pochette générée"
                    onLoad={() => setImgLoaded(true)}
                    style={{
                      width:"100%", height:"100%", objectFit:"cover",
                      opacity: imgLoaded ? 1 : 0, transition:"opacity 0.4s"
                    }}
                  />
                </>
              )}
            </div>

            {/* Prompt discret */}
            {prompt && (
              <div style={{
                width:"100%", maxWidth:420, fontSize: 11, color:"#222",
                lineHeight:1.6, fontFamily:"monospace",
                borderTop:"1px solid #111", paddingTop:10
              }}>
                <span style={{ color:"#333", letterSpacing:1 }}>PROMPT · </span>{prompt}
              </div>
            )}

            {/* Actions */}
            {imageUrl && imgLoaded && (
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={generate} style={{
                  padding:"9px 20px", borderRadius:8,
                  border:"1px solid #333", background:"transparent",
                  color:"#888", fontSize: 13, fontWeight:700, cursor:"pointer", letterSpacing:1
                }}
                onMouseEnter={e => e.currentTarget.style.color="white"}
                onMouseLeave={e => e.currentTarget.style.color="#888"}>
                  ↺ REGÉNÉRER
                </button>
                <button onClick={download} style={{
                  padding:"9px 20px", borderRadius:8,
                  border:"1px solid #cc00ff", background:"rgba(204,0,255,0.15)",
                  color:"#cc00ff", fontSize: 13, fontWeight:700, cursor:"pointer", letterSpacing:1
                }}>
                  ⬇ TÉLÉCHARGER
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
