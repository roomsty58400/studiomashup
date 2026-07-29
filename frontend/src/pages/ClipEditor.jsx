import React, { useState, useRef, useEffect } from "react";
import Footer from "../components/Footer.jsx";
import LyricsModal from "../components/LyricsModal.jsx";
import PromptSunoModal from "../components/PromptSunoModal.jsx";
import { copyToClipboard } from "../utils/clipboard.js";
import { prefetchMedia } from "../utils/mediaCache.js";

const API = "http://localhost:3001";

// ── Route B : presets de styles cibles pour le remix audio-to-audio ──
const STYLE_PRESETS = [
  "Cyberpunk synthwave",
  "Lo-fi acoustique chill",
  "Orchestral épique",
  "Phonk drift",
  "Reggaeton festif",
  "Metal symphonique",
  "Jazz lounge feutré",
  "8-bit chiptune",
];

// La séparation voix/instru (Demucs) n'est plus une étape bloquante de
// l'extraction — elle se lance à la demande (voir handleSeparate), donc ces
// 4 étapes ne couvrent plus que le téléchargement + export audio, rapide.
const STEPS = [
  { id: "download", label: "Téléchargement audio", icon: "⬇" },
  { id: "extract",  label: "Extraction audio",      icon: "🎧" },
  { id: "export",   label: "Export piste complète", icon: "💾" },
  { id: "done",     label: "Terminé",               icon: "✅" },
];

// ── Étape ③ : quel fichier l'utilisateur a-t-il transformé avec son IA ? ──
// Détermine comment le backend recompose le clip final (cf. /:id/recompose) :
// "full" remplace toute la bande son, "vocals"/"instrumental" recombinent le
// fichier uploadé avec le STEM ORIGINAL complémentaire (voice swap / remix de
// style "pur", sans toucher à l'autre stem).
const RECOMPOSE_SOURCES = [
  { id: "full", icon: "🎵", label: "Piste mp3 originale", desc: "Ton fichier remplace toute la bande son" },
  { id: "vocals", icon: "🎤", label: "Voix seule", desc: "Ton fichier = nouvelle voix, recombinée avec l'instrumental d'origine" },
  { id: "instrumental", icon: "🎹", label: "Instrumental seul", desc: "Ton fichier = nouvel instrumental, recombiné avec la voix d'origine" },
];

// ── Noms de fichiers téléchargés à l'étape ② : on ajoute un libellé pour
// dissocier facilement les 3 pistes une fois sur le disque de l'utilisateur.
const sanitizeFilename = (s) => (s || "clip").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "clip";
const extFromUrl = (u, fallback = "mp3") => u?.split(".").pop() || fallback;

