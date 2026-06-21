import React, { useState, useEffect } from "react";
import RadioPlayer from "./RadioPlayer.jsx";

function MacheUpLogo() {
  return (
    <svg viewBox="0 0 40 40" width="38" height="38">
      <defs>
        <linearGradient id="topbar-m1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#cc00ff" />
          <stop offset="50%" stopColor="#8a3cff" />
          <stop offset="100%" stopColor="#00eaff" />
        </linearGradient>
        <filter id="topbar-m-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#topbar-m-glow)">
        {/* Ligne ECG passant derrière le M */}
        <polyline points="0,21 6,21 9,10 12,30 15,21 25,21 28,8 31,32 34,21 40,21"
          fill="none" stroke="url(#topbar-m1)" strokeWidth="1.4" opacity="0.8"
          strokeLinecap="round" strokeLinejoin="round" />
        {/* Lettre M stylisée — prolongement épais de la ligne ECG */}
        <path
          d="M7,32 L7,9 L20,22 L33,9 L33,32"
          fill="none"
          stroke="url(#topbar-m1)"
          strokeWidth="6.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

// Petit haut-parleur rond stylisé (grille concentrique façon woofer),
// placé de part et d'autre du cadre de l'horloge. Pulsation façon membrane de
// woofer au rythme d'une basse — un léger décalage entre les deux (pulseDelay)
// donne un effet plus vivant qu'une pulsation parfaitement synchronisée.
function SpeakerIcon({ color, pulseDelay = 0 }) {
  return (
    <svg className="speaker-pulse" viewBox="0 0 40 40" width="38" height="38"
      style={{ filter: `drop-shadow(0 0 5px ${color})`, animationDelay: `${pulseDelay}s` }}>
      <circle cx="20" cy="20" r="18" fill="#0a0a0a" stroke={color} strokeWidth="1.4" opacity="0.95" />
      <circle cx="20" cy="20" r="13" fill="none" stroke={color} strokeWidth="0.8" opacity="0.55" />
      <circle cx="20" cy="20" r="9"  fill="none" stroke={color} strokeWidth="0.8" opacity="0.55" />
      <circle cx="20" cy="20" r="5"  fill={color} opacity="0.9" />
      <circle cx="20" cy="20" r="1.6" fill="#0a0a0a" />
    </svg>
  );
}

function EngineTag() {
  const text = "MUSIC AND CLIP HYBRID ENGINE UP";
  return (
    <div className="engine-tag">
      <span className="engine-tag-text">{text}</span>
    </div>
  );
}

const GradientText = ({ children, style = {} }) => (
  <span style={{
    background: "linear-gradient(90deg, #00eaff, #cc00ff)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
    ...style,
  }}>{children}</span>
);

function LiveClock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const pad = (n) => String(n).padStart(2, "0");
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());

  const date = now.toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const dateLabel = date.charAt(0).toUpperCase() + date.slice(1);

  const base = {
    fontFamily: "Orbitron, sans-serif",
    fontWeight: 900,
    fontSize: 19,
    letterSpacing: 2,
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, lineHeight: 1 }}>
      {/* Horloge */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 0, whiteSpace: "nowrap" }}>
        <GradientText style={base}>{hh}</GradientText>
        <GradientText style={{ ...base, animation: "clockColon 1s step-start infinite", display: "inline-block", width: 12, textAlign: "center" }}>:</GradientText>
        <GradientText style={base}>{mm}</GradientText>
        <GradientText style={{ ...base, animation: "clockColon 1s step-start infinite", display: "inline-block", width: 10, textAlign: "center", fontSize: 15 }}>:</GradientText>
        <GradientText style={{ ...base, fontSize: 15, opacity: 0.5 }}>{ss}</GradientText>
      </div>
      {/* Date en français */}
      <div style={{
        fontFamily: "Orbitron, sans-serif",
        fontSize: 12, fontWeight: 700,
        letterSpacing: 1.5, color: "rgba(0,234,255,0.4)",
      }}>{dateLabel}</div>
      <style>{`@keyframes clockColon { 0%,49%{opacity:1} 50%,100%{opacity:0} }`}</style>
    </div>
  );
}

