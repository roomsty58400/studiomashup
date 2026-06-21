import React, { useState, useRef, useEffect } from "react";

// Icônes des 4 pads DJ (recul/play/pause/stop) en SVG plutôt qu'en emoji
// texte (⏪▶⏸⏹) : le rendu des emoji varie trop selon l'OS/la police (souvent
// flou, mal centré, ou en couleur fixe qui ignore le thème métal) — des
// formes vectorielles simples en "currentColor" s'intègrent proprement à
// l'icône "gravée" qui s'allume en LED (cf. .dj-pad-icon dans styles.css).
const IconRewind = (props) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" {...props}>
    <path d="M11.5 6 1 12l10.5 6z" />
    <path d="M22.5 6 12 12l10.5 6z" />
  </svg>
);
const IconPlay = (props) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" {...props}>
    <path d="M5 4l15 8-15 8z" />
  </svg>
);
const IconPause = (props) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" {...props}>
    <rect x="5" y="4" width="5" height="16" rx="1.2" />
    <rect x="14" y="4" width="5" height="16" rx="1.2" />
  </svg>
);
const IconStop = (props) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" {...props}>
    <rect x="5" y="5" width="14" height="14" rx="2.5" />
  </svg>
);

function formatTime(s) {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function MashupPlayer({ mashupResult, coverUrl, generatingCover, onOpenCover }) {
  const mediaRef    = useRef(null);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent]   = useState(0);
  const [duration, setDuration] = useState(0);
  const [copied, setCopied]     = useState(false);
  const [volume, setVolume]     = useState(40);
  // Le MP4 (quand généré) prend la priorité dans le lecteur, à la place de
  // la pochette statique + FLAC — les 2 formats sont désormais toujours
  // générés ensemble, donc dès que le MP4 est prêt on bascule sur la vidéo.
  const isVideo = !!mashupResult?.mp4Url;
  const mediaSrc = isVideo ? mashupResult.mp4Url : mashupResult.flacUrl;

  // Reset player when a new mashup arrives
  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setCurrent(0);
    setDuration(0);
  }, [mediaSrc]);

  // Applique le volume par défaut (40%) à chaque nouveau média (l'élément
  // <video>/<audio> repart sinon à 100% de son côté, indépendamment du state).
  useEffect(() => {
    if (mediaRef.current) mediaRef.current.volume = volume / 100;
  }, [mediaSrc, volume]);

  const handleVolumeChange = (e) => setVolume(Number(e.target.value));

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) { el.play(); setPlaying(true); }
    else           { el.pause(); setPlaying(false); }
  };

  const handleTimeUpdate = () => {
    const el = mediaRef.current;
    if (!el || !el.duration) return;
    setCurrent(el.currentTime);
    setProgress(el.currentTime / el.duration);
  };

  const handleLoadedMetadata = () => {
    if (mediaRef.current) setDuration(mediaRef.current.duration);
  };

  const handleEnded = () => setPlaying(false);

  const handleSeek = (e) => {
    const el = mediaRef.current;
    if (!el || !el.duration) return;
    const rect  = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * el.duration;
    setProgress(ratio);
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = mediaSrc;
    a.download = `${mashupResult.title || "mashup"}.${isVideo ? "mp4" : "flac"}`;
    a.click();
  };

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: mashupResult.title, url: mediaSrc });
      } else {
        await navigator.clipboard.writeText(mediaSrc);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {}
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: "#444", letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>
        MacheUp · Lecture
      </div>

      {/* Conteneur média + fader de volume du player à côté */}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
      <div style={{ position: "relative", borderRadius: 8, overflow: "hidden", flex: 1, minWidth: 0,
        border: "1px solid rgba(0,234,255,0.15)",
        boxShadow: "0 0 24px rgba(0,234,255,0.08)",
        background: "#0a0a0a",
      }}>
        {/* Vidéo mp4 */}
        {isVideo && (
          <video
            ref={mediaRef}
            src={mediaSrc}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleEnded}
            style={{ width: "100%", display: "block", maxHeight: 180, objectFit: "cover" }}
          />
        )}

        {/* Cover art + audio mp3 */}
        {!isVideo && (
          <div style={{ position: "relative", aspectRatio: "1/1", overflow: "hidden" }}>
            {coverUrl ? (
              <img
                src={coverUrl}
                alt="Pochette"
                onClick={() => onOpenCover && onOpenCover()}
                style={{ width: "100%", height: "100%", objectFit: "cover", cursor: "pointer", display: "block",
                  filter: playing ? "brightness(0.55)" : "brightness(0.65)", transition: "filter 0.3s" }}
              />
            ) : generatingCover ? (
              <div style={{ width: "100%", aspectRatio: "1/1", background: "#111",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <div style={{ width: 24, height: 24, border: "2px solid #cc00ff33",
                  borderTop: "2px solid #cc00ff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                <div style={{ fontSize: 11, color: "#444", letterSpacing: 2 }}>POCHETTE…</div>
              </div>
            ) : (
              <div style={{ width: "100%", aspectRatio: "1/1", background: "#111",
                display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 36, opacity: 0.2 }}>🎵</span>
              </div>
            )}

            {/* Bouton play/pause centré */}
            <button onClick={togglePlay} style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              background: "transparent", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: "50%",
                background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)",
                border: "2px solid rgba(0,234,255,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 19, color: "#00eaff",
                boxShadow: "0 0 20px rgba(0,234,255,0.3)",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.1)"; e.currentTarget.style.boxShadow = "0 0 30px rgba(0,234,255,0.5)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 0 20px rgba(0,234,255,0.3)"; }}
              >{playing ? "⏸" : "▶"}</div>
            </button>

            {/* Titre en bas de l'image */}
            <div style={{
              position: "absolute", bottom: 0, left: 0, right: 0,
              background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
              padding: "20px 10px 8px",
              fontSize: 11, color: "rgba(255,255,255,0.7)",
              letterSpacing: 0.5, textAlign: "center",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{mashupResult.title}</div>
          </div>
        )}

        {/* Audio invisible */}
        {!isVideo && (
          <audio ref={mediaRef} src={mediaSrc}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleEnded} />
        )}

        {/* Contrôle play pour vidéo */}
        {isVideo && (
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0,
            background: "linear-gradient(transparent, rgba(0,0,0,0.8))",
            padding: "16px 10px 6px",
            display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={togglePlay} style={{
              background: "transparent", border: "none", color: "#00eaff",
              fontSize: 17, cursor: "pointer", padding: 0, lineHeight: 1,
            }}>{playing ? "⏸" : "▶"}</button>
          </div>
        )}
      </div>

      <div className="vol-slider-wrap clip-vol-cyan">
        <div className="vol-icon">{volume == 0 ? "🔇" : volume < 50 ? "🔉" : "🔊"}</div>
        <div className="vol-track-wrap">
          <div className="vol-track-fill" style={{ height: `${volume}%` }} />
          <div className="vol-ticks">
            {[0, 1, 2, 3, 4].map(i => <span key={i} />)}
          </div>
          <input type="range" className="vol-slider"
            min="0" max="100" step="1" value={volume}
            onChange={handleVolumeChange} />
        </div>
      </div>
      </div>

      {/* Barre de progression cliquable */}
      <div onClick={handleSeek} style={{
        height: 3, background: "#1a1a1a", borderRadius: 2,
        marginTop: 6, cursor: "pointer", overflow: "hidden",
      }}>
        <div style={{
          height: "100%", borderRadius: 2,
          width: (progress * 100) + "%",
          background: "linear-gradient(90deg, #00eaff, #cc00ff)",
          transition: "width 0.3s linear",
        }} />
      </div>

      {/* Temps écoulé / total */}
      <div style={{ display: "flex", justifyContent: "space-between",
        fontSize: 11, color: "#444", marginTop: 4, letterSpacing: 1 }}>
        <span>{formatTime(current)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      {/* Télécharger + Partager */}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button onClick={handleDownload} style={{
          flex: 1, padding: "8px 0", borderRadius: 7,
          background: "rgba(0,234,255,0.1)", border: "1px solid rgba(0,234,255,0.25)",
          color: "#00eaff", fontSize: 12, fontWeight: 800, cursor: "pointer",
          letterSpacing: 1, transition: "all 0.15s",
        }}
        onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,234,255,0.2)"; e.currentTarget.style.borderColor = "#00eaff"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(0,234,255,0.1)"; e.currentTarget.style.borderColor = "rgba(0,234,255,0.25)"; }}
        >⬇ TÉLÉCHARGER</button>

        <button onClick={handleShare} style={{
          flex: 1, padding: "8px 0", borderRadius: 7,
          background: copied ? "rgba(0,255,120,0.1)" : "rgba(204,0,255,0.1)",
          border: `1px solid ${copied ? "rgba(0,255,120,0.3)" : "rgba(204,0,255,0.25)"}`,
          color: copied ? "#00ff78" : "#cc00ff",
          fontSize: 12, fontWeight: 800, cursor: "pointer",
          letterSpacing: 1, transition: "all 0.2s",
        }}
        onMouseEnter={e => { if (!copied) { e.currentTarget.style.background = "rgba(204,0,255,0.2)"; e.currentTarget.style.borderColor = "#cc00ff"; }}}
        onMouseLeave={e => { if (!copied) { e.currentTarget.style.background = "rgba(204,0,255,0.1)"; e.currentTarget.style.borderColor = "rgba(204,0,255,0.25)"; }}}
        >{copied ? "✓ COPIÉ !" : "⬆ PARTAGER"}</button>
      </div>
    </div>
  );
}

export default function Mixer({ trackA, trackB, analysisA, analysisB, onCreateMashup, onCrossfadeChange, onOpenCover,
  onSyncPlay, onSyncPause, onSyncRewind, onMasterVolumeChange, coverUrl, mashupResult, generatingCover }) {
  const [crossfade, setCrossfade] = useState(0.5);
  // Volume master — synchronise les 2 barres de volume des Decks A et B sur
  // la même valeur (séparé du crossfader, qui gère lui l'équilibre/balance
  // entre les 2 decks, pas le niveau global).
  const [masterVolume, setMasterVolume] = useState(80);
  const handleMasterVolumeChange = (e) => {
    const v = Number(e.target.value);
    setMasterVolume(v);
    if (onMasterVolumeChange) onMasterVolumeChange(v);
  };
  // Score de compatibilité (BPM/clé/énergie/structure/spectral) entre les 2
  // decks — calculé instantanément côté serveur dès que les deux morceaux
  // ont été analysés (bouton "🧬 Analyser" dans chaque Deck).
  const [compat, setCompat] = useState(null);
  const [compatLoading, setCompatLoading] = useState(false);
  const [compatError, setCompatError] = useState(null);

  useEffect(() => {
    if (!analysisA?.id || !analysisB?.id) { setCompat(null); setCompatError(null); return; }
    let cancelled = false;
    setCompatLoading(true); setCompatError(null);
    fetch("http://localhost:3001/api/analyze/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoIdA: analysisA.id, videoIdB: analysisB.id }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) { setCompatError(data.error || "Erreur de calcul du score"); setCompat(null); }
        else setCompat(data);
      })
      .catch(e => { if (!cancelled) { setCompatError(e.message); setCompat(null); } })
      .finally(() => { if (!cancelled) setCompatLoading(false); });
    return () => { cancelled = true; };
  }, [analysisA?.id, analysisB?.id]);
  const [mode, setMode] = useState("full");
  const [syncPlaying, setSyncPlaying] = useState(false);

  const handleCrossfade = (val) => {
    setCrossfade(val);
    if (onCrossfadeChange) onCrossfadeChange(val);
  };

  return (
    <div className="mixer">
      <div style={{ textAlign: "center" }}>
        <div className="mixer-title">MIXER</div>
      </div>

      <div className="mixer-controls">
        <button className="dj-pad dj-pad--rewind" title="Reculer les 2 decks de 5s (sans couper la lecture)"
          onClick={() => { if (onSyncRewind) onSyncRewind(); }}>
          <IconRewind className="dj-pad-icon" />
        </button>
        <button className={`dj-pad dj-pad--play ${syncPlaying ? "is-active" : ""}`} title="Lecture synchronisée" onClick={() => {
          setSyncPlaying(true);
          if (onSyncPlay) onSyncPlay();
        }}>
          <IconPlay className="dj-pad-icon" />
        </button>
        <button className="dj-pad dj-pad--pause" title="Pause synchronisée" onClick={() => {
          setSyncPlaying(false);
          if (onSyncPause) onSyncPause();
        }}>
          <IconPause className="dj-pad-icon" />
        </button>
        <button className="dj-pad dj-pad--stop" title="Stop" onClick={() => {
          setSyncPlaying(false);
          if (onSyncPause) onSyncPause();
        }}>
          <IconStop className="dj-pad-icon" />
        </button>
      </div>

      {/* Volume master — bouge les 2 barres de volume des Decks A et B en
          même temps, sur la même valeur (le crossfader plus bas gère lui
          l'équilibre/balance entre les 2, pas le niveau global). */}
      <div className="master-vol-row" title="Volume master (synchronise Deck A + Deck B)">
        <span className="master-vol-icon">{masterVolume === 0 ? "🔇" : masterVolume < 50 ? "🔉" : "🔊"}</span>
        <input type="range" className="master-vol-slider"
          min="0" max="100" step="1" value={masterVolume}
          onChange={handleMasterVolumeChange} />
        <span className="master-vol-pct">{masterVolume}%</span>
      </div>

      {/* Score de compatibilité (BPM/clé/énergie/structure/spectral) — visible
          dès que les 2 decks ont été analysés via le bouton "🧬 Analyser". */}
      {(analysisA || analysisB) && (
        <div style={{
          background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10,
          padding: "10px 12px", fontSize: 12,
        }}>
          {!analysisA || !analysisB ? (
            <div style={{ color: "var(--muted2)", textAlign: "center" }}>
              Analyse {!analysisA ? "Deck A" : "Deck B"} manquante pour calculer le score.
            </div>
          ) : compatLoading ? (
            <div style={{ color: "var(--muted2)", textAlign: "center" }}>Calcul du score…</div>
          ) : compatError ? (
            <div style={{ color: "#ff8080", textAlign: "center" }}>⚠ {compatError}</div>
          ) : compat ? (
            <>
              <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 1, marginBottom: compat.vocalLockEngaged ? 0 : 8,
                color: compat.vocalLockEngaged ? "#ff6666" : compat.score >= 70 ? "var(--green)" : compat.score >= 40 ? "#ffaa00" : "#ff8080" }}>
                {compat.vocalLockEngaged ? "⛔ INCOMPATIBLE" : `COMPATIBILITÉ ${compat.score}/100`}
              </div>
              {!compat.vocalLockEngaged && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: 10, color: "var(--muted2)" }}>
                  <span title="BPM" style={{ whiteSpace: "nowrap" }}>⏱ BPM {compat.subscores.bpm}</span>
                  <span title="Clé" style={{ whiteSpace: "nowrap" }}>🎹 Clé {compat.subscores.key}</span>
                  <span title="Énergie" style={{ whiteSpace: "nowrap" }}>🔥 Énerg. {compat.subscores.energy}</span>
                  <span title="Structure" style={{ whiteSpace: "nowrap" }}>📐 Struct. {compat.subscores.structure}</span>
                  <span title="Spectral" style={{ whiteSpace: "nowrap" }}>🌈 Spectr. {compat.subscores.spectral}</span>
                </div>
              )}
              {compat.invalidReason && (
                <div style={{ color: "#ff8080", fontSize: 11, marginTop: 6 }}>{compat.invalidReason}</div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* Titre choisi automatiquement par l'IA (cf. MashupStudio.jsx) — plus
          de champ ni de bouton ici, gain de temps total. FLAC + MP4 sont
          eux aussi toujours générés ensemble, plus de choix de format. */}
      <button className="primary-btn"
        onClick={() => onCreateMashup && onCreateMashup({ crossfade, mode })}>
        ✦ CREATE MACHEUP
      </button>

      {/* Pochette générée par l'IA automatiquement à la fin du Create Macheup
          (cf. handleJobDone dans MashupStudio.jsx, POST /api/cover) — plus
          besoin d'un bouton dédié, elle s'affiche ici dès qu'elle est prête. */}
      {mashupResult ? (
        <MashupPlayer
          mashupResult={mashupResult}
          coverUrl={coverUrl}
          generatingCover={generatingCover}
          onOpenCover={onOpenCover}
        />
      ) : coverUrl ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: "#444", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>
            Dernière pochette
          </div>
          <img src={coverUrl} alt="Pochette" onClick={() => onOpenCover && onOpenCover()}
            style={{ width: "100%", borderRadius: 8, border: "1px solid rgba(204,0,255,0.25)",
              boxShadow: "0 0 20px rgba(204,0,255,0.15)", cursor: "pointer", transition: "box-shadow 0.2s" }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = "0 0 30px rgba(204,0,255,0.4)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = "0 0 20px rgba(204,0,255,0.15)"} />
        </div>
      ) : null}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
