import React, { useState, useRef, useEffect } from "react";

const STATIONS = [
  { name: "Technolovers Mashup", url: "https://stream.technolovers.fm/mashup" },
  { name: "Lupo FM", url: "https://stream.laut.fm/lupo-fm" },
  { name: "Radio Heaven", url: "http://stream.radioheaven.pl:8000/stream" },
];

export default function RadioPlayer() {
  const [stationIdx, setStationIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(25);
  const audioRef = useRef(null);
  const wasPlayingRef = useRef(false);

  const station = STATIONS[stationIdx];

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

      <select className="radio-select" value={stationIdx} onChange={changeStation} title="Changer de fréquence">
        {STATIONS.map((s, i) => (
          <option key={s.url} value={i}>{s.name}</option>
        ))}
      </select>

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
    </div>
  );
}