export default function TopBar({ activeView = "studio", onChangeView }) {
  const [user, setUser] = useState(null);

  // Lire les params URL après callback OAuth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "ok") {
      const u = { name: params.get("name"), email: params.get("email"), avatar: params.get("avatar") };
      setUser(u);
      // Nettoyer l'URL
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleLogin = () => {
    window.location.href = "http://localhost:3001/api/auth/google/login";
  };

  const handleLogout = async () => {
    await fetch("http://localhost:3001/api/auth/logout", { credentials: "include" });
    setUser(null);
  };

  return (
    <div className="topbar" style={{ position: "relative" }}>
      <div className="topbar-logo">
        <div className="logo-icon">
          <MacheUpLogo />
        </div>
        <div className="logo-text">
          <div className="logo-title">MACHEUP <span>STUDIO</span></div>
          <div className="logo-sub">Live Dual-Deck Mixer · Powered by FFmpeg</div>
        </div>
        <EngineTag />
      </div>

      {/* Horloge centrée absolument sur la topbar (desktop) */}
      <div className="topbar-clock">
        <span className="topbar-speaker topbar-speaker-left"><SpeakerIcon color="#cc00ff" pulseDelay={0} /></span>
        <LiveClock />
        <span className="topbar-speaker topbar-speaker-right"><SpeakerIcon color="#00eaff" pulseDelay={0.4} /></span>
      </div>
      <div className="topbar-right">
        {onChangeView && (
          <div className="view-switch">
            <button
              className={`view-btn ${activeView === "studio" ? "active" : ""}`}
              onClick={() => onChangeView("studio")}
              title="Mixer deux titres"
            >
              🎚 MACHEUP
            </button>
            <button
              className={`view-btn ${activeView === "clip" ? "active" : ""}`}
              onClick={() => onChangeView("clip")}
              title="Transformer le son d'un clip avec une IA"
            >
              🎬 CLIP EDITOR
            </button>
          </div>
        )}
        <RadioPlayer />
        <button className="top-icon-btn" title="Paramètres">⚙</button>
        <a href="https://rave.dj" target="_blank" rel="noreferrer" className="top-btn rave topbar-fixed-btn">
          ⊕ RAVE.DJ
        </a>
        <a href="https://suno.com" target="_blank" rel="noreferrer" className="top-btn suno topbar-fixed-btn">
          ✦ SUNO
        </a>
        {user ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {user.avatar ? (
              <img
                src={user.avatar.replace(/=s\d+-c/, "=s64-c")}
                referrerPolicy="no-referrer"
                alt={user.name}
                style={{ width: 30, height: 30, borderRadius: "50%",
                  border: "2px solid rgba(0,234,255,0.45)", objectFit: "cover", flexShrink: 0 }}
              />
            ) : (
              <div style={{ width: 30, height: 30, borderRadius: "50%",
                background: "rgba(0,234,255,0.15)", border: "2px solid rgba(0,234,255,0.45)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 15, color: "#00eaff", flexShrink: 0 }}>
                {user.name?.[0]?.toUpperCase()}
              </div>
            )}
            <span style={{ fontSize: 13, color: "#aaa", maxWidth: 110,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {user.name}
            </span>
            <button onClick={handleLogout} title="Se déconnecter"
              style={{ background: "transparent", border: "1px solid rgba(255,60,60,0.3)",
                color: "#f55", borderRadius: 6, width: 26, height: 26, cursor: "pointer",
                fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0, transition: "all 0.2s" }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,60,60,0.15)"; e.currentTarget.style.borderColor = "#f55"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "rgba(255,60,60,0.3)"; }}>
              ✕
            </button>
          </div>
        ) : (
          <button className="login-btn topbar-fixed-btn" onClick={handleLogin}>
            GOOGLE
          </button>
        )}
      </div>
    </div>
  );
}
