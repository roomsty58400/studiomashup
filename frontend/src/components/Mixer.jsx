import React, { useState, useRef, useEffect } from "react";
import MashupProgressBar from "./MashupProgressModal.jsx";
import { registerPlayer, notifyPlaying } from "../utils/mediaCoordinator.js";

// Icônes des 4 pads DJ (recul/play/pause/stop) en SVG plutôt qu'en emoji
// texte (⏪▶⏸⏹) : le rendu des emoji varie trop selon l'OS/la police (souvent
// flou, mal centré, ou en couleur fixe qui ignore le thème métal) — des
// formes vectorielles simples en "currentColor" s'intègrent proprement à
// l'icône "gravée" qui s'allume en LED (cf. .dj-pad-icon dans styles.css).
// Remplace l'ancien bouton "reculer de 5s" (double-triangle) par un retour
// au tout début des clips : icône "skip to start" classique (barre verticale
// + triangle), plus parlante pour cette action que ⏪.
const IconRestart = (props) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" {...props}>
    <rect x="4" y="5" width="2.5" height="14" rx="1" />
    <path d="M20 6 8 12l12 6z" />
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

// Cadre "🎚 RÉGLAGES AVANCÉS" (pitch/tempo fader manuel du Mixer) — masqué à
// la demande de l'utilisateur (juillet 2026), qui ne s'en sert pas en
// pratique. Repasser à true pour le réafficher tel quel, rien n'a été retiré.
const SHOW_ADVANCED_SETTINGS = false;

