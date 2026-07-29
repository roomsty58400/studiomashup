import React, { useState, useRef, useEffect } from "react";

// "Mashup" a été retiré du catalogue Technolovers (mount inexistant — cf.
// commentaire précédent). "Festival Sounds" est ce qui s'en rapproche le
// plus dans leur catalogue actuel : un mix de plusieurs sous-genres EDM
// (Big Room, Hardstyle, Trap...) plutôt qu'un genre unique — mount vérifié
// actif (stream_start du jour).
const STATIONS = [
  { name: "Technolovers Festival Sounds", url: "https://stream.technolovers.fm/technolovers-festivalsounds" },
];

export default function RadioPlayer() {
  const [stationIdx, setStationIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(25);
  const [nowPlaying, setNowPlaying] = useState(null); // titre en cours (métadonnées ICY), null si indisponible

  // ── Enregistrement du morceau en cours (bouton ⏺) ──
  const [recordStatus, setRecordStatus] = useState("idle"); // idle | recording | finalizing | error
  const [recordingId, setRecordingId] = useState(null);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const [recordError, setRecordError] = useState(null);
  const recordTimerRef = useRef(null);
  const recordPollRef = useRef(false);
  // Même correctif que Deck.jsx/ClipEditor.jsx/MashupWheel.jsx/DjAssistModal.jsx
  // (juillet 2026) : recordPollRef empêchait seulement de LANCER un 2e
  // polling en parallèle, pas d'arrêter une boucle déjà en vol si un nouvel
  // enregistrement démarre pendant que l'ancien finalise encore côté serveur.
  const recordGenerationRef = useRef(0);

  const audioRef = useRef(null);
  const wasPlayingRef = useRef(false);
  const nowPlayingTimerRef = useRef(null);

  const station = STATIONS[stationIdx];

  // ── Titre en cours (carrousel sous le mini-player) ──
  // Le <audio> HTML natif n'expose pas les métadonnées ICY embarquées dans le
  // flux (StreamTitle) — on les récupère via un petit proxy backend
  // (services/icyMetadata.js) qui se connecte brièvement au flux et lit le
  // prochain bloc de métadonnées. Sondé toutes les 15s tant que la radio
  // joue ; arrêté sinon (pas d'appel réseau inutile radio à l'arrêt).
  useEffect(() => {
    clearInterval(nowPlayingTimerRef.current);
    setNowPlaying(null);
    if (!playing || error) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`http://localhost:3001/api/radio/now-playing?url=${encodeURIComponent(station.url)}`);
        const data = await res.json();
        // N'écrase le titre affiché QUE si on en reçoit un nouveau — un
        // sondage isolé qui revient vide (backend déjà tolérant sur 90s, cf.
        // routes/radio.js) ne doit pas faire disparaître le carrousel pour
        // rien : ça donnait l'impression que "ça ne s'affiche pas
        // systématiquement" alors que la chanson n'avait pas changé.
        if (!cancelled && data?.title) setNowPlaying(data.title);
      } catch {
        // Erreur réseau ponctuelle : on garde le dernier titre affiché plutôt
        // que de le faire clignoter.
      }
    };
    poll();
    // Rafale de sondages rapprochés juste après le lancement (3s, 6s, 10s) —
    // une connexion ICY qui démarre en plein milieu d'un morceau (cas le plus
    // fréquent) ne reçoit l'annonce du titre qu'au changement de morceau
    // suivant ; retenter vite au début, avant de retomber sur la cadence
    // normale de 15s, augmente nettement les chances d'afficher un titre dès
    // le lancement plutôt que de laisser le cadre vide plusieurs minutes.
    const burstTimers = [3000, 6000, 10000].map(ms => setTimeout(poll, ms));
    nowPlayingTimerRef.current = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(nowPlayingTimerRef.current);
      burstTimers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, error, stationIdx]);

  // Nettoyage du chrono d'enregistrement au démontage — pas de fuite de timer.
  useEffect(() => () => clearInterval(recordTimerRef.current), []);

  // Téléchargement sans ouvrir de nouvel onglet (même pattern que Deck.jsx) —
  // fonctionne cross-origin car c'est le serveur (Content-Disposition via
  // res.download(), cf. routes/radio.js) qui force le téléchargement, pas
  // l'attribut HTML "download" (ignoré en cross-origin).
  const triggerDownload = (url) => {
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const pollRecordStatus = (id, gen) => {
    if (recordPollRef.current) return;
    recordPollRef.current = true;
    const tick = async () => {
      if (gen !== recordGenerationRef.current) { recordPollRef.current = false; return; }
      try {
        const res = await fetch(`http://localhost:3001/api/radio/record/${id}/status`);
        const data = await res.json();
        if (gen !== recordGenerationRef.current) { recordPollRef.current = false; return; }
        if (!res.ok) {
          recordPollRef.current = false;
          setRecordStatus("error"); setRecordError(data.error || "Enregistrement introuvable");
          return;
        }
        if (data.status === "done") {
          recordPollRef.current = false;
          setRecordStatus("idle"); setRecordingId(null);
          triggerDownload(`http://localhost:3001/api/radio/record/${id}/download`);
        } else if (data.status === "error") {
          recordPollRef.current = false;
          setRecordStatus("error"); setRecordError(data.error || "Erreur inconnue");
        } else {
          setTimeout(tick, 1000);
        }
      } catch (e) {
        if (gen !== recordGenerationRef.current) { recordPollRef.current = false; return; }
        recordPollRef.current = false;
        setRecordStatus("error"); setRecordError(e.message);
      }
    };
    tick();
  };

  const startRecording = async () => {
    const gen = ++recordGenerationRef.current; // invalide tout polling en vol pour un enregistrement précédent
    setRecordError(null);
    try {
      const res = await fetch("http://localhost:3001/api/radio/record/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: station.url, title: nowPlaying || station.name }),
      });
      const data = await res.json();
      if (gen !== recordGenerationRef.current) return; // un enregistrement plus récent a déjà pris le relais
      if (!res.ok) throw new Error(data.error || "Échec du lancement de l'enregistrement");
      setRecordingId(data.recordingId);
      setRecordStatus("recording");
      setRecordElapsed(0);
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = setInterval(() => setRecordElapsed(s => s + 1), 1000);
    } catch (e) {
      if (gen !== recordGenerationRef.current) return;
      setRecordStatus("error"); setRecordError(e.message);
    }
  };

  const stopRecording = async () => {
    if (!recordingId) return;
    clearInterval(recordTimerRef.current);
    setRecordStatus("finalizing");
    try {
      await fetch(`http://localhost:3001/api/radio/record/${recordingId}/stop`, { method: "POST" });
      recordPollRef.current = false;
      pollRecordStatus(recordingId, recordGenerationRef.current); // même enregistrement/génération, on reprend juste le polling
    } catch (e) {
      setRecordStatus("error"); setRecordError(e.message);
    }
  };

  const handleRecordClick = () => {
    if (recordStatus === "idle") startRecording();
    else if (recordStatus === "recording") stopRecording();
    else if (recordStatus === "error") { setRecordStatus("idle"); setRecordError(null); }
    // "finalizing" : clic ignoré, la finalisation ne se pilote pas.
  };

  const fmtElapsed = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Volume / mute
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume / 100;
  }, [volume, muted]);

  // Changement de fréquence : recharge le flux, reprend la lecture si elle était en cours
  useEffect(() => {
    setError(false);
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    if (wasPlayingRef.current) {
      setLoading(true);
      audio.play().catch(() => { setError(true); setPlaying(false); setLoading(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationIdx]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      wasPlayingRef.current = false;
    } else {
      setError(false);
      setLoading(true);
      wasPlayingRef.current = true;
      audio.play().catch(() => { setError(true); setPlaying(false); setLoading(false); wasPlayingRef.current = false; });
      setPlaying(true);
    }
  };

  const changeStation = (e) => setStationIdx(Number(e.target.value));

  const volIcon = muted || volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊";

  return (
    <div className="radio-player" title={station.name}>
      <audio
        ref={audioRef}
        preload="none"
        onPlaying={() => { setLoading(false); setError(false); }}
        onWaiting={() => setLoading(true)}
        onError={() => { setError(true); setLoading(false); setPlaying(false); wasPlayingRef.current = false; }}
      >
        <source src={station.url} />
      </audio>

      <span className="radio-dot" data-on={playing && !error} />

      <button className="radio-play-btn" onClick={togglePlay} title={playing ? "Arrêter la radio" : "Écouter la radio"}>
        {loading ? "…" : playing ? "⏹" : "▶"}
      </button>

      {/* Une seule station : plus besoin d'un menu déroulant de sélection —
          simple libellé fixe à la place. */}
      {STATIONS.length > 1 ? (
        <select className="radio-select" value={stationIdx} onChange={changeStation} title="Changer de fréquence">
          {STATIONS.map((s, i) => (
            <option key={s.url} value={i}>{s.name}</option>
          ))}
        </select>
      ) : (
        <span className="radio-select" style={{ cursor: "default" }}>{station.name}</span>
      )}

      <button className="radio-mute-btn" onClick={() => setMuted(m => !m)} title={muted ? "Réactiver le son" : "Couper le son"}>
        {volIcon}
      </button>

      <input
        type="range" className="radio-vol-slider"
        min="0" max="100" value={volume}
        onChange={e => { setVolume(Number(e.target.value)); if (muted) setMuted(false); }}
        title="Volume radio"
      />

      {error && <span className="radio-error" title="Flux radio indisponible pour le moment">⚠</span>}

      {/* Titre en cours façon carrousel — le cadre apparaît dès que la radio
          joue (pas seulement une fois le titre reçu) : avant, le cadre restait
          invisible tant qu'aucun titre n'était encore arrivé, ce qui donnait
          l'impression qu'il "n'apparaît pas" au lancement alors qu'il
          attendait juste le 1er sondage réussi (cf. rafale de sondages
          ci-dessus). Un texte de chargement statique comble ce vide.
          Reste aussi visible pendant finalizing/error même si la lecture a
          été arrêtée entre-temps, pour ne jamais perdre l'accès au bouton
          d'enregistrement en cours. */}
      {((playing && !error) || recordStatus !== "idle") && (
        <div className="radio-nowplaying-row">
          <div className="radio-nowplaying" title={nowPlaying || "Recherche du titre en cours…"}>
            {nowPlaying ? (
              <span className="radio-nowplaying-track" style={{ animationDuration: `${Math.max(8, nowPlaying.length * 0.35)}s` }}>
                🎵 {nowPlaying}
              </span>
            ) : (
              <span className="radio-nowplaying-loading">🎵 Recherche du titre…</span>
            )}
          </div>

          {/* Enregistre le morceau en cours de diffusion — capture live du
              flux (côté serveur, ffmpeg -c copy) démarrée/arrêtée
              manuellement : impossible de détecter automatiquement le début
              exact d'un morceau déjà en cours. */}
          <button type="button" className="radio-record-btn" data-recording={recordStatus === "recording"}
            onClick={handleRecordClick}
            disabled={recordStatus === "finalizing"}
            title={
              recordStatus === "recording" ? "Arrêter l'enregistrement et le télécharger"
              : recordStatus === "finalizing" ? "Finalisation de l'enregistrement…"
              : recordStatus === "error" ? `Erreur : ${recordError || "réessaie"}`
              : "Enregistrer le morceau en cours"
            }>
            {recordStatus === "recording" ? `⏹ ${fmtElapsed(recordElapsed)}`
              : recordStatus === "finalizing" ? "⏳"
              : recordStatus === "error" ? "⚠"
              : "⏺"}
          </button>
        </div>
      )}
    </div>
  );
}
