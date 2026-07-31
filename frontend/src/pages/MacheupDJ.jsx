import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import Footer from "../components/Footer.jsx";
import MacheupDjLibrary from "../components/MacheupDjLibrary.jsx";

const API = "http://localhost:3001";

// ── MACHEUPDJ (30/07) — console 2 decks façon VirtualDJ ────────────────────
// Cf. diagnostic/spec-macheupdj.md pour le cadrage complet. Point clé qui
// façonne toute cette page : le scratch/pitch/boucle précise ont besoin d'un
// accès direct au signal audio décodé (Web Audio) — impossible pour une
// piste YouTube (l'iframe ne donne accès qu'à play/pause/seek/volume, jamais
// au flux brut). Cette page fonctionne donc UNIQUEMENT sur fichier uploadé,
// décodé directement côté navigateur (aucun aller-retour serveur nécessaire
// pour jouer/scratcher/boucler) — seule la séparation en 4 stems (Demucs)
// passe par le backend, en tâche de fond pendant que le deck joue déjà la
// piste complète.

const STEM_DEFS = [
  { key: "vocals", icon: "🎤", label: "Vocal" },
  { key: "drums", icon: "🥁", label: "Batterie" },
  { key: "bass", icon: "🎸", label: "Basse" },
  { key: "other", icon: "🎹", label: "Autres" },
];

const SECONDS_PER_ROTATION = 1.8; // vitesse de rotation visuelle du jog wheel à 33T approximatif
const N_CUES = 4;