function formatDuration(sec) {
  if (sec == null) return null;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Barre de recherche YouTube (même API que les Decks du Mixer) ──
function VideoSearch({ onSelect }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [searchError, setSearchError] = useState(null);
  // Cf. Deck.jsx — même filtre "Officiels uniquement", même comportement
  // (désactivé par défaut, filtrage client instantané).
  const [officialOnly, setOfficialOnly] = useState(false);
  const timeoutRef = useRef(null);
  const abortRef = useRef(null);

  const search = async (q) => {
    if (!q || q.length < 2) { setResults([]); setShowResults(false); setSearchError(null); return; }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`${API}/api/youtube/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (Array.isArray(data)) {
        setResults(data); setShowResults(true);
      } else {
        // Le backend renvoie {error: "..."} (quota dépassé, clé manquante,
        // timeout...) plutôt qu'un tableau vide silencieux.
        setResults([]); setSearchError(data?.error || "Recherche YouTube indisponible."); setShowResults(true);
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error(e);
        setResults([]); setSearchError("Connexion au serveur perdue : " + e.message); setShowResults(true);
      }
    }
    if (!controller.signal.aborted) setSearching(false);
  };

  const handleChange = (e) => {
    const q = e.target.value; setQuery(q);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => search(q), 500);
  };

  const handlePick = (v) => {
    abortRef.current?.abort();
    clearTimeout(timeoutRef.current);
    setQuery(v.title); setShowResults(false); setResults([]);
    onSelect(v);
  };

  // Cf. Deck.jsx — résultats affichés, filtrés sur ✓ OFFICIEL si activé.
  const visibleResults = officialOnly ? results.filter(v => v.isOfficial) : results;

  return (
    <div style={{ position: "relative" }}>
      <div className="search-row">
        <input
          type="text"
          placeholder="Colle un titre, un artiste, ou cherche le clip à transformer…"
          value={query}
          onChange={handleChange}
          onFocus={() => results.length > 0 && setShowResults(true)}
          style={{ flex: 1, padding: "12px 14px", background: "rgba(255,255,255,0.04)",
            border: "1px solid var(--border)", borderRadius: 8, color: "white", fontSize: 14 }}
        />
      </div>

      {showResults && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#0f0f0f",
          border: "1px solid rgba(0,234,255,0.2)", borderRadius: 8, zIndex: 50, maxHeight: 360,
          overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.8)" }}>
          {!searching && !searchError && results.length > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px",
              borderBottom: "1px solid #1a1a1a", fontSize: 11, fontWeight: 700, color: officialOnly ? "var(--green)" : "#888",
              cursor: "pointer", userSelect: "none", position: "sticky", top: 0, background: "#0f0f0f", zIndex: 1 }}>
              <input type="checkbox" checked={officialOnly} onChange={e => setOfficialOnly(e.target.checked)}
                style={{ accentColor: "var(--green)", cursor: "pointer" }} />
              ✓ Officiels uniquement <span style={{ opacity: 0.6, fontWeight: 400 }}>(meilleure source audio pour la séparation)</span>
            </label>
          )}
          {searching && <div style={{ padding: "12px 14px", color: "#555", fontSize: 13 }}>Recherche…</div>}
          {!searching && searchError && (
            <div style={{ padding: "12px 14px", color: "#ff6666", fontSize: 13 }}>⚠ {searchError}</div>
          )}
          {!searching && !searchError && results.length === 0 && query.length >= 2 && (
            <div style={{ padding: "12px 14px", color: "#555", fontSize: 13 }}>Aucun résultat.</div>
          )}
          {!searching && !searchError && results.length > 0 && visibleResults.length === 0 && (
            <div style={{ padding: "12px 14px", color: "#555", fontSize: 13 }}>Aucun clip officiel trouvé — désactive le filtre pour voir les autres résultats.</div>
          )}
          {visibleResults.map(v => (
            <div key={v.videoId} onClick={() => { if (!v.unavailable) handlePick(v); }}
              title={v.unavailable ? v.unavailableReason : undefined}
              style={{ display: "flex", gap: 10, padding: "8px 12px", cursor: v.unavailable ? "not-allowed" : "pointer",
                borderBottom: "1px solid #111", opacity: v.unavailable ? 0.45 : 1 }}
              onMouseEnter={e => { if (!v.unavailable) e.currentTarget.style.background = "#1a1a1a"; }}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <img src={v.thumbnail} alt="" style={{ width: 64, height: 48, objectFit: "cover", borderRadius: 4 }} />
                {v.durationSec != null && (
                  <span style={{ position: "absolute", bottom: 2, right: 2, background: "rgba(0,0,0,0.85)", color: "#fff",
                    fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 3 }}>{formatDuration(v.durationSec)}</span>
                )}
              </div>
              <div style={{ overflow: "hidden", flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "white" }}>{v.title}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                  <span style={{ fontSize: 12, color: "var(--cyan)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.channel}</span>
                  {v.isOfficial && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: "var(--green)", border: "1px solid rgba(170,255,0,0.4)",
                      borderRadius: 3, padding: "0 4px", flexShrink: 0 }}>✓ OFFICIEL</span>
                  )}
                </div>
                {v.unavailable && (
                  <div style={{ fontSize: 10, color: "#ff6666", marginTop: 2 }}>⛔ {v.unavailableReason}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Barre de progression de l'extraction (même esprit que MashupProgressModal) ──
function ExtractProgress({ job }) {
  const isDone = job.status === "done";
  const isError = job.status === "error";
  const step = Math.min(job.step ?? 0, STEPS.length - 1);
  const pct = isDone ? 100 : Math.round((step / STEPS.length) * 100);

  return (
    <div style={{ background: "#0c0c0c", border: `1px solid ${isError ? "#ff444433" : isDone ? "#00eaff33" : "#1e1e1e"}`,
      borderRadius: 12, padding: "16px 18px", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        {!isDone && !isError && (
          <div style={{ width: 16, height: 16, border: "2px solid #00eaff33", borderTop: "2px solid #00eaff",
            borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
        )}
        {isDone && <span style={{ fontSize: 17 }}>✅</span>}
        {isError && <span style={{ fontSize: 17 }}>❌</span>}
        <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 13, fontWeight: 900, letterSpacing: 2,
          color: isDone ? "#00eaff" : isError ? "#ff4444" : "#fff" }}>
          {isDone ? "EXTRACTION PRÊTE" : isError ? "ERREUR" : "EXTRACTION EN COURS…"}
        </div>
        {!isDone && !isError && (
          <div style={{ fontSize: 12, color: "#666" }}>{STEPS[step]?.icon} {job.label || STEPS[step]?.label}</div>
        )}
      </div>

      <div style={{ height: 4, background: "#1a1a1a", borderRadius: 2, overflow: "hidden", marginBottom: 10 }}>
        <div style={{ height: "100%", borderRadius: 2, width: pct + "%",
          background: isError ? "#ff4444" : "linear-gradient(90deg,#00eaff,#cc00ff)", transition: "width 0.6s ease" }} />
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {STEPS.map((s, i) => {
          const done = isDone || i < step;
          const active = !isDone && !isError && i === step;
          return (
            <div key={s.id} style={{ flex: 1, textAlign: "center", padding: "5px 4px", borderRadius: 6,
              background: active ? "rgba(0,234,255,0.08)" : done ? "rgba(0,234,255,0.04)" : "#111",
              border: `1px solid ${active ? "#00eaff44" : done ? "#00eaff22" : "#1a1a1a"}` }}>
              <div style={{ fontSize: 14 }}>{done ? "✓" : s.icon}</div>
              <div style={{ fontSize: 10, color: done ? "#00eaff" : active ? "white" : "#444", marginTop: 2 }}>{s.label}</div>
            </div>
          );
        })}
      </div>

      {isError && (
        <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(255,68,68,0.08)",
          border: "1px solid #ff444433", borderRadius: 6, color: "#ff6666", fontSize: 13 }}>
          {job.message}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Carte d'un stem (voix / instru / piste complète) ──
// La séparation Demucs démarre automatiquement et en tâche de fond dès que
// l'extraction est prête (cf. handleSeparate / backend) : tant qu'elle
// tourne, la carte affiche juste un indicateur discret (pas d'action requise
// de l'utilisateur). Un bouton n'apparaît qu'en cas d'erreur, pour réessayer.
// Bouton "⬇ Télécharger" retiré (demande explicite, juillet 2026 : ne sert
// plus dans le workflow réel de l'utilisateur) — ne reste qu'un indicateur
// "prêt" une fois la piste disponible ; downloadName/url conservés en props
// pour ne pas casser les appelants, mais ne servent plus qu'en interne.
function StemCard({ icon, label, hint, pending, pendingLabel, showRetry, onAction }) {
  return (
    <div style={{ flex: 1, minWidth: 160, background: "var(--surface2)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flex: 1 }}>
        <div style={{ fontSize: 22, flexShrink: 0 }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "white" }}>{label}</div>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 2 }}>{hint}</div>
        </div>
      </div>
      {pending ? (
        showRetry ? (
          <button className="secondary-btn" style={{ width: "100%" }} onClick={onAction}>
            {pendingLabel}
          </button>
        ) : (
          <div className="stem-progress">
            <div className="stem-progress-fill" />
            <span className="stem-progress-label">{pendingLabel}</span>
          </div>
        )
      ) : (
        <div style={{ textAlign: "center", padding: "7px 0", borderRadius: 6,
          background: "rgba(0,234,255,0.06)", border: "1px solid rgba(0,234,255,0.2)",
          color: "var(--cyan)", fontSize: 12, fontWeight: 700 }}>
          ✅ Prêt
        </div>
      )}
    </div>
  );
}

// ── Petit compte à rebours affiché à côté du titre de l'étape ②, pendant que
// Demucs sépare voix/instru en tâche de fond — purement indicatif (le temps
// réel dépend de la machine), juste pour donner un retour visuel d'attente.
// Se réinitialise chaque fois qu'il (re)devient actif (1er lancement ou retry).
function SeparationCountdown({ active, estimateSeconds = 120 }) {
  const [secondsLeft, setSecondsLeft] = useState(estimateSeconds);

  useEffect(() => {
    if (!active) { setSecondsLeft(estimateSeconds); return; }
    setSecondsLeft(estimateSeconds);
    const id = setInterval(() => {
      setSecondsLeft(s => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [active, estimateSeconds]);

  if (!active) return null;

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "Orbitron,sans-serif",
      fontSize: 14, fontWeight: 800, letterSpacing: 1, color: "var(--magenta)",
      background: "rgba(204,0,255,0.1)", border: "1px solid rgba(204,0,255,0.3)",
      borderRadius: 20, padding: "4px 13px", flexShrink: 0, whiteSpace: "nowrap" }}>
      ⏳ {secondsLeft > 0 ? `${mm}:${ss}` : "presque…"}
    </div>
  );
}

// ── Route B : panneau "changer le style" (remix audio-to-audio Suno/Udio) ──
// maxHeight (optionnel) cale la hauteur du cadre sur celle du lecteur vidéo
// de l'étape ① — le contenu devient scrollable si jamais ça dépasse.
function RemixPanel({ video, maxHeight }) {
  const [targetStyle, setTargetStyle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (!targetStyle.trim()) return;
    setLoading(true); setError(null); setPrompt("");
    try {
      const res = await fetch(`${API}/api/prompt/remix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: video.title, channel: video.channel, targetStyle }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.prompt) throw new Error("Réponse vide du serveur");
      setPrompt(data.prompt);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14,
      ...(maxHeight ? { maxHeight, overflowY: "auto" } : {}) }}>

      {/* Cadre 1 : configuration / génération du prompt */}
      <div style={{ background: "var(--surface2)", border: "1px solid rgba(204,0,255,0.25)",
        borderRadius: 12, padding: 16, flexShrink: 0 }}>
        <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 12, fontWeight: 900, letterSpacing: 2,
          color: "var(--magenta)", marginBottom: 4 }}>🎛 ROUTE B — REMIX DE STYLE</div>
        <div style={{ fontSize: 12, color: "var(--muted2)", lineHeight: 1.6, marginBottom: 12 }}>
          Décris le nouveau style musical voulu, génère un prompt optimisé Suno/Udio, puis va dans{" "}
          <strong style={{ color: "#ccc" }}>Suno → Upload Audio</strong> ou{" "}
          <strong style={{ color: "#ccc" }}>Udio → Audio Prompt</strong> : uploade la piste téléchargée ci-dessus
          (instrumentale ou complète) comme référence, et colle ce prompt comme style.
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {STYLE_PRESETS.map(p => (
            <button key={p} onClick={() => setTargetStyle(p)}
              style={{ padding: "5px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                border: `1px solid ${targetStyle === p ? "var(--magenta)" : "rgba(255,255,255,0.12)"}`,
                background: targetStyle === p ? "rgba(204,0,255,0.18)" : "transparent",
                color: targetStyle === p ? "var(--magenta)" : "#999", cursor: "pointer", transition: "0.2s" }}>
              {p}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            placeholder="Ou décris ton propre style cible…"
            value={targetStyle}
            onChange={e => setTargetStyle(e.target.value)}
            style={{ flex: 1, padding: "10px 12px", background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border)", borderRadius: 8, color: "white", fontSize: 13 }}
          />
          <button className="secondary-btn" style={{ width: "auto", padding: "0 18px" }}
            disabled={!targetStyle.trim() || loading} onClick={generate}>
            {loading ? "…" : "✦ Générer"}
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(255,68,68,0.08)",
            border: "1px solid #ff444433", borderRadius: 6, color: "#ff6666", fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>

      {/* Cadre 2 : résultat — n'apparaît qu'une fois un prompt généré */}
      {prompt && (
        <div style={{ background: "var(--surface2)", border: "1px solid rgba(204,0,255,0.25)",
          borderRadius: 12, padding: 16, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 12, fontWeight: 900, letterSpacing: 2,
            color: "var(--magenta)", marginBottom: 10 }}>✦ PROMPT GÉNÉRÉ</div>
          <pre style={{ background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 8,
            padding: 14, fontSize: 13, lineHeight: 1.7, color: "#ccc", whiteSpace: "pre-wrap",
            fontFamily: "Inter,sans-serif", maxHeight: 280, overflowY: "auto", margin: 0 }}>
            {prompt}
          </pre>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={handleCopy}
              style={{ flex: 1, padding: "9px 14px", borderRadius: 8, border: "1px solid var(--magenta)",
                background: copied ? "var(--magenta)" : "transparent", color: copied ? "#000" : "var(--magenta)",
                fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" }}>
              {copied ? "✓ COPIÉ !" : "📋 COPIER LE PROMPT"}
            </button>
            <a href="https://suno.com" target="_blank" rel="noreferrer"
              style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #333", background: "transparent",
                color: "#999", fontSize: 13, fontWeight: 700, textDecoration: "none", display: "flex",
                alignItems: "center", gap: 6 }}>
              🎵 SUNO ↗
            </a>
            <a href="https://udio.com" target="_blank" rel="noreferrer"
              style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #333", background: "transparent",
                color: "#999", fontSize: 13, fontWeight: 700, textDecoration: "none", display: "flex",
                alignItems: "center", gap: 6 }}>
              🎵 UDIO ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ClipEditor() {
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [newAudio, setNewAudio] = useState(null);
  const [recomposeSource, setRecomposeSource] = useState("full");
  const [linkCopied, setLinkCopied] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showSuno, setShowSuno] = useState(false);
  const [recomposing, setRecomposing] = useState(false);
  const [recomposeError, setRecomposeError] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [clipVolume, setClipVolume] = useState(80);

  // Aligne le BAS du cadre "Route B" sur le bas du lecteur vidéo de l'étape ①
  // (pas juste sa hauteur propre : on mesure la position réelle des deux
  // éléments, puisque le cadre Route B démarre plus bas que la vidéo).
  const videoRef = useRef(null);
  const remixWrapRef = useRef(null);
  const [remixMaxHeight, setRemixMaxHeight] = useState(null);

  // Volume du visualiseur vidéo de l'étape ① (l'aperçu .mp4 téléchargé en
  // tâche de fond, affiché une fois l'extraction terminée) — slider custom
  // à droite, en plus des contrôles natifs du <video>.
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = clipVolume / 100;
  }, [job?.video]);

  const handleClipVolumeChange = (e) => {
    const v = parseFloat(e.target.value);
    setClipVolume(v);
    if (videoRef.current) videoRef.current.volume = v / 100;
  };

  useEffect(() => {
    const recalc = () => {
      const videoEl = videoRef.current;
      const remixEl = remixWrapRef.current;
      if (!videoEl || !remixEl) { setRemixMaxHeight(null); return; }
      const videoBottom = videoEl.getBoundingClientRect().bottom;
      const remixTop = remixEl.getBoundingClientRect().top;
      const h = videoBottom - remixTop;
      setRemixMaxHeight(h > 80 ? h : 80);
    };

    recalc();
    const ro = new ResizeObserver(recalc);
    if (videoRef.current) ro.observe(videoRef.current);
    if (remixWrapRef.current) ro.observe(remixWrapRef.current);
    window.addEventListener("resize", recalc);
    return () => { ro.disconnect(); window.removeEventListener("resize", recalc); };
  }, [job?.video, job?.stemsStatus, job?.vocals, job?.instrumental]);

  // Polling du job — en boucle tant qu'il reste quelque chose en cours
  // (extraction audio, séparation Demucs à la demande, ou préparation vidéo
  // qui se termine en tâche de fond après le passage à "done" : téléchargement
  // PUIS génération de la version sans bande son, nécessaire à l'étape ③).
  const pollingRef = useRef(false);
  // ── Compteur de génération (même correctif que MashupWheel.jsx/
  // DjAssistModal.jsx/Deck.jsx, juillet 2026) — pollingRef empêchait seulement
  // de LANCER un 2e polling en parallèle, pas d'arrêter une boucle déjà en vol
  // quand l'utilisateur choisit un NOUVEAU clip pendant qu'une extraction
  // précédente tourne encore côté serveur : l'ancienne boucle tick() (fermée
  // sur l'ancien jobId) continuait d'écraser `job` avec des données périmées.
  const generationRef = useRef(0);
  const pollJob = (id, gen) => {
    if (pollingRef.current) return; // une boucle de poll tourne déjà pour ce job
    pollingRef.current = true;

    const tick = async () => {
      if (gen !== generationRef.current) { pollingRef.current = false; return; }
      try {
        const res = await fetch(`${API}/api/clip-editor/${id}/status`);
        const data = await res.json();
        if (gen !== generationRef.current) { pollingRef.current = false; return; }

        // Le job a disparu côté serveur (ex: redémarrage du backend — les
        // jobs sont en mémoire, pas persistés) : avant, ça arrêtait le poll
        // SANS RIEN DIRE, et l'UI restait bloquée sur "en cours" pour
        // toujours. On l'affiche maintenant clairement pour éviter l'effet
        // "rien ne se passe".
        if (!res.ok) {
          setJob({ status: "error", message: data.error || "Job introuvable — relance l'extraction." });
          pollingRef.current = false;
          return;
        }

        setJob(data);
        const stillGoing =
          data.status === "running" ||
          data.stemsStatus === "running" ||
          data.dereverbStatus === "running" ||
          (data.status === "done" && !data.videoSilent && !data.videoError);
        if (stillGoing) setTimeout(tick, 1500);
        else pollingRef.current = false;
      } catch (e) {
        if (gen !== generationRef.current) { pollingRef.current = false; return; }
        setJob({ status: "error", message: "Connexion au serveur perdue : " + e.message });
        pollingRef.current = false;
      }
    };
    tick();
  };

  useEffect(() => {
    generationRef.current++; // invalide tout polling en vol pour l'ancien job
    pollingRef.current = false;
    if (jobId) pollJob(jobId, generationRef.current);
  }, [jobId]);

  const handleSelectVideo = (v) => {
    setSelectedVideo(v);
    setJobId(null); setJob(null);
    setNewAudio(null); setFinalResult(null); setRecomposeError(null);
    setRecomposeSource("full");
    setLinkCopied(false);
    setShowLyrics(false);
    setShowSuno(false);
  };

  // Préchargement silencieux des Lyrics + Prompt Suno dès qu'un clip est
  // choisi (même cache partagé que les Decks A/B) : l'ouverture des modals
  // ci-dessous est alors instantanée plutôt que d'attendre l'appel réseau.
  useEffect(() => {
    if (selectedVideo?.title) prefetchMedia(selectedVideo.title, selectedVideo.channel);
  }, [selectedVideo?.title, selectedVideo?.channel]);

  const handleCopyLink = async () => {
    if (!selectedVideo) return;
    const { ok } = await copyToClipboard(`https://www.youtube.com/watch?v=${selectedVideo.videoId}`);
    if (ok) { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); }
  };

  // ── Téléchargement vidéo dans une fenêtre pop-up ──
  // Même pattern que MashupPlayer (Mixer.jsx) : au lieu d'un simple lien
  // <a download> qui déclenche un téléchargement silencieux, on ouvre une
  // petite fenêtre avec la vidéo en lecture + un bouton de téléchargement
  // explicite — permet de prévisualiser avant de télécharger, et donne un
  // vrai retour visuel (au lieu d'un fichier qui atterrit juste dans le
  // dossier Téléchargements sans qu'on le voie). window.open("", ...) +
  // document.write : pas besoin de générer un fichier HTML côté serveur.
  const openVideoDownloadPopup = (src, filename) => {
    const popup = window.open(
      "", "clip-editor-video",
      "width=900,height=680,resizable=yes,scrollbars=no,status=no,menubar=no,toolbar=no"
    );
    if (!popup) {
      window.alert("Le navigateur a bloqué la fenêtre pop-up. Autorise les pop-ups pour ce site pour lire/télécharger la vidéo.");
      return;
    }
    const safeTitle = (filename || "clip").replace(/[<>]/g, "");
    popup.document.write(`<!DOCTYPE html>
<html><head><title>${safeTitle} — MacheUp Studio</title>
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
  <h1>${safeTitle}</h1>
  <video controls autoplay src="${src}"></video>
  <a class="dl" href="${src}" download="${safeTitle}">⬇ TÉLÉCHARGER LA VIDÉO</a>
</body></html>`);
    popup.document.close();
  };

  const startExtract = async () => {
    if (!selectedVideo) return;
    setJob(null);
    setFinalResult(null);
    try {
      const res = await fetch(`${API}/api/clip-editor/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: selectedVideo.videoId, title: selectedVideo.title }),
      });
      const data = await res.json();
      if (data.jobId) setJobId(data.jobId);
      else alert("Erreur : " + (data.error || "réponse inattendue"));
    } catch (e) {
      alert("Erreur réseau : " + e.message);
    }
  };

  const handleSeparate = async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`${API}/api/clip-editor/${jobId}/separate`, { method: "POST" });
      const data = await res.json();
      if (data.error) { alert("Erreur : " + data.error); return; }
      pollingRef.current = false;
      pollJob(jobId, generationRef.current); // relance le polling (même job/génération) pour suivre stemsStatus
    } catch (e) {
      alert("Erreur réseau : " + e.message);
    }
  };

  // Relance manuelle du nettoyage écho/réverb — utile après avoir installé
  // le package "audio-separator" suite à un 1er échec (package absent au
  // moment de la tentative automatique).
  const handleDereverbRetry = async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`${API}/api/clip-editor/${jobId}/dereverb`, { method: "POST" });
      const data = await res.json();
      if (data.error) { alert("Erreur : " + data.error); return; }
      pollingRef.current = false;
      pollJob(jobId, generationRef.current);
    } catch (e) {
      alert("Erreur réseau : " + e.message);
    }
  };

  const handleRecompose = async () => {
    if (!newAudio || !jobId || !job?.videoSilent) return;
    setRecomposing(true);
    setRecomposeError(null);
    try {
      const fd = new FormData();
      fd.append("audio", newAudio);
      fd.append("source", recomposeSource);
      const res = await fetch(`${API}/api/clip-editor/${jobId}/recompose`, { method: "POST", body: fd });
      const data = await res.json();
      if (data.url) setFinalResult(data);
      else setRecomposeError(data.error || "Erreur inconnue");
    } catch (e) {
      setRecomposeError("Erreur réseau : " + e.message);
    }
    setRecomposing(false);
  };

  const isDone = job?.status === "done";

  return (
    <div className="app" style={{ paddingBottom: 0 }}>
      {/* Zone de contenu scrollable indépendamment de la page : la page elle-
          même ne scrolle jamais (cf. html/#root/.app), mais le contenu de
          cette page est plus long que les Decks A/B — sans ceci, le surplus
          serait simplement coupé/invisible (overflow:hidden sur .app) et le
          bandeau Footer ci-dessous ne serait jamais atteignable. */}
      <div style={{ padding: "28px 16px 40px", flex: 1, minHeight: 0, overflowY: "auto" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 22, fontWeight: 900, letterSpacing: 3,
            background: "linear-gradient(90deg, var(--cyan), #fff 50%, var(--magenta))",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
            🎬 MACHEUP CLIP EDITOR
          </div>
          <div style={{ fontSize: 12, color: "var(--muted2)", letterSpacing: 1, marginTop: 6 }}>
            Récupère le son d'un clip YouTube, transforme-le avec ton IA préférée, puis remonte-le sur la vidéo d'origine.
          </div>
        </div>

        {/* Cadre principal : étapes ① et ② côte à côte, pour voir tout le début du parcours d'un coup d'œil */}
        <div className="clip-frame">
          {/* Colonne gauche — Étape 1 */}
          <div className="clip-frame-col col-cyan">
            <div className="clip-step-header">
              <div className="clip-step-label"><span className="clip-step-dot" />Choisis le clip à transformer</div>
              <div className="clip-step-num">①</div>
            </div>
            <VideoSearch onSelect={handleSelectVideo} />

            {selectedVideo && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12,
                background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: 10 }}>
                <img src={selectedVideo.thumbnail} alt="" style={{ width: 76, height: 57, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: "white", whiteSpace: "nowrap", overflow: "hidden",
                    textOverflow: "ellipsis", fontSize: 13 }}>
                    {selectedVideo.title}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--cyan)", marginTop: 2 }}>{selectedVideo.channel}</div>
                </div>
              </div>
            )}

            {selectedVideo && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <a href={`https://www.youtube.com/watch?v=${selectedVideo.videoId}`} target="_blank" rel="noreferrer"
                  style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--cyan)", whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis", textDecoration: "none" }}>
                  🔗 youtube.com/watch?v={selectedVideo.videoId}
                </a>
                <button onClick={handleCopyLink} type="button"
                  style={{ flexShrink: 0, padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    border: `1px solid ${linkCopied ? "var(--green)" : "rgba(255,255,255,0.15)"}`,
                    background: linkCopied ? "rgba(170,255,0,0.12)" : "rgba(255,255,255,0.03)",
                    color: linkCopied ? "var(--green)" : "var(--muted2)", cursor: "pointer" }}>
                  {linkCopied ? "✓ Copié" : "📋 Copier le lien"}
                </button>
              </div>
            )}

            {selectedVideo && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={() => setShowLyrics(true)} type="button"
                  style={{ flex: 1, padding: "6px 0", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)",
                    color: "var(--muted2)", cursor: "pointer" }}>
                  📄 Lyrics
                </button>
                <button onClick={() => setShowSuno(true)} type="button"
                  style={{ flex: 1, padding: "6px 0", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)",
                    color: "var(--muted2)", cursor: "pointer" }}>
                  ✦ Prompt Suno
                </button>
              </div>
            )}

            {showLyrics && <LyricsModal video={selectedVideo} onClose={() => setShowLyrics(false)} />}
            {showSuno && <PromptSunoModal video={selectedVideo} onClose={() => setShowSuno(false)} />}

            {selectedVideo && !jobId && (
              <button className="primary-btn" style={{ marginTop: 12 }} onClick={startExtract}>
                ▶ EXTRAIRE LA PISTE AUDIO
              </button>
            )}

            {job && <ExtractProgress job={job} />}

            {/* Aperçu vidéo d'origine — téléchargée en tâche de fond, peut
                arriver un peu après que l'audio soit prêt (étape ① "done") */}
            {job?.video && (
              <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "stretch" }}>
                <video ref={videoRef} src={`${API}${job.video}`} controls
                  style={{ flex: 1, minWidth: 0, maxHeight: 200, borderRadius: 10, display: "block", objectFit: "contain", background: "#000" }} />

                <div className="vol-slider-wrap clip-vol-cyan">
                  <div className="vol-icon">{clipVolume == 0 ? "🔇" : clipVolume < 50 ? "🔉" : "🔊"}</div>
                  <div className="vol-track-wrap">
                    <div className="vol-track-fill" style={{ height: `${clipVolume}%` }} />
                    <div className="vol-ticks">
                      {[0, 1, 2, 3, 4].map(i => <span key={i} />)}
                    </div>
                    <input type="range" className="vol-slider"
                      min="0" max="100" step="1" value={clipVolume}
                      onChange={handleClipVolumeChange} />
                  </div>
                </div>
              </div>
            )}
            {job?.video && (
              <button type="button"
                onClick={() => openVideoDownloadPopup(`${API}${job.video}`, `${sanitizeFilename(selectedVideo?.title || job.title)}.mp4`)}
                style={{ display: "block", width: "100%", textAlign: "center", marginTop: 8, padding: "8px 0", borderRadius: 6,
                  background: "rgba(0,234,255,0.1)", border: "1px solid rgba(0,234,255,0.3)",
                  color: "var(--cyan)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                ⬇ Télécharger la vidéo (MP4)
              </button>
            )}
            {isDone && !job.video && !job.videoError && (
              <div className="clip-frame-placeholder" style={{ marginTop: 16, minHeight: "auto", padding: 14 }}>
                🎬 Vidéo en cours de récupération…
              </div>
            )}
            {job?.videoError && (
              <div style={{ marginTop: 16, padding: "8px 12px", background: "rgba(255,68,68,0.08)",
                border: "1px solid #ff444433", borderRadius: 6, color: "#ff6666", fontSize: 13 }}>
                Vidéo indisponible : {job.videoError}
              </div>
            )}
          </div>

          {/* Colonne droite — Étape 2 */}
          <div className="clip-frame-col col-magenta">
            <div className="clip-step-header">
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <div className="clip-step-label"><span className="clip-step-dot" />Transforme le son avec ton outil IA</div>
                <SeparationCountdown active={isDone && (job?.stemsStatus === "idle" || job?.stemsStatus === "running")} />
              </div>
              <div className="clip-step-num">②</div>
            </div>

            {isDone ? (
              <>
                <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 12, lineHeight: 1.6 }}>
                  Télécharge la piste qui t'intéresse, va la transformer sur un outil comme <strong style={{ color: "#aaa" }}>Kits.ai</strong>,{" "}
                  <strong style={{ color: "#aaa" }}>Suno</strong>, <strong style={{ color: "#aaa" }}>Udio</strong> ou{" "}
                  <strong style={{ color: "#aaa" }}>LALAL.AI</strong>, puis reviens uploader le résultat à l'étape ③.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch" }}>
                  <StemCard icon="🎵" label="Piste complète" hint="Voix + musique (MP3)" url={job.fullAudio}
                    downloadName={`${sanitizeFilename(selectedVideo?.title || job.title)} (pistecomplete).${extFromUrl(job.fullAudio, "mp3")}`}
                  />
                  <StemCard icon="🎤" label="Voix seule"
                    hint={
                      job.stemsStatus === "error" ? `Erreur : ${job.stemsError || "réessaie"}`
                      : job.stemsStatus !== "done" ? "Séparation automatique en cours…"
                      : job.dereverbStatus === "done" ? "✨ Voix nettoyée (sans écho/réverb)"
                      : job.dereverbStatus === "running" ? "Pour un voice swap (Kits.ai…) · 🧹 nettoyage écho/réverb en cours…"
                      : job.dereverbStatus === "error" ? (
                          <>Pour un voice swap (Kits.ai…) · écho/réverb non retiré{" "}
                            <span onClick={handleDereverbRetry}
                              style={{ color: "var(--cyan)", cursor: "pointer", textDecoration: "underline" }}>
                              ↺ réessayer
                            </span>
                          </>
                        )
                      : "Pour un voice swap (Kits.ai…)"
                    }
                    url={job.vocalsClean || job.vocals}
                    downloadName={job.vocals ? `${sanitizeFilename(selectedVideo?.title || job.title)} (Voixseule)${job.vocalsClean ? " sans echo" : ""}.${extFromUrl(job.vocalsClean || job.vocals, "flac")}` : undefined}
                    pending={job.stemsStatus !== "done"}
                    showRetry={job.stemsStatus === "error"}
                    pendingLabel={job.stemsStatus === "error" ? "↺ Réessayer" : "⏳ En cours (1-2 min)…"}
                    onAction={handleSeparate}
                  />
                  <StemCard icon="🎹" label="Instrumental seul"
                    hint={
                      job.stemsStatus === "done" ? "Pour un remix (Suno, Udio…)"
                      : job.stemsStatus === "error" ? `Erreur : ${job.stemsError || "réessaie"}`
                      : "Séparation automatique en cours…"
                    }
                    url={job.instrumental}
                    downloadName={job.instrumental ? `${sanitizeFilename(selectedVideo?.title || job.title)} (Instru).${extFromUrl(job.instrumental, "flac")}` : undefined}
                    pending={job.stemsStatus !== "done"}
                    showRetry={job.stemsStatus === "error"}
                    pendingLabel={job.stemsStatus === "error" ? "↺ Réessayer" : "⏳ En cours (1-2 min)…"}
                    onAction={handleSeparate}
                  />
                </div>

                <div ref={remixWrapRef} style={{ marginTop: 18 }}>
                  <RemixPanel video={selectedVideo} maxHeight={remixMaxHeight || undefined} />
                </div>
              </>
            ) : (
              <div className="clip-frame-placeholder">
                {selectedVideo
                  ? (job ? "⏳ Extraction en cours…" : "▶ Lance l'extraction à gauche pour continuer ici.")
                  : "Choisis d'abord un clip à gauche."}
              </div>
            )}
          </div>

          {/* Colonne droite — Étape 3 */}
          <div className="clip-frame-col col-green">
            <div className="clip-step-header">
              <div className="clip-step-label"><span className="clip-step-dot" />Recompose le clip avec le nouveau son</div>
              <div className="clip-step-num">③</div>
            </div>

            {isDone ? (
              <>
                {!job.videoSilent && !job.videoError && (
                  <div className="clip-frame-placeholder" style={{ marginBottom: 14, minHeight: "auto", padding: 14 }}>
                    🎬 Préparation de la vidéo (sans son) en cours…
                  </div>
                )}
                {job.videoError && (
                  <div style={{ marginBottom: 14, padding: "8px 12px", background: "rgba(255,68,68,0.08)",
                    border: "1px solid #ff444433", borderRadius: 6, color: "#ff6666", fontSize: 13 }}>
                    Vidéo indisponible : {job.videoError}
                  </div>
                )}

                {job.videoSilent && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
                    background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 14px" }}>
                    <div style={{ fontSize: 20, flexShrink: 0 }}>🎬</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "white", whiteSpace: "nowrap",
                        overflow: "hidden", textOverflow: "ellipsis" }}>
                        {sanitizeFilename(selectedVideo?.title || job.title)} (sans son).mp4
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted2)" }}>Générée en masqué à l'étape ① — c'est elle qui sera recomposée ci-dessous</div>
                    </div>
                    <button type="button"
                      onClick={() => openVideoDownloadPopup(`${API}/api/clip-editor/${jobId}/video-silent`, `${sanitizeFilename(selectedVideo?.title || job.title)} (sans son).mp4`)}
                      style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 6, background: "rgba(0,234,255,0.1)",
                        border: "1px solid rgba(0,234,255,0.3)", color: "var(--cyan)", fontSize: 12, fontWeight: 700,
                        whiteSpace: "nowrap", cursor: "pointer" }}>
                      ⬇ Télécharger
                    </button>
                  </div>
                )}

                <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 8, fontWeight: 700, letterSpacing: 0.5 }}>
                  QUEL FICHIER AS-TU TRANSFORMÉ ?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                  {RECOMPOSE_SOURCES.map(s => {
                    const locked = s.id !== "full" && job.stemsStatus !== "done";
                    const active = recomposeSource === s.id;
                    return (
                      <button key={s.id} type="button"
                        onClick={() => !locked && setRecomposeSource(s.id)}
                        disabled={locked}
                        title={locked ? "Disponible une fois la séparation voix/instru terminée" : undefined}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8,
                          border: `1px solid ${active ? "var(--green)" : "var(--border)"}`,
                          background: active ? "rgba(170,255,0,0.08)" : "rgba(255,255,255,0.02)",
                          cursor: locked ? "not-allowed" : "pointer", opacity: locked ? 0.4 : 1,
                          textAlign: "left", width: "100%" }}>
                        <span style={{ width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
                          border: `2px solid ${active ? "var(--green)" : "#555"}`,
                          display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {active && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)" }} />}
                        </span>
                        <span style={{ fontSize: 17, flexShrink: 0 }}>{s.icon}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "white" }}>{s.label}</div>
                          <div style={{ fontSize: 11, color: "var(--muted2)" }}>{s.desc}</div>
                        </span>
                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
                          padding: "4px 10px", borderRadius: 20, textTransform: "uppercase", whiteSpace: "nowrap",
                          color: locked ? "#ffaa00" : "#aaff00",
                          background: locked ? "rgba(255,170,0,0.12)" : "rgba(170,255,0,0.12)",
                          border: `1px solid ${locked ? "rgba(255,170,0,0.4)" : "rgba(170,255,0,0.4)"}` }}>
                          ● {locked ? "Indispo" : "Dispo"}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <label style={{ display: "block", border: "1px dashed var(--border)", borderRadius: 10, padding: 18,
                  textAlign: "center", cursor: "pointer", color: newAudio ? "var(--cyan)" : "var(--muted2)", fontSize: 13 }}>
                  {newAudio ? `🎧 ${newAudio.name}` : `⬆ Clique pour uploader ${
                    recomposeSource === "vocals" ? "la voix" : recomposeSource === "instrumental" ? "l'instrumental" : "la piste complète"
                  } transformée par l'IA`}
                  <input type="file" accept="audio/*" style={{ display: "none" }}
                    onChange={e => setNewAudio(e.target.files[0] || null)} />
                </label>

                <button className="primary-btn" style={{ marginTop: 14 }}
                  disabled={!newAudio || recomposing || !job.videoSilent} onClick={handleRecompose}>
                  {recomposing ? "⏳ Recomposition en cours…"
                    : !job.videoSilent ? "⏳ Vidéo en préparation…"
                    : "🎬 RECOMPOSER LE CLIP"}
                </button>

                {recomposeError && (
                  <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(255,68,68,0.08)",
                    border: "1px solid #ff444433", borderRadius: 6, color: "#ff6666", fontSize: 13 }}>
                    {recomposeError}
                  </div>
                )}

                {finalResult && (
                  <div style={{ marginTop: 16 }}>
                    <div className="section-label" style={{ marginBottom: 8 }}>✅ Clip recomposé</div>
                    <video src={`${API}${finalResult.url}`} controls
                      style={{ width: "100%", borderRadius: 10, display: "block", marginBottom: 12 }} />
                    <button
                      onClick={() => openVideoDownloadPopup(
                        `${API}${finalResult.url}`,
                        `${sanitizeFilename(selectedVideo?.title || job.title || "clip")} (recompose).mp4`
                      )}
                      style={{ display: "block", width: "100%", textAlign: "center", padding: "10px 0", borderRadius: 8,
                        background: "var(--cyan)", color: "#000", fontWeight: 800, fontSize: 13,
                        border: "none", cursor: "pointer", letterSpacing: 1 }}>
                      ⬇ TÉLÉCHARGER LE CLIP FINAL
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="clip-frame-placeholder">
                Termine les étapes ① et ② pour recomposer le clip ici.
              </div>
            )}
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
}
