import React, { useEffect, useState } from "react";

const STEPS = [
  { id: "download", label: "Téléchargement",  icon: "⬇" },
  { id: "analyze",  label: "Analyse BPM",     icon: "🎵" },
  { id: "separate", label: "Séparation stems", icon: "🧬" },
  { id: "mix",      label: "Mixage",           icon: "🎛" },
  { id: "render",   label: "Rendu final",      icon: "🎬" },
];

export default function MashupProgressBar({ jobId, onClose, onDone }) {
  const [status, setStatus]       = useState("pending");
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError]         = useState(null);
  const [resultUrl, setResultUrl] = useState(null);

  useEffect(() => {
    if (!jobId) return;
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`http://localhost:3001/api/mashup/${jobId}/status`);
        const data = await res.json();
        setStatus(data.status);
        if (data.step !== undefined) setCurrentStep(data.step);
        if (data.status === "done") {
          // FLAC + MP4 sont désormais toujours générés ensemble — on garde
          // le lien FLAC ici pour le bouton "Télécharger" rapide du modal.
          setResultUrl(data.flacUrl);
          clearInterval(interval);
          if (onDone) onDone(data);
        }
        if (data.status === "error") {
          setError(data.message || "Erreur inconnue");
          clearInterval(interval);
        }
      } catch {
        setError("Impossible de contacter le serveur.");
        clearInterval(interval);
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [jobId]);

  const isDone    = status === "done";
  const isError   = status === "error";
  const pct       = isDone ? 100 : Math.round((currentStep / STEPS.length) * 100);
  const barColor  = isError ? "#ff4444" : isDone ? "#00eaff" : "linear-gradient(90deg,#00eaff,#cc00ff)";

  return (
    <div style={{
      margin: "0 12px 8px",
      background: "#0c0c0c",
      border: `1px solid ${isError ? "#ff444433" : isDone ? "#00eaff33" : "#1e1e1e"}`,
      borderRadius: 12,
      padding: "14px 18px",
      boxShadow: isDone ? "0 0 20px rgba(0,234,255,0.1)" : "none",
      transition: "border-color 0.4s",
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Spinner ou icône état */}
          {!isDone && !isError && (
            <div style={{
              width: 16, height: 16,
              border: "2px solid #00eaff33",
              borderTop: "2px solid #00eaff",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
              flexShrink: 0,
            }} />
          )}
          {isDone  && <span style={{ fontSize: 17 }}>✅</span>}
          {isError && <span style={{ fontSize: 17 }}>❌</span>}

          <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 13, fontWeight: 900, letterSpacing: 2,
            color: isDone ? "#00eaff" : isError ? "#ff4444" : "#fff" }}>
            {isDone ? "MACHEUP PRÊT !" : isError ? "ERREUR" : "CRÉATION EN COURS…"}
          </div>

          {/* Étape courante */}
          {!isDone && !isError && (
            <div style={{ fontSize: 12, color: "#555" }}>
              {STEPS[Math.min(currentStep, STEPS.length - 1)]?.icon}{" "}
              {STEPS[Math.min(currentStep, STEPS.length - 1)]?.label}
            </div>
          )}
        </div>

        {/* Actions droite */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {isDone && resultUrl && (
            <a href={`http://localhost:3001${resultUrl}`} download
              style={{ padding: "6px 14px", borderRadius: 6, background: "#00eaff", color: "#000",
                fontWeight: 800, fontSize: 13, textDecoration: "none", letterSpacing: 1 }}>
              ⬇ TÉLÉCHARGER
            </a>
          )}
          <button onClick={onClose} style={{
            background: "transparent", border: "1px solid #2a2a2a", color: "#555",
            borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 13,
          }}
            onMouseEnter={e => e.currentTarget.style.color = "white"}
            onMouseLeave={e => e.currentTarget.style.color = "#555"}>
            ✕
          </button>
        </div>
      </div>

      {/* Barre de progression */}
      <div style={{ height: 4, background: "#1a1a1a", borderRadius: 2, overflow: "hidden", marginBottom: 10 }}>
        <div style={{
          height: "100%", borderRadius: 2,
          width: pct + "%",
          background: barColor,
          transition: "width 0.6s ease",
        }} />
      </div>

      {/* Steps pills */}
      <div style={{ display: "flex", gap: 6 }}>
        {STEPS.map((step, i) => {
          const done   = isDone || i < currentStep;
          const active = !isDone && !isError && i === currentStep;
          return (
            <div key={step.id} style={{
              flex: 1, textAlign: "center", padding: "5px 4px", borderRadius: 6,
              background: active ? "rgba(0,234,255,0.08)" : done ? "rgba(0,234,255,0.04)" : "#111",
              border: `1px solid ${active ? "#00eaff44" : done ? "#00eaff22" : "#1a1a1a"}`,
              transition: "all 0.3s",
            }}>
              <div style={{ fontSize: 15 }}>{done ? "✓" : step.icon}</div>
              <div style={{ fontSize: 11, color: done ? "#00eaff" : active ? "white" : "#333",
                marginTop: 2, letterSpacing: 0.5 }}>{step.label}</div>
            </div>
          );
        })}
      </div>

      {/* Erreur */}
      {isError && (
        <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(255,68,68,0.08)",
          border: "1px solid #ff444433", borderRadius: 6, color: "#ff6666", fontSize: 13 }}>
          {error}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