function fmtTime(s) {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ── Moteur audio d'un deck — classe plain JS (pas un hook) : les
// AudioBufferSourceNode ne doivent JAMAIS être recréés à chaque render React,
// seule l'UI (position affichée, niveau VU...) doit re-render, pas le graphe
// audio lui-même. Un AudioBufferSourceNode ne peut être démarré qu'UNE FOIS
// (limite Web Audio) — toute reprise/seek/scratch en crée un nouveau à la
// bonne position, cf. _retrigger().
class DeckEngine {
  constructor(audioCtx, outputNode) {
    this.ctx = audioCtx;
    this.buffers = {}; // { full, vocals?, drums?, bass?, other? }
    this.stemsReady = false;
    this.activeNodes = []; // [{ key, sourceNode, gainNode }]
    this.playing = false;
    this.rate = 1.0; // playbackRate — pitch fader "vinyle" (tempo+hauteur liés)
    this.startedAtCtxTime = 0;
    this.startOffset = 0;
    this.loop = null; // { start, end } | null
    this._pendingLoopStart = null;
    this.cues = new Array(N_CUES).fill(null);
    this.stemState = Object.fromEntries(STEM_DEFS.map(d => [d.key, { mute: false, solo: false }]));

    // Callback optionnel (fourni par le composant React) — prévenu quand la
    // lecture s'arrête NATURELLEMENT (fin de piste sans boucle), pour que le
    // bouton PLAY/PAUSE ne reste pas coincé sur "en lecture" indéfiniment.
    // _intentionalStop distingue ce cas d'un arrêt volontaire (pause/seek/
    // scratch/rechargement de stems), qui déclenche aussi "onended" sur le
    // node arrêté mais ne doit PAS être traité comme une fin de piste.
    this.onNaturalEnd = null;
    this._intentionalStop = false;

    this.bus = audioCtx.createGain(); // point de sommation de ce deck
    this.bus.connect(outputNode); // outputNode = étage crossfader fourni par l'appelant

    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.bus.connect(this.analyser);
    this._levelData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  get duration() { return this.buffers.full?.duration || 0; }
  get hasAudio() { return !!this.buffers.full; }

  level() {
    if (!this.playing) return 0;
    this.analyser.getByteTimeDomainData(this._levelData);
    let sum = 0;
    for (let i = 0; i < this._levelData.length; i++) { const v = (this._levelData[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this._levelData.length) * 3.2);
  }

  currentPosition() {
    if (!this.hasAudio) return 0;
    const raw = this.playing
      ? this.startOffset + (this.ctx.currentTime - this.startedAtCtxTime) * this.rate
      : this.startOffset;
    return Math.max(0, Math.min(raw, this.duration));
  }

  async loadFull(arrayBuffer) {
    const buf = await this.ctx.decodeAudioData(arrayBuffer);
    this.stop();
    this.buffers = { full: buf };
    this.stemsReady = false;
    this.startOffset = 0;
    this.loop = null;
    this._pendingLoopStart = null;
    this.cues = new Array(N_CUES).fill(null);
  }

  async loadStems(urls) {
    const entries = await Promise.all(
      Object.entries(urls).map(async ([key, url]) => {
        const res = await fetch(`${API}${url}`);
        const ab = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(ab);
        return [key, buf];
      })
    );
    for (const [key, buf] of entries) this.buffers[key] = buf;
    this.stemsReady = true;
    // Bascule immédiate sur les stems si le deck joue déjà (même position/rate)
    if (this.playing) this._retrigger(this.currentPosition(), this.rate);
  }

  _stopActiveNodes() {
    this._intentionalStop = true;
    for (const { sourceNode } of this.activeNodes) {
      try { sourceNode.stop(); } catch { /* déjà arrêté */ }
      try { sourceNode.disconnect(); } catch { /* déjà déconnecté */ }
    }
    this.activeNodes = [];
    // Repasse à false au prochain tick — laisse le temps aux événements
    // "onended" déclenchés par les stop() ci-dessus de s'exécuter avant que
    // de nouveaux nodes (retrigger) ne soient créés et considérés comme une
    // vraie fin naturelle.
    setTimeout(() => { this._intentionalStop = false; }, 0);
  }

  _hasSolo() { return Object.values(this.stemState).some(s => s.solo); }

  _buildSources(offset, rate) {
    this._stopActiveNodes();
    const keys = this.stemsReady ? STEM_DEFS.map(d => d.key) : ["full"];
    const hasSolo = this._hasSolo();
    const nodes = keys.map(key => {
      const buf = this.buffers[key];
      if (!buf) return null;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      try { src.playbackRate.value = rate; } catch { /* navigateur exotique */ }
      if (this.loop) { src.loop = true; src.loopStart = this.loop.start; src.loopEnd = this.loop.end; }
      const gain = this.ctx.createGain();
      if (key !== "full") {
        const s = this.stemState[key];
        gain.gain.value = (s.mute || (hasSolo && !s.solo)) ? 0 : 1;
      }
      src.connect(gain).connect(this.bus);
      return { key, sourceNode: src, gainNode: gain };
    }).filter(Boolean);
    this.activeNodes = nodes;

    // "onended" écouté sur UN SEUL node représentatif (pas les 4 stems —
    // ils se termineraient tous quasi simultanément, inutile de dupliquer).
    // Ignoré si _intentionalStop (pause/seek/scratch/retrigger) ou si une
    // boucle est active (onended ne se déclenche alors jamais naturellement).
    if (nodes[0] && !this.loop) {
      nodes[0].sourceNode.onended = () => {
        if (this._intentionalStop) return;
        this.playing = false;
        this.onNaturalEnd?.();
      };
    }
    return nodes;
  }

  _retrigger(offset, rate = this.rate) {
    const nodes = this._buildSources(offset, rate);
    this.startedAtCtxTime = this.ctx.currentTime;
    this.startOffset = offset;
    nodes.forEach(({ sourceNode }) => { try { sourceNode.start(0, offset); } catch { /* buffer épuisé */ } });
  }

  play() {
    if (!this.hasAudio) return;
    let offset = this.currentPosition();
    if (offset >= this.duration - 0.02) offset = this.loop?.start ?? 0;
    this._retrigger(offset, this.rate);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.startOffset = this.currentPosition();
    this._stopActiveNodes();
    this.playing = false;
  }

  seekTo(t) {
    const target = Math.max(0, Math.min(t, this.duration));
    if (this.playing) this._retrigger(target, this.rate);
    else this.startOffset = target;
  }

  // Fader de pitch — comportement "vinyle" : playbackRate change tempo ET
  // hauteur ensemble (pas de key-lock en v1, cf. spec).
  setRate(r) {
    const clamped = Math.max(0.5, Math.min(1.5, r));
    if (this.playing) {
      this.startOffset = this.currentPosition();
      this.startedAtCtxTime = this.ctx.currentTime;
    }
    this.rate = clamped;
    this.activeNodes.forEach(({ sourceNode }) => {
      try { sourceNode.playbackRate.setValueAtTime(clamped, this.ctx.currentTime); } catch { /* ignore */ }
    });
  }

  setLoopIn() { this._pendingLoopStart = this.currentPosition(); }
  setLoopOut() {
    if (this._pendingLoopStart == null) return;
    const start = this._pendingLoopStart, end = this.currentPosition();
    if (end <= start + 0.05) return;
    this.loop = { start, end };
    this.activeNodes.forEach(({ sourceNode }) => {
      try { sourceNode.loop = true; sourceNode.loopStart = start; sourceNode.loopEnd = end; } catch { /* ignore */ }
    });
    this._pendingLoopStart = null;
  }
  clearLoop() {
    this.loop = null;
    this.activeNodes.forEach(({ sourceNode }) => { try { sourceNode.loop = false; } catch { /* ignore */ } });
  }

  // Un cue vide se POSE au clic ; un cue déjà posé fait SAUTER à sa position
  // (même convention qu'un CDJ/une MPC).
  toggleCue(i) {
    if (this.cues[i] == null) this.cues[i] = this.currentPosition();
    else this.seekTo(this.cues[i]);
  }
  clearCue(i) { this.cues[i] = null; }

  setStemState(key, patch) {
    this.stemState[key] = { ...this.stemState[key], ...patch };
    if (!this.stemsReady) return;
    const hasSolo = this._hasSolo();
    this.activeNodes.forEach(({ key: k, gainNode }) => {
      if (k === "full") return;
      const s = this.stemState[k];
      gainNode.gain.value = (s.mute || (hasSolo && !s.solo)) ? 0 : 1;
    });
  }

  // ── Scratch ── Modèle pratique (pas une émulation platine échantillon-
  // précis) : chaque mouvement de souris repositionne le buffer et rejoue un
  // court "burst" à une vitesse (et un sens, avant/arrière) dérivée de la
  // vitesse du geste — suffisant pour un vrai ressenti de scratch, avec un
  // grain un peu plus haché qu'une vraie platine. Lissage plus fin
  // (crossfade entre bursts) laissé en amélioration future.
  scratchStart() {
    this._scratchWasPlaying = this.playing;
    this._scratchPos = this.currentPosition();
    this._stopActiveNodes();
    this.playing = false;
  }
  scratchTo(deltaSeconds) {
    if (!this.hasAudio) return;
    this._scratchPos = Math.max(0, Math.min(this._scratchPos + deltaSeconds, this.duration));
    const rate = (deltaSeconds < 0 ? -1 : 1) * Math.max(0.3, Math.min(2.5, Math.abs(deltaSeconds) * 45));
    this._retrigger(this._scratchPos, rate);
    this.playing = true;
  }
  scratchEnd() {
    this._stopActiveNodes();
    this.playing = false;
    this.startOffset = this._scratchPos ?? this.startOffset;
    if (this._scratchWasPlaying) this.play();
  }

  stop() {
    this._stopActiveNodes();
    this.playing = false;
  }
}

// ── Jog wheel — cercle SVG qui tourne pendant la lecture, et réagit au
// clic-glissé pour le scratch (angle de la souris relatif au centre). ──────
function JogWheel({ engineRef, accentColor, rotationRef, playing, side }) {
  const svgRef = useRef(null);
  const draggingRef = useRef(false);
  const lastAngleRef = useRef(0);

  const angleFromEvent = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    return Math.atan2(e.clientY - cy, e.clientX - cx);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    lastAngleRef.current = angleFromEvent(e);
    engineRef.current?.scratchStart();
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    const angle = angleFromEvent(e);
    let delta = angle - lastAngleRef.current;
    // Normalise le passage ±π (évite un grand saut quand on traverse "derrière" le cercle)
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    lastAngleRef.current = angle;
    const deltaSeconds = (delta / (2 * Math.PI)) * SECONDS_PER_ROTATION;
    engineRef.current?.scratchTo(deltaSeconds);
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
    engineRef.current?.scratchEnd();
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  };

  useEffect(() => () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  }, []);

  return (
    <div
      ref={svgRef}
      onPointerDown={handlePointerDown}
      style={{
        width: 168, height: 168, borderRadius: "50%", position: "relative", flexShrink: 0,
        background: "radial-gradient(circle at 35% 30%, #2a2a2a, #0a0a0a 70%)",
        border: `3px solid ${accentColor}55`, boxShadow: `0 0 24px ${accentColor}22, inset 0 0 30px rgba(0,0,0,0.6)`,
        cursor: "grab", userSelect: "none", touchAction: "none",
      }}
    >
      <div
        id={`jogwheel-rotor-${side}`}
        style={{
          position: "absolute", inset: 8, borderRadius: "50%",
          background: "repeating-conic-gradient(from 0deg, #1a1a1a 0deg 8deg, #111 8deg 16deg)",
          border: `1px solid ${accentColor}33`,
          transform: `rotate(${(rotationRef.current || 0)}deg)`,
        }}
      />
      <div style={{
        position: "absolute", inset: "38%", borderRadius: "50%",
        background: "#050505", border: `2px solid ${accentColor}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "Orbitron,sans-serif", fontSize: 9, fontWeight: 900, letterSpacing: 1,
        color: accentColor, textAlign: "center", boxShadow: playing ? `0 0 16px ${accentColor}88` : "none",
      }}>
        MACHEUP<br />DJ
      </div>
    </div>
  );
}

function StemPad({ def, active, settings, onChange, hasSolo }) {
  const off = !active || settings.mute || (hasSolo && !settings.solo);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, opacity: active ? 1 : 0.4 }}>
      <div style={{ fontSize: 9, color: "var(--muted2)", fontWeight: 700 }}>{def.icon} {def.label}</div>
      <div style={{ display: "flex", gap: 3 }}>
        <button type="button" disabled={!active} onClick={() => onChange({ mute: !settings.mute })}
          title="Muet"
          style={{ width: 26, height: 22, borderRadius: 4, fontSize: 9, fontWeight: 800, cursor: active ? "pointer" : "default",
            border: `1px solid ${settings.mute ? "#ff4444" : "var(--border)"}`,
            background: settings.mute ? "rgba(255,68,68,0.2)" : "rgba(255,255,255,0.03)",
            color: settings.mute ? "#ff6666" : "var(--muted2)" }}>M</button>
        <button type="button" disabled={!active} onClick={() => onChange({ solo: !settings.solo })}
          title="Solo"
          style={{ width: 26, height: 22, borderRadius: 4, fontSize: 9, fontWeight: 800, cursor: active ? "pointer" : "default",
            border: `1px solid ${settings.solo ? "var(--yellow)" : "var(--border)"}`,
            background: settings.solo ? "rgba(255,204,0,0.2)" : "rgba(255,255,255,0.03)",
            color: settings.solo ? "var(--yellow)" : "var(--muted2)" }}>S</button>
      </div>
      <div style={{ width: 4, height: 4, borderRadius: "50%", background: off ? "#333" : "var(--green)",
        boxShadow: off ? "none" : "0 0 6px var(--green)" }} />
    </div>
  );
}

// ── Panneau d'un deck complet ── forwardRef : expose loadFile(file) pour
// que le parent (bouton →A/→B de la bibliothèque) puisse charger un fichier
// directement, sans passer par le <input type=file> caché de ce deck.
const DeckPanel = forwardRef(function DeckPanel({ side, label, accentColor, audioCtxRef, crossfaderInputRef, ensureAudio, tick }, ref) {
  const engineRef = useRef(null);
  const rotationRef = useRef(0);

  // Crée le moteur au premier moment où l'AudioContext partagé (parent) est
  // prêt — PAS dans un useEffect gardé par audioCtxRef.current en dépendance
  // (un ref qui change de valeur ne redéclenche jamais un effect : ça ne se
  // serait jamais exécuté une 2e fois). Appelée à la fois par la boucle de
  // tick (30fps, donc quasi immédiat après le 1er geste utilisateur) et par
  // handleFileChange (au cas où un fichier serait choisi avant tout autre
  // geste sur la page).
  const getEngine = () => {
    if (!engineRef.current && audioCtxRef.current && crossfaderInputRef.current) {
      engineRef.current = new DeckEngine(audioCtxRef.current, crossfaderInputRef.current);
      // Fin de piste naturelle (pas de boucle) → resynchronise le bouton
      // PLAY/PAUSE, sinon il reste coincé sur "en lecture" après la fin.
      engineRef.current.onNaturalEnd = () => setPlaying(false);
    }
    return engineRef.current;
  };
  const [fileName, setFileName] = useState(null);
  const [hasAudio, setHasAudio] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pitchPct, setPitchPct] = useState(0); // -50..+50, converti en playbackRate 0.5..1.5
  const [cues, setCues] = useState(new Array(N_CUES).fill(null));
  const [loopArmed, setLoopArmed] = useState(false);
  const [loopActive, setLoopActive] = useState(false);
  const [stemsStatus, setStemsStatus] = useState("idle"); // idle | uploading | running | done | error
  const [stemsError, setStemsError] = useState(null);
  const [stemState, setStemState] = useState(
    Object.fromEntries(STEM_DEFS.map(d => [d.key, { mute: false, solo: false }]))
  );
  const [posDisplay, setPosDisplay] = useState(0);
  const [durDisplay, setDurDisplay] = useState(0);
  const [level, setLevel] = useState(0);

  // Boucle d'affichage (position, rotation du jog wheel, VU-mètre) — pilotée
  // par le "tick" partagé du parent plutôt qu'un rAF par deck (moins coûteux
  // à 2 decks + master). C'est aussi ici que le moteur est créé dès qu'il
  // devient possible (cf. getEngine), sans dépendre d'un effect gardé par ref.
  useEffect(() => {
    const eng = getEngine();
    if (!eng) return;
    const pos = eng.currentPosition();
    setPosDisplay(pos);
    setLevel(eng.level());
    rotationRef.current = (pos / SECONDS_PER_ROTATION) * 360;
    const rotor = document.getElementById(`jogwheel-rotor-${side}`);
    // Rotation appliquée directement au DOM (pas de setState) pour rester fluide.
    if (rotor) rotor.style.transform = `rotate(${rotationRef.current}deg)`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Cœur du chargement d'un fichier dans ce deck — extrait de l'ancien
  // handleFileChange pour être appelable depuis 2 sources : le <input
  // type=file> caché de ce deck, OU le bouton →A/→B de la bibliothèque
  // (cf. useImperativeHandle plus bas), qui fournit directement un objet
  // File obtenu via FileSystemFileHandle.getFile() sans passer par un input.
  const loadFile = async (f) => {
    if (!f) return;
    ensureAudio?.();
    const eng = getEngine();
    if (!eng) {
      alert("Audio pas encore prêt — clique une fois n'importe où sur la page puis réessaie.");
      return;
    }
    setFileName(f.name);
    setHasAudio(false);
    setPlaying(false);
    setStemsStatus("idle"); setStemsError(null);
    setStemState(Object.fromEntries(STEM_DEFS.map(d => [d.key, { mute: false, solo: false }])));
    setCues(new Array(N_CUES).fill(null));
    setLoopActive(false); setLoopArmed(false);
    setPitchPct(0);

    const arrayBuffer = await f.arrayBuffer();
    try {
      await eng.loadFull(arrayBuffer.slice(0));
      setHasAudio(true);
      setDurDisplay(eng.duration);
      eng.setRate(1.0);
    } catch (err) {
      alert("Fichier audio illisible : " + err.message);
      return;
    }

    // Séparation 4 stems en tâche de fond (backend) — le deck joue déjà la
    // piste complète pendant ce temps, aucune attente bloquante.
    setStemsStatus("uploading");
    try {
      const fd = new FormData();
      fd.append("audio", f);
      const res = await fetch(`${API}/api/macheupdj/separate`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.jobId) throw new Error(data.error || "Échec du lancement");
      setStemsStatus("running");
      pollStems(data.jobId);
    } catch (err) {
      setStemsStatus("error");
      setStemsError(err.message);
    }
  };

  const handleFileChange = (e) => loadFile(e.target.files[0]);

  useImperativeHandle(ref, () => ({ loadFile }));

  const pollStems = (jobId) => {
    const tickPoll = async () => {
      try {
        const res = await fetch(`${API}/api/macheupdj/${jobId}/status`);
        const data = await res.json();
        if (!res.ok) { setStemsStatus("error"); setStemsError(data.error || "Job introuvable"); return; }
        if (data.status === "running") { setTimeout(tickPoll, 1500); return; }
        if (data.status === "error") { setStemsStatus("error"); setStemsError(data.message || "Erreur inconnue"); return; }
        if (data.status === "done") {
          await engineRef.current.loadStems({ vocals: data.vocals, drums: data.drums, bass: data.bass, other: data.other });
          setStemsStatus("done");
        }
      } catch (err) {
        setStemsStatus("error"); setStemsError(err.message);
      }
    };
    tickPoll();
  };

  const togglePlay = () => {
    const eng = engineRef.current;
    if (!eng || !hasAudio) return;
    if (playing) { eng.pause(); setPlaying(false); }
    else { eng.play(); setPlaying(true); }
  };

  const handleSeek = (e) => {
    const val = parseFloat(e.target.value);
    engineRef.current?.seekTo(val);
    setPosDisplay(val);
  };

  const handlePitch = (e) => {
    const pct = parseFloat(e.target.value);
    setPitchPct(pct);
    engineRef.current?.setRate(1 + pct / 100);
  };

  const handleLoopBtn = () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (!loopArmed) { eng.setLoopIn(); setLoopArmed(true); }
    else {
      eng.setLoopOut();
      setLoopArmed(false);
      setLoopActive(!!eng.loop);
    }
  };
  const handleLoopClear = () => { engineRef.current?.clearLoop(); setLoopActive(false); setLoopArmed(false); };

  const handleCue = (i) => {
    const eng = engineRef.current;
    if (!eng || !hasAudio) return;
    eng.toggleCue(i);
    setCues([...eng.cues]);
    setPosDisplay(eng.currentPosition());
  };
  const handleCueClear = (i, ev) => {
    ev.stopPropagation();
    engineRef.current?.clearCue(i);
    setCues([...engineRef.current.cues]);
  };

  const hasSolo = STEM_DEFS.some(d => stemState[d.key]?.solo);
  const changeStem = (key, patch) => {
    engineRef.current?.setStemState(key, patch);
    setStemState(s => ({ ...s, [key]: { ...s[key], ...patch } }));
  };

  return (
    <div className="clip-frame-col" style={{
      border: `2px solid ${accentColor}55`,
      boxShadow: `0 0 0 1px ${accentColor}22, 0 0 28px ${accentColor}22`,
      background: "var(--surface)", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 13, fontWeight: 900, letterSpacing: 2, color: accentColor }}>
          DECK {label}
        </div>
        <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted2)", cursor: "pointer",
          border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px" }}>
          ⬆ CHARGER
          <input type="file" accept="audio/*" onChange={handleFileChange} style={{ display: "none" }} />
        </label>
      </div>

      <div style={{ fontSize: 11, color: "var(--muted2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {fileName || "Glisse ou charge un fichier audio pour ce deck"}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <JogWheel engineRef={engineRef} accentColor={accentColor} rotationRef={rotationRef} playing={playing} side={side} />

        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
          {/* VU-mètre */}
          <div style={{ height: 8, background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round(level * 100)}%`,
              background: `linear-gradient(90deg, ${accentColor}, #fff)`, transition: "width 80ms linear" }} />
          </div>

          {/* Fader de pitch */}
          <div>
            <div style={{ fontSize: 10, color: "var(--muted2)", marginBottom: 2 }}>PITCH {pitchPct >= 0 ? "+" : ""}{pitchPct.toFixed(1)}%</div>
            <input type="range" min="-20" max="20" step="0.1" value={pitchPct} disabled={!hasAudio}
              onChange={handlePitch} style={{ width: "100%" }} />
          </div>

          <button type="button" onClick={togglePlay} disabled={!hasAudio}
            style={{ padding: "8px 0", borderRadius: 8, border: `1px solid ${accentColor}`,
              background: playing ? accentColor : "transparent", color: playing ? "#000" : accentColor,
              fontWeight: 800, fontSize: 13, cursor: hasAudio ? "pointer" : "default", letterSpacing: 1 }}>
            {playing ? "⏸ PAUSE" : "▶ PLAY"}
          </button>
        </div>
      </div>

      {/* Progression */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, color: "var(--muted2)", width: 32 }}>{fmtTime(posDisplay)}</span>
        <input type="range" min="0" max={durDisplay || 1} step="0.01" value={posDisplay} disabled={!hasAudio}
          onChange={handleSeek} style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--muted2)", width: 32 }}>{fmtTime(durDisplay)}</span>
      </div>

      {/* Boucle + hot cues */}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" disabled={!hasAudio} onClick={handleLoopBtn}
            style={{ padding: "6px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800,
              border: `1px solid ${loopArmed || loopActive ? accentColor : "var(--border)"}`,
              background: loopArmed ? `${accentColor}33` : loopActive ? `${accentColor}22` : "rgba(255,255,255,0.03)",
              color: loopArmed || loopActive ? accentColor : "var(--muted2)", cursor: hasAudio ? "pointer" : "default" }}>
            {loopArmed ? "◉ SORTIE" : loopActive ? "🔁 BOUCLE" : "◉ ENTRÉE"}
          </button>
          {loopActive && (
            <button type="button" onClick={handleLoopClear}
              style={{ padding: "6px 8px", borderRadius: 6, fontSize: 10, fontWeight: 800,
                border: "1px solid var(--border)", background: "rgba(255,255,255,0.03)", color: "var(--muted2)", cursor: "pointer" }}>
              ✕
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 4, flex: 1 }}>
          {cues.map((c, i) => (
            <button key={i} type="button" disabled={!hasAudio} onClick={() => handleCue(i)}
              title={c != null ? `Sauter à ${fmtTime(c)} (clic-droit / ✕ pour effacer)` : "Poser un hot cue ici"}
              style={{ position: "relative", flex: 1, padding: "6px 0", borderRadius: 6, fontSize: 10, fontWeight: 800,
                border: `1px solid ${c != null ? accentColor : "var(--border)"}`,
                background: c != null ? `${accentColor}22` : "rgba(255,255,255,0.03)",
                color: c != null ? accentColor : "var(--muted2)", cursor: hasAudio ? "pointer" : "default" }}>
              {i + 1}
              {c != null && (
                <span onClick={(ev) => handleCueClear(i, ev)}
                  style={{ position: "absolute", top: -6, right: -4, width: 14, height: 14, borderRadius: "50%",
                    background: "#222", border: "1px solid #444", fontSize: 8, lineHeight: "12px", color: "#999" }}>✕</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Stems 2.0 */}
      <div>
        <div style={{ fontSize: 10, color: "var(--muted2)", fontWeight: 700, letterSpacing: 0.5, marginBottom: 6 }}>
          STEMS 2.0 {stemsStatus === "running" || stemsStatus === "uploading" ? "· séparation en cours…" : stemsStatus === "error" ? `· ${stemsError}` : ""}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          {STEM_DEFS.map(d => (
            <StemPad key={d.key} def={d} active={stemsStatus === "done"} settings={stemState[d.key]} hasSolo={hasSolo}
              onChange={(patch) => changeStem(d.key, patch)} />
          ))}
        </div>
      </div>
    </div>
  );
});

export default function MacheupDJ() {
  const audioCtxRef = useRef(null);
  const deckAGainRef = useRef(null); // étage crossfader — entrée deck A
  const deckBGainRef = useRef(null); // étage crossfader — entrée deck B
  const masterGainRef = useRef(null);
  const masterAnalyserRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [crossfade, setCrossfade] = useState(0); // -1 (tout A) .. 0 (centre) .. 1 (tout B)
  const [masterVol, setMasterVol] = useState(80);
  const [masterLevel, setMasterLevel] = useState(0);
  const [tick, setTick] = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const deckARef = useRef(null);
  const deckBRef = useRef(null);

  // Construction du graphe partagé (crossfader + master) — une seule fois,
  // au premier geste utilisateur (AudioContext ne démarre pas tout seul dans
  // la plupart des navigateurs sans interaction).
  const ensureAudio = useCallback(() => {
    if (audioCtxRef.current) {
      if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const deckAGain = ctx.createGain();
    const deckBGain = ctx.createGain();
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    deckAGain.connect(master);
    deckBGain.connect(master);
    master.connect(analyser);
    analyser.connect(ctx.destination);
    master.gain.value = masterVol / 100;

    audioCtxRef.current = ctx;
    deckAGainRef.current = deckAGain;
    deckBGainRef.current = deckBGain;
    masterGainRef.current = master;
    masterAnalyserRef.current = analyser;
    setReady(true);
  }, [masterVol]);

  // Bouton →A/→B de la bibliothèque : charge le fichier choisi directement
  // dans le deck ciblé, sans passer par son <input type=file> caché.
  const handleLoadToDeck = useCallback((file, side) => {
    ensureAudio();
    const targetRef = side === "A" ? deckARef : deckBRef;
    targetRef.current?.loadFile(file);
  }, [ensureAudio]);

  useEffect(() => {
    const onFirstGesture = () => { ensureAudio(); };
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstGesture);
  }, [ensureAudio]);

  // Boucle d'affichage partagée (VU-mètres, jog wheels) — ~30fps.
  useEffect(() => {
    let raf, last = 0;
    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      setTick(x => x + 1);
      if (masterAnalyserRef.current) {
        const data = new Uint8Array(masterAnalyserRef.current.frequencyBinCount);
        masterAnalyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        setMasterLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Crossfader — loi de puissance constante (évite un creux de volume au
  // centre par rapport à une simple interpolation linéaire).
  const handleCrossfade = (e) => {
    const val = parseFloat(e.target.value);
    setCrossfade(val);
    if (!deckAGainRef.current || !deckBGainRef.current) return;
    const t = (val + 1) / 2; // 0..1
    deckAGainRef.current.gain.value = Math.cos(t * 0.5 * Math.PI);
    deckBGainRef.current.gain.value = Math.cos((1 - t) * 0.5 * Math.PI);
  };

  const handleMasterVol = (e) => {
    const v = parseFloat(e.target.value);
    setMasterVol(v);
    if (masterGainRef.current) masterGainRef.current.gain.value = v / 100;
  };

  return (
    <div className="app" style={{ paddingBottom: 0 }} onPointerDownCapture={ensureAudio}>
      <div style={{ padding: "28px 16px 40px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 22, fontWeight: 900, letterSpacing: 3,
            background: "linear-gradient(90deg, var(--cyan), #fff 50%, var(--magenta))",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
            🎧 MACHEUPDJ
          </div>
          {!ready && (
            <div style={{ marginTop: 10, fontSize: 11, color: "var(--yellow)" }}>
              ⚠ Clique n'importe où sur la page pour activer l'audio (règle du navigateur).
            </div>
          )}
          <button type="button" onClick={() => setLibraryOpen(v => !v)}
            style={{ marginTop: 12, fontSize: 11, fontWeight: 700, padding: "6px 14px", borderRadius: 7,
              border: `1px solid ${libraryOpen ? "var(--cyan)" : "var(--border)"}`,
              background: libraryOpen ? "rgba(0,234,255,0.1)" : "rgba(255,255,255,0.03)",
              color: libraryOpen ? "var(--cyan)" : "var(--muted2)", cursor: "pointer", letterSpacing: 1 }}>
            📁 BIBLIOTHÈQUE {libraryOpen ? "▴" : "▾"}
          </button>
        </div>

        {libraryOpen && (
          <MacheupDjLibrary onLoadToDeck={handleLoadToDeck} onClose={() => setLibraryOpen(false)} />
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 260px 1fr", gap: 16, alignItems: "start" }}>
          <DeckPanel ref={deckARef} side="A" label="A" accentColor="#00eaff" audioCtxRef={audioCtxRef} crossfaderInputRef={deckAGainRef} ensureAudio={ensureAudio} tick={tick} />

          {/* Section MASTER centrale */}
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 18,
            display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
            <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 12, fontWeight: 900, letterSpacing: 2, color: "var(--muted2)" }}>
              MASTER
            </div>

            <div style={{ width: "100%" }}>
              <div style={{ fontSize: 10, color: "var(--muted2)", marginBottom: 4, textAlign: "center" }}>Volume master</div>
              <input type="range" min="0" max="100" step="1" value={masterVol} onChange={handleMasterVol} style={{ width: "100%" }} />
            </div>

            <div style={{ width: "100%", height: 8, background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.round(masterLevel * 100)}%`,
                background: "linear-gradient(90deg, var(--green), var(--yellow), #ff4444)", transition: "width 80ms linear" }} />
            </div>

            <div style={{ width: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted2)", marginBottom: 4 }}>
                <span style={{ color: "var(--cyan)" }}>A</span>
                <span style={{ color: "var(--magenta)" }}>B</span>
              </div>
              <input type="range" min="-1" max="1" step="0.01" value={crossfade} onChange={handleCrossfade} style={{ width: "100%" }} />
            </div>
          </div>

          <DeckPanel ref={deckBRef} side="B" label="B" accentColor="#cc00ff" audioCtxRef={audioCtxRef} crossfaderInputRef={deckBGainRef} ensureAudio={ensureAudio} tick={tick} />
        </div>
      </div>

      <Footer />
    </div>
  );
}
