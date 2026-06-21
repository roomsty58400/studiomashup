import React, { useState, useEffect } from "react";
import { fetchSunoPrompt } from "../utils/mediaCache.js";

export default function PromptSunoModal({ video, onClose }) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Premier affichage : passe par le cache partagé — si le Deck a déjà préchargé
  // ce morceau en arrière-plan, le prompt apparaît instantanément.
  useEffect(() => { if (video) generatePrompt(false); }, [video]);

  const generatePrompt = async (force = true) => {
    if (!video) return;
    setLoading(true); setPrompt("");
    try {
      const data = await fetchSunoPrompt(video.title, video.channel, { force });
      if (!data) throw new Error("Réponse vide du serveur");
      if (data.error) throw new Error(data.error);
      if (!data.prompt) throw new Error("Réponse vide du serveur");
      setPrompt(data.prompt);
    } catch (err) {
      setPrompt("❌ " + (err.message || "Erreur de connexion au serveur."));
    }
    setLoading(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!video) return null;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", backdropFilter:"blur(10px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#0f0f0f", border:"1px solid #222", borderRadius:14, padding:28, width:540, maxWidth:"90vw", boxShadow:"0 20px 60px rgba(0,0,0,0.9)" }}>

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
          <div>
            <div style={{ fontFamily:"Orbitron,sans-serif", fontSize: 15, fontWeight:900, letterSpacing:3, color:"#cc00ff", marginBottom:6 }}>✦ PROMPT SUNO</div>
            <div style={{ fontSize: 15, fontWeight:600, color:"white", maxWidth:400 }}>{video.title}</div>
            <div style={{ fontSize: 13, color:"#555", marginTop:3 }}>{video.channel}</div>
          </div>
          <button onClick={onClose} style={{ background:"transparent", border:"1px solid #333", color:"#555", borderRadius:6, width:30, height:30, cursor:"pointer", fontSize: 17 }}>✕</button>
        </div>

        <div style={{ background:"#0a0a0a", border:"1px solid #1a1a1a", borderRadius:8, padding:16, height:320, overflowY:"auto", marginBottom:12 }}>
          {loading ? (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:12 }}>
              <div style={{ width:32, height:32, border:"2px solid #cc00ff33", borderTop:"2px solid #cc00ff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
              <div style={{ fontSize: 14, color:"#555" }}>Génération en cours...</div>
            </div>
          ) : (
            <pre style={{ margin:0, fontSize: 14, lineHeight:1.8, color:"#ccc", whiteSpace:"pre-wrap", fontFamily:"Inter,sans-serif" }}>
              {prompt || "Le prompt apparaîtra ici..."}
            </pre>
          )}
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={handleCopy} disabled={!prompt||loading}
            style={{ flex:1, padding:"10px 16px", borderRadius:8, border:"1px solid #cc00ff", background:copied?"#cc00ff":"transparent", color:copied?"#000":"#cc00ff", fontSize: 14, fontWeight:700, cursor:(!prompt||loading)?"not-allowed":"pointer", opacity:(!prompt||loading)?0.4:1, transition:"all 0.2s", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            {copied ? "✓ COPIÉ !" : "📋 COPIER LE PROMPT"}
          </button>
          <button onClick={() => generatePrompt(true)} disabled={loading}
            style={{ padding:"10px 16px", borderRadius:8, border:"1px solid #333", background:"transparent", color:"#555", fontSize: 14, fontWeight:700, cursor:loading?"not-allowed":"pointer" }}
            onMouseEnter={e=>e.currentTarget.style.color="white"} onMouseLeave={e=>e.currentTarget.style.color="#555"}>
            ↺ REGÉNÉRER
          </button>
          <a href="https://suno.com" target="_blank" rel="noreferrer"
            style={{ padding:"10px 16px", borderRadius:8, border:"1px solid #333", background:"transparent", color:"#555", fontSize: 14, fontWeight:700, textDecoration:"none", display:"flex", alignItems:"center", gap:6 }}
            onMouseEnter={e=>e.currentTarget.style.color="white"} onMouseLeave={e=>e.currentTarget.style.color="#555"}>
            🎵 SUNO ↗
          </a>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );
}