function formatTime(s) {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function MashupPlayer({ mashupResult, coverUrl, generatingCover, onOpenCover, onPauseDecks }) {
  const mediaRef    = useRef(null);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent]   = useState(0);
  const [duration, setDuration] = useState(0);
  const [copied, setCopied]     = useState(false);
  const [volume, setVolume]     = useState(40);
  // Menu "..." (remplace les 2 boutons séparés Télécharger/Partager, demande
  // explicite : les regrouper dans un sous-menu à l'intérieur même du cadre
  // du player, comme un menu overflow classique).
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
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

  // Ferme le menu "..." au clic ailleurs sur la page.
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  // Fenêtre POPUP dédiée — n'est plus utilisée pour LIRE la vidéo (retour
  // utilisateur : la lecture doit se faire directement dans le mini player du
  // Mixer, pas uniquement en popup), seulement pour le TÉLÉCHARGEMENT
  // (cf. handleDownload) : offre un lien <a download> propre + aperçu en
  // grand format, sans avoir à réencoder/dupliquer le fichier côté serveur.
  const openVideoPopup = () => {
    const popup = window.open(
      "",
      "macheup-mashup-video",
      "width=900,height=680,resizable=yes,scrollbars=no,status=no,menubar=no,toolbar=no"
    );
    if (!popup) {
      // Bloqué par le navigateur (bloqueur de popups) — repli minimal.
      window.alert("Le navigateur a bloqué la fenêtre pop-up. Autorise les pop-ups pour ce site pour lire/télécharger la vidéo.");
      return;
    }
    const title = (mashupResult.title || "Mashup").replace(/[<>]/g, "");
    popup.document.write(`<!DOCTYPE html>
<html><head><title>${title} — MacheUp Studio</title>
<meta charset="utf-8">
<style>
  body { margin:0; background:#0a0a0a; height:100vh; display:flex; flex-direction:column;
         align-items:center; justify-content:center; font-family:system-ui,sans-serif; gap:16px; }
  video { width:100%; max-height:78vh; background:#000; }
  a.dl { padding:12px 28px; background:#00eaff; color:#000; text-decoration:none;
         border-radius:8px; font-weight:800; letter-spacing:1px; font-size:13px; }
  h1 { color:#eee; font-size:13px; letter-spacing:1px; margin:0; text-align:center; padding:0 16px; }
</style></head>
<body>
  <h1>${title}</h1>
  <video controls autoplay src="${mediaSrc}"></video>
  <a class="dl" href="${mediaSrc}" download="${title}.mp4">⬇ TÉLÉCHARGER LA VIDÉO</a>
</body></html>`);
    popup.document.close();
  };

  // Lecture inline dans le mini player du Mixer — pour la vidéo ET l'audio,
  // via la même ref (mediaRef pointe soit sur le <video>, soit sur le
  // <audio>, jamais les deux). Avant, cliquer play sur la vidéo ouvrait
  // systématiquement la popup au lieu de lancer le petit lecteur (retour
  // utilisateur) ; la popup reste disponible via le bouton TÉLÉCHARGER.
  // Retour utilisateur récurrent : "j'ai un effet de superposition du flac
  // du Deck A sur le mashup finalisé" — en réalité pas un bug d'encodage
  // côté serveur (déjà largement audité), mais un vrai chevauchement audio
  // côté navigateur : le lecteur YouTube du Deck A (ou B, cf. Deck.jsx,
  // playerRef) continue de jouer en arrière-plan pendant que ce lecteur-ci
  // (le mashup finalisé) démarre — 2 sources audio actives en même temps,
  // qu'on entend forcément superposées. On coupe donc les 2 decks à
  // l'instant précis où la lecture du mashup final démarre (pas l'inverse :
  // les 2 decks doivent pouvoir jouer ENSEMBLE normalement pour la mise au
  // point du mix, seule la lecture du rendu final est exclusive).
  // Coordinateur global (cf. utils/mediaCoordinator.js) : dès que LE MASHUP
  // FINAL démarre, tous les autres lecteurs du site (combos, mashup
  // personnalisé) sont mis en pause — et réciproquement, si l'un d'eux
  // démarre pendant que ce player joue, il sera lui-même mis en pause via ce
  // même registre. Complète onPauseDecks (spécifique aux Decks A/B, cf.
  // commentaire plus haut), qui reste géré à part.
  useEffect(() => registerPlayer("final-mashup", () => mediaRef.current?.pause()), []);

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) { if (onPauseDecks) onPauseDecks(); notifyPlaying("final-mashup"); el.play(); setPlaying(true); }
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
    if (isVideo) { openVideoPopup(); return; } // popup dédié (lecture + lien de téléchargement), cf. plus haut
    const a = document.createElement("a");
    a.href = mediaSrc;
    a.download = `${mashupResult.title || "mashup"}.flac`;
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

  // ── [OUTIL DE DÉVELOPPEMENT UNIQUEMENT — À SUPPRIMER AVANT DÉPLOIEMENT] ──
  // Ouvre le FLAC généré dans VLC via le serveur (cf. POST /api/mashup/open-
  // external, routes/mashup.js) — sert à vérifier si un souci audio vient du
  // fichier lui-même ou seulement de la lecture dans le Mixer, en comparant
  // les deux lectures. Toujours le FLAC (pas le MP4) : c'est la piste audio
  // elle-même qui est en cause, indépendamment du montage vidéo.
  const [openingExternal, setOpeningExternal] = useState(false);
  const handleOpenExternal = async () => {
    if (openingExternal) return;
    setOpeningExternal(true);
    try {
      const res = await fetch("http://localhost:3001/api/mashup/open-external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: mashupResult.flacUrl }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Échec de l'ouverture");
    } catch (e) {
      alert("Impossible d'ouvrir dans VLC : " + e.message);
    } finally {
      setOpeningExternal(false);
    }
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
            style={{ width: "100%", display: "block", maxHeight: 120, objectFit: "cover" }}
          />
        )}

        {/* Cover art + audio mp3 — carré (aspect-ratio 1/1, comme l'image IA
            générée) plafonné en taille (maxHeight) plutôt qu'une hauteur fixe
            sur un conteneur plein largeur : avec object-fit:cover, un carré
            écrasé dans une bande large et basse ne montrait plus qu'une fine
            bande horizontale de la pochette (tronquée). Centrée et plafonnée,
            elle reste entière tout en gardant le cadre Mixer compact. */}
        {!isVideo && (
          <div style={{ position: "relative", width: "100%", maxWidth: 273, maxHeight: 273,
            aspectRatio: "1 / 1", margin: "0 auto", overflow: "hidden" }}>
            {coverUrl ? (
              <img
                src={coverUrl}
                alt="Pochette"
                onClick={() => onOpenCover && onOpenCover()}
                style={{ width: "100%", height: "100%", objectFit: "cover", cursor: "pointer", display: "block",
                  filter: playing ? "brightness(0.55)" : "brightness(0.65)", transition: "filter 0.3s" }}
              />
            ) : generatingCover ? (
              <div style={{ width: "100%", height: "100%", background: "#111",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <div style={{ width: 20, height: 20, border: "2px solid #cc00ff33",
                  borderTop: "2px solid #cc00ff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 2 }}>POCHETTE…</div>
              </div>
            ) : (
              <div style={{ width: "100%", height: "100%", background: "#111",
                display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 28, opacity: 0.2 }}>🎵</span>
              </div>
            )}

            {/* Bouton play/pause centré */}
            <button onClick={togglePlay} style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              background: "transparent", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: "50%",
                background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)",
                border: "2px solid rgba(0,234,255,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 15, color: "#00eaff",
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
              padding: "14px 8px 5px",
              fontSize: 10, color: "rgba(255,255,255,0.7)",
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

        {/* Menu "..." — Télécharger / Partager regroupés en sous-menu, à
            l'intérieur du cadre du player (demande explicite : plus de
            boutons séparés en dessous). */}
        <div ref={menuRef} style={{ position: "absolute", top: 8, right: 8, zIndex: 5 }}>
          <button onClick={() => setMenuOpen(o => !o)} style={{
            width: 26, height: 26, borderRadius: 6,
            background: "rgba(0,0,0,0.55)", border: "1px solid rgba(0,234,255,0.25)",
            color: "#00eaff", fontSize: 16, fontWeight: 900, cursor: "pointer",
            lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.15s",
          }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,234,255,0.18)"; e.currentTarget.style.borderColor = "#00eaff"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "rgba(0,0,0,0.55)"; e.currentTarget.style.borderColor = "rgba(0,234,255,0.25)"; }}
          >⋯</button>

          {menuOpen && (
            <div style={{
              position: "absolute", top: 30, right: 0, minWidth: 160,
              background: "#0d0d0d", border: "1px solid rgba(0,234,255,0.25)",
              borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.6)",
              overflow: "hidden",
            }}>
              <button onClick={() => { handleDownload(); setMenuOpen(false); }} style={{
                display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
                background: "transparent", border: "none", color: "#00eaff",
                fontSize: 12, fontWeight: 800, cursor: "pointer", letterSpacing: 0.5,
              }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(0,234,255,0.1)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >⬇ Télécharger</button>
              <button onClick={() => { handleShare(); setMenuOpen(false); }} style={{
                display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
                background: "transparent", border: "none", borderTop: "1px solid rgba(255,255,255,0.06)",
                color: copied ? "#00ff78" : "#cc00ff",
                fontSize: 12, fontWeight: 800, cursor: "pointer", letterSpacing: 0.5,
              }}
                onMouseEnter={e => { if (!copied) e.currentTarget.style.background = "rgba(204,0,255,0.1)"; }}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >{copied ? "✓ Copié !" : "⬆ Partager"}</button>
              {/* [DEV UNIQUEMENT] — à retirer avant déploiement public (cf.
                  commentaire détaillé sur la route /api/mashup/open-external,
                  routes/mashup.js). Sert uniquement à comparer la lecture du
                  FLAC brut (hors navigateur) avec celle du Mixer pour isoler
                  un éventuel bug d'encodage d'un simple souci de lecture web. */}
              {!isVideo && (
                <button onClick={() => { handleOpenExternal(); setMenuOpen(false); }} disabled={openingExternal} style={{
                  display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
                  background: "transparent", border: "none", borderTop: "1px solid rgba(255,255,255,0.06)",
                  color: openingExternal ? "#555" : "#ffaa00",
                  fontSize: 12, fontWeight: 800, cursor: openingExternal ? "default" : "pointer", letterSpacing: 0.5,
                }}
                  onMouseEnter={e => { if (!openingExternal) e.currentTarget.style.background = "rgba(255,170,0,0.1)"; }}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >{openingExternal ? "⏳ Ouverture…" : "🎬 Ouvrir dans VLC (dev)"}</button>
              )}
            </div>
          )}
        </div>
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

    </div>
  );
}

export default function Mixer({ trackA, trackB, analysisA, analysisB, onCreateMashup, onCrossfadeChange, onOpenCover,
  onSyncPlay, onSyncPause, onSyncRestart, onMasterVolumeChange, coverUrl, mashupResult, generatingCover,
  jobId, showProgress, onCloseProgress, onJobDone, onMashupError, silentProgress, power, onTogglePower,
  onOpenAssist, assistReady, onPauseDecks }) {
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

  // ── Nettoyage manuel (bouton 🧹, demande explicite utilisateur) ──────────
  // Déclenche côté serveur le même balayage que le nettoyage de fermeture
  // (services/cleanup.js) : supprime tout .mp3/.flac/.mp4 sous tmp/,
  // data/outputs/ et cache/ — mashups générés, stems Demucs dérivés, audio/
  // vidéo yt-dlp mis en cache. Confirmation demandée avant d'agir (destructif :
  // les morceaux déjà analysés perdront leurs stems et devront repasser par
  // Demucs au prochain usage — seule la ligne SQLite bpm/clé est conservée).
  // Message DJ ASSIST (bouton 🧭 DJA, cf. plus bas) — même remplacement du
  // alert() natif du navigateur ("localhost:5173 indique...", retour
  // utilisateur juillet 2026) par un petit message flottant auto-masqué.
  const [djaHint, setDjaHint] = useState(null);
  const djaHintTimerRef = useRef(null);
  const showDjaHint = (text) => {
    clearTimeout(djaHintTimerRef.current);
    setDjaHint(text);
    djaHintTimerRef.current = setTimeout(() => setDjaHint(null), 4000);
  };

  const [cleaningFiles, setCleaningFiles] = useState(false);
  // Confirmation + résultat du nettoyage — un petit panneau flottant ancré
  // sous le bouton 🧹 (cf. JSX plus bas) remplace maintenant les popups
  // natifs du navigateur (window.confirm/alert, préfixés "localhost:5173
  // indique" — jugés intrusifs, retour utilisateur juillet 2026). Le résultat
  // se referme tout seul après quelques secondes.
  const [cleanupConfirming, setCleanupConfirming] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState(null); // { text, error } | null
  const cleanupMessageTimerRef = useRef(null);
  const showCleanupMessage = (text, error = false) => {
    clearTimeout(cleanupMessageTimerRef.current);
    setCleanupMessage({ text, error });
    cleanupMessageTimerRef.current = setTimeout(() => setCleanupMessage(null), 4000);
  };
  const handleCleanupButtonClick = () => {
    if (cleaningFiles) return;
    setCleanupMessage(null);
    setCleanupConfirming(v => !v);
  };
  const cancelCleanup = () => setCleanupConfirming(false);
  const confirmCleanup = async () => {
    setCleanupConfirming(false);
    setCleaningFiles(true);
    try {
      const res = await fetch("http://localhost:3001/api/cleanup", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Échec du nettoyage");
      showCleanupMessage(`🧹 Nettoyage terminé : ${data.deleted} fichier(s) supprimé(s)${data.errors ? `, ${data.errors} échec(s)` : ""}.`);
    } catch (e) {
      showCleanupMessage("Erreur lors du nettoyage : " + e.message, true);
    } finally {
      setCleaningFiles(false);
    }
  };

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

  // ── "Pitch fader" manuel (BPM + tonalité) ──────────────────────────────
  // Demandé explicitement : un outil pour régler soi-même le décrochage de
  // tonalité et l'ajustement de tempo, façon fader de pitch DJ (CDJ/vinyle),
  // plutôt que de subir uniquement le calcul automatique (rubberband +
  // camelotAwareShift, cf. ffmpeg.js). null = "auto" (comportement serveur
  // inchangé) ; dès que l'utilisateur bouge un curseur, sa valeur EXACTE est
  // envoyée au serveur et prime sur le calcul automatique, même hors de la
  // fenêtre "sûre" — un vrai fader ne bloque jamais, il prévient juste
  // (cf. le score de compatibilité juste au-dessus).
  const [manualPitch, setManualPitch] = useState(null);   // demi-tons, null = auto
  const [manualTempo, setManualTempo] = useState(null);   // ratio (1 = pas de changement), null = auto
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);

  // Valeurs "auto" affichées tant que l'utilisateur n'a pas touché aux
  // curseurs — juste indicatives côté client (le serveur refait le calcul
  // exact de toute façon quand la valeur envoyée est null).
  const autoPitch = compat?.pitchShiftSemitones ?? 0;
  const autoRatio = analysisA?.bpm && analysisB?.bpm
    ? Math.min(2, Math.max(0.5, analysisA.bpm / analysisB.bpm))
    : 1;

  const pitchValue = manualPitch ?? autoPitch;
  const tempoValue = manualTempo ?? autoRatio;
  const hasManualOverride = manualPitch !== null || manualTempo !== null;

  const handleRegenerate = async () => {
    if (!onCreateMashup) return;
    setRegenLoading(true);
    try {
      await onCreateMashup({
        crossfade, mode: "full",
        pitchShiftOverride: manualPitch,
        tempoRatioOverride: manualTempo,
      });
    } finally {
      setRegenLoading(false);
    }
  };

  const handleResetAdvanced = () => { setManualPitch(null); setManualTempo(null); };

  const handleCrossfade = (val) => {
    setCrossfade(val);
    if (onCrossfadeChange) onCrossfadeChange(val);
  };

  return (
    <div className="mixer">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, position: "relative" }}>
        {/* DJ ASSIST — ouvre la roue de suggestions (même moteur que Mashup
            Wheel) centrée sur le Deck A, pour choisir un clip compatible
            directement injecté dans le Deck B (cf. DjAssistModal.jsx,
            MashupStudio.jsx). Placé à gauche du titre MIXER, pad d'effet
            façon table de mixage DJ (cf. .dj-assist-btn dans styles.css).
            Texte réduit à "DJA" (retour utilisateur : "DJ ASSIST" écrasait le
            titre MIXER, pas assez de place sur cette ligne).
            Reste TOUJOURS cliquable (pas de "disabled" HTML, cf. même
            correctif déjà appliqué à ComboPanel) : un clic quand le Deck A
            n'est pas encore prêt explique précisément quoi faire au lieu de
            ne rien faire silencieusement (retour utilisateur : "quand je
            clique sur DJ assist il ne se passe rien" — le bouton semblait
            juste mort au lieu d'expliquer qu'il fallait d'abord charger/
            analyser un morceau YouTube dans le Deck A). data-ready pilote
            l'aspect terne/actif en CSS à la place de :disabled. */}
        <button
          type="button"
          className="dj-assist-btn"
          data-ready={assistReady}
          onClick={() => {
            if (assistReady) { onOpenAssist && onOpenAssist(); return; }
            showDjaHint(
              !trackA ? "Charge d'abord un morceau dans le Deck A."
              : trackA.type !== "youtube" ? "DJ Assist a besoin d'un morceau YouTube dans le Deck A (pas un fichier local)."
              : "Attends la fin de l'analyse automatique du Deck A (BPM/clé) avant d'utiliser DJ Assist."
            );
          }}
        >
          🧭 DJA
        </button>
        {djaHint && (
          <div style={{
            position: "absolute", left: 0, top: "calc(100% + 6px)", zIndex: 50, width: 220,
            background: "#161616", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8,
            padding: "8px 10px", boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
            fontSize: 11, lineHeight: 1.4, color: "#ffcc66",
          }}>
            {djaHint}
          </div>
        )}
        <div className="mixer-title">MIXER</div>
        {/* Nettoyage manuel (bouton 🧹) — supprime TOUS les fichiers .mp3/
            .flac/.mp4/.wav temporaires/générés (tmp/, data/outputs/, cache/)
            côté serveur, pas seulement ceux du macheup en cours. Séparé de
            l'interrupteur ON/OFF juste à droite : celui-ci n'efface QUE le
            macheup affiché (+ les .wav orphelins de tmp/), ce bouton fait le
            grand nettoyage complet — à utiliser entre 2 créations pour
            repartir sur une base saine. Confirmation demandée (destructif :
            les stems/instrus déjà séparés pour des morceaux précédemment
            analysés devront être reséparés par Demucs au prochain usage). */}
        <button
          type="button"
          onClick={handleCleanupButtonClick}
          disabled={cleaningFiles}
          title="Nettoyer tous les fichiers temporaires générés (FLAC/MP3/MP4/WAV) — force une re-séparation Demucs au prochain usage des morceaux concernés"
          style={{
            position: "absolute", right: 74, top: "50%", transform: "translateY(-50%)",
            width: 26, height: 26, borderRadius: 6,
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)",
            color: cleaningFiles ? "#444" : "#aaa", fontSize: 13, cursor: cleaningFiles ? "default" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.15s",
          }}
          onMouseEnter={e => { if (!cleaningFiles) { e.currentTarget.style.background = "rgba(0,234,255,0.1)"; e.currentTarget.style.borderColor = "rgba(0,234,255,0.3)"; } }}
          onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"; }}
        >{cleaningFiles ? "…" : "🧹"}</button>
        {/* Panneau flottant confirmation/résultat (remplace window.confirm +
            alert natifs) — ancré sous le bouton 🧹 ci-dessus, dans le même
            contexte de positionnement (cf. commentaire sur le bouton). */}
        {(cleanupConfirming || cleanupMessage) && (
          <div style={{
            position: "absolute", right: 74, top: "calc(50% + 22px)", zIndex: 50, width: 230,
            background: "#161616", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8,
            padding: "10px 12px", boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
          }}>
            {cleanupConfirming ? (
              <>
                <div style={{ fontSize: 11, color: "#ccc", lineHeight: 1.4, marginBottom: 8 }}>
                  Nettoyer TOUS les fichiers temporaires/générés (FLAC/MP3/MP4/WAV) ? Les morceaux déjà
                  analysés devront être reséparés par Demucs au prochain usage (plus lent une fois).
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button onClick={cancelCleanup} style={{
                    padding: "4px 10px", borderRadius: 6, background: "transparent",
                    border: "1px solid rgba(255,255,255,0.15)", color: "#aaa", fontSize: 11, cursor: "pointer",
                  }}>Annuler</button>
                  <button onClick={confirmCleanup} style={{
                    padding: "4px 10px", borderRadius: 6, background: "rgba(255,80,80,0.15)",
                    border: "1px solid rgba(255,80,80,0.4)", color: "#ff8080", fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}>🧹 Nettoyer</button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, lineHeight: 1.4, color: cleanupMessage.error ? "#ff8080" : "#aaffaa" }}>
                {cleanupMessage.text}
              </div>
            )}
          </div>
        )}
        {/* Interrupteur ON/OFF des Decks A/B — ON : decks actifs normalement.
            OFF : les 2 decks sont coupés/désactivés et tout ce qui a été
            généré temporairement (FLAC/MP3/MP4 du macheup en cours, durées,
            pochette) est effacé, + balayage des .wav orphelins de tmp/ (cf.
            routes/mashup.js, POST /cleanup). Placé à droite du titre MIXER. */}
        <button
          type="button"
          onClick={() => onTogglePower && onTogglePower(!power)}
          title={power ? "Éteindre les Decks A/B (efface aussi les fichiers temporaires générés, dont les .wav)" : "Activer les Decks A/B"}
          style={{
            position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
            display: "flex", alignItems: "center", gap: 6,
            padding: "3px 4px", borderRadius: 20, cursor: "pointer",
            border: `1px solid ${power ? "rgba(170,255,0,0.4)" : "rgba(255,80,80,0.35)"}`,
            background: power ? "rgba(170,255,0,0.08)" : "rgba(255,80,80,0.08)",
            transition: "background 0.2s, border-color 0.2s",
          }}>
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: 1,
            color: power ? "var(--green)" : "#ff8080",
            paddingLeft: 6,
          }}>{power ? "ON" : "OFF"}</span>
          <span style={{
            position: "relative", width: 28, height: 16, borderRadius: 10,
            background: power ? "rgba(170,255,0,0.25)" : "rgba(255,80,80,0.2)",
            transition: "background 0.2s",
          }}>
            <span style={{
              position: "absolute", top: 1, left: power ? 13 : 1,
              width: 14, height: 14, borderRadius: "50%",
              background: power ? "var(--green)" : "#ff8080",
              boxShadow: power ? "0 0 6px rgba(170,255,0,0.6)" : "0 0 6px rgba(255,80,80,0.6)",
              transition: "left 0.2s ease",
            }} />
          </span>
        </button>
      </div>

      <div className="mixer-controls">
        <button className="dj-pad dj-pad--rewind" title="Retour au départ des 2 clips (0:00, sans couper la lecture)"
          onClick={() => { if (onSyncRestart) onSyncRestart(); }}>
          <IconRestart className="dj-pad-icon" />
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
        {/* Rainure façon fader de table de mixage : remplissage néon jusqu'à
            la valeur courante + repères verticaux, même principe que le
            fader vertical des Decks (.vol-track-fill/.vol-ticks) mais à
            l'horizontale — retour utilisateur : rendre l'aspect "platine DJ
            pro" plutôt qu'une simple barre <input> nue. */}
        <div className="master-vol-track-wrap">
          <div className="master-vol-track-fill" style={{ width: `${masterVolume}%` }} />
          <div className="master-vol-ticks">
            {[0, 1, 2, 3, 4].map(i => <span key={i} />)}
          </div>
          <input type="range" className="master-vol-slider"
            min="0" max="100" step="1" value={masterVolume}
            onChange={handleMasterVolumeChange} />
        </div>
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
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted2)" }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    <span title="BPM" style={{ whiteSpace: "nowrap" }}>⏱ BPM {compat.subscores.bpm}</span>
                    <span title="Clé" style={{ whiteSpace: "nowrap" }}>🎹 Clé {compat.subscores.key}</span>
                    <span title="Énergie" style={{ whiteSpace: "nowrap" }}>🔥 Énerg. {compat.subscores.energy}</span>
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <span title="Structure" style={{ whiteSpace: "nowrap" }}>📐 Struct. {compat.subscores.structure}</span>
                    <span title="Spectral" style={{ whiteSpace: "nowrap" }}>🌈 Spectr. {compat.subscores.spectral}</span>
                  </div>
                </div>
              )}
              {compat.invalidReason && (
                <div style={{ color: "#ff8080", fontSize: 11, marginTop: 6 }}>{compat.invalidReason}</div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* ── Réglages avancés : "pitch fader" manuel BPM + tonalité ──────────
          Demandé explicitement — un vrai contrôle façon fader DJ (CDJ/vinyle)
          plutôt qu'un simple message bloquant. Visible dès que les 2 decks
          sont analysés ; repliable pour ne pas encombrer l'UI par défaut.
          MASQUÉ (retour utilisateur, juillet 2026) : cadre inutilisé en
          pratique — repasser SHOW_ADVANCED_SETTINGS à true pour le
          réafficher, tout le code/état (manualPitch, manualTempo, etc.) est
          conservé tel quel, rien n'a été supprimé. */}
      {SHOW_ADVANCED_SETTINGS && analysisA && analysisB && (
        <div style={{
          background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10,
          padding: "10px 12px", fontSize: 12, marginTop: 8,
        }}>
          <div
            onClick={() => setShowAdvanced(v => !v)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
          >
            <span style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 1, color: "var(--muted2)", fontSize: 11 }}>
              🎚 RÉGLAGES AVANCÉS {hasManualOverride && <span style={{ color: "#ffaa00" }}>· manuel</span>}
            </span>
            <span style={{ color: "var(--muted2)", fontSize: 11 }}>{showAdvanced ? "▲" : "▼"}</span>
          </div>

          {showAdvanced && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Tonalité (demi-tons) */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted2)", marginBottom: 3 }}>
                  <span>Décrochage tonalité (voix)</span>
                  <span>{pitchValue > 0 ? "+" : ""}{pitchValue.toFixed(0)} demi-ton(s){manualPitch === null ? " (auto)" : ""}</span>
                </div>
                <input type="range" min="-6" max="6" step="1" value={pitchValue}
                  onChange={e => setManualPitch(Number(e.target.value))}
                  style={{ width: "100%" }} />
              </div>

              {/* Tempo (ratio, comme un fader de pitch DJ en %) */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted2)", marginBottom: 3 }}>
                  <span>Ajustement tempo (instru → voix)</span>
                  <span>{tempoValue >= 1 ? "+" : ""}{Math.round((tempoValue - 1) * 100)}%{manualTempo === null ? " (auto)" : ""}</span>
                </div>
                <input type="range" min="0.5" max="2" step="0.01" value={tempoValue}
                  onChange={e => setManualTempo(Number(e.target.value))}
                  style={{ width: "100%" }} />
              </div>

              <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                <button onClick={handleRegenerate} disabled={regenLoading} style={{
                  flex: 1, padding: "7px 0", borderRadius: 7,
                  background: "rgba(0,234,255,0.1)", border: "1px solid rgba(0,234,255,0.25)",
                  color: "#00eaff", fontSize: 11, fontWeight: 800, cursor: regenLoading ? "default" : "pointer",
                  letterSpacing: 0.5, opacity: regenLoading ? 0.6 : 1,
                }}>{regenLoading ? "RÉGÉNÉRATION…" : "🔄 RÉGÉNÉRER AVEC CES RÉGLAGES"}</button>
                {hasManualOverride && (
                  <button onClick={handleResetAdvanced} style={{
                    padding: "7px 12px", borderRadius: 7,
                    background: "transparent", border: "1px solid var(--border)",
                    color: "var(--muted2)", fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}>↺ Auto</button>
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--muted2)", lineHeight: 1.4 }}>
                Ces réglages forcent la valeur choisie, même au-delà de ce que le
                score de compatibilité recommande — utile si tu préfères juger
                toi-même du résultat plutôt que de suivre l'avertissement
                automatique.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Titre choisi automatiquement par l'IA (cf. MashupStudio.jsx) — plus
          de champ ni de bouton ici, gain de temps total. FLAC + MP4 sont
          eux aussi toujours générés ensemble, plus de choix de format.
          Dès le clic, le bouton disparaît et le cadre "création en cours"
          prend sa place — au lieu de rester affiché côte à côte avec lui. */}
      {/* Le macheup se lance désormais tout seul dès que les 2 clips sont
          validés dans les barres de recherche des decks (cf. useEffect dans
          MashupStudio.jsx) — plus besoin du bouton "✦ CREATE MACHEUP", on
          n'affiche plus que la barre de progression une fois lancé. */}
      {/* silentProgress : relance automatique après un échec (cf. handleMashupError
          dans MashupStudio.jsx) — la création tourne et est suivie comme d'habitude,
          mais on ne montre rien à l'utilisateur tant que ce n'est pas terminé. */}
      {/* Pochette générée par l'IA automatiquement à la fin du Create Macheup
          (cf. handleJobDone dans MashupStudio.jsx, POST /api/cover) — plus
          besoin d'un bouton dédié, elle s'affiche ici dès qu'elle est prête.
          La génération de la pochette démarre en réalité dès la sélection
          des 2 clips (avant même le clic sur Create Macheup), donc elle est
          souvent déjà prête (ou en cours) PENDANT que le mashup lui-même se
          génère (showProgress) — la roue de progression se pose alors EN
          CALQUE TRANSPARENT par-dessus ce même cadre plutôt que dans un bloc
          séparé au-dessus (retour utilisateur). */}
      {mashupResult ? (
        <MashupPlayer
          mashupResult={mashupResult}
          coverUrl={coverUrl}
          generatingCover={generatingCover}
          onOpenCover={onOpenCover}
          onPauseDecks={onPauseDecks}
        />
      ) : (coverUrl || generatingCover || (showProgress && !silentProgress)) ? (
        // Carré plafonné en taille (au lieu d'une hauteur fixe sur un
        // conteneur plein largeur, qui tronquait la pochette IA carrée).
        <div style={{ marginTop: 12 }}>
          <div
            onClick={() => coverUrl && onOpenCover && onOpenCover()}
            style={{ position: "relative", width: "100%", maxWidth: 273, maxHeight: 273,
              aspectRatio: "1 / 1", margin: "0 auto", borderRadius: 8, overflow: "hidden",
              border: "1px solid rgba(204,0,255,0.25)",
              boxShadow: "0 0 20px rgba(204,0,255,0.12)",
              background: "#0a0a0a",
              cursor: coverUrl ? "pointer" : "default",
              transition: "box-shadow 0.2s" }}
            onMouseEnter={e => { if (coverUrl) e.currentTarget.style.boxShadow = "0 0 30px rgba(204,0,255,0.4)"; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = "0 0 20px rgba(204,0,255,0.12)"; }}
          >
            {coverUrl ? (
              <img src={coverUrl} alt="Pochette" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : generatingCover ? (
              <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 8 }}>
                <div style={{ width: 20, height: 20, border: "2px solid #cc00ff33",
                  borderTop: "2px solid #cc00ff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 2 }}>GÉNÉRATION…</div>
              </div>
            ) : (
              // Ni pochette ni génération en cours (rare : cover pas encore
              // lancée) — fond neutre pour que la roue ait quand même un
              // calque à superposer.
              <div style={{ width: "100%", height: "100%", display: "flex",
                alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 28, opacity: 0.15 }}>🎵</span>
              </div>
            )}

            {/* Roue de progression du MASHUP (audio+vidéo), en calque
                transparent par-dessus la pochette ci-dessus — cf. commentaire
                plus haut. Indépendante de generatingCover (pochette IA) qui
                garde son propre petit spinner discret quand la roue n'est
                pas affichée. */}
            {showProgress && !silentProgress && (
              <MashupProgressBar
                jobId={jobId}
                onClose={onCloseProgress}
                onDone={onJobDone}
                onError={onMashupError}
                overlay
              />
            )}
          </div>
        </div>
      ) : null}

      {/* Le player vidéo du mashup personnalisé vit désormais dans ComboPanel
          (cadre "Sélect ton combo"), superposé au triangle jaune une fois
          généré — cf. ComboPanel.jsx. Retiré d'ici (retour utilisateur). */}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
