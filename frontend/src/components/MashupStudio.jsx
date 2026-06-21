import React, { useState, useRef } from "react";
import TopBar from "../components/TopBar.jsx";
import Deck from "../components/Deck.jsx";
import Mixer from "../components/Mixer.jsx";
import MashupsBar from "../components/MashupsBar.jsx";
import MashupProgressModal from "../components/MashupProgressModal.jsx";

export default function MashupStudio() {
  const [trackA, setTrackA] = useState(null);
  const [trackB, setTrackB] = useState(null);
  const [mashups, setMashups] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [showProgress, setShowProgress] = useState(false);

  const deckARef = useRef(null);
  const deckBRef = useRef(null);

  const handleTrack = (setter) => (data) => {
    if (!data) { setter(null); return; }
    setter(data);
  };

  // Crossfader : vol A = 1-cf, vol B = cf
  const handleCrossfadeChange = (cf) => {
    const volA = Math.round((1 - cf) * 100);
    const volB = Math.round(cf * 100);
    if (deckARef.current) deckARef.current.setVolume(volA);
    if (deckBRef.current) deckBRef.current.setVolume(volB);
  };

  const handleCreateMashup = async ({ crossfade, title, format, mode }) => {
    if (!trackA || !trackB) { alert("Chargez les deux pistes d'abord !"); return; }
    if (trackA.type !== "youtube" || trackB.type !== "youtube") {
      alert("Sélectionnez des vidéos YouTube pour les deux decks."); return;
    }
    try {
      const res = await fetch("http://localhost:3001/api/mashup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoA: { id: trackA.id, title: trackA.title },
          videoB: { id: trackB.id, title: trackB.title },
          mode, format, crossfade,
          title: title || `${trackA.title} x ${trackB.title}`,
        }),
      });
      const data = await res.json();
      if (data.jobId) { setJobId(data.jobId); setShowProgress(true); }
      else alert("Erreur : " + (data.error || "Réponse inattendue"));
    } catch { alert("Impossible de contacter le serveur backend."); }
  };

  const handleJobDone = (result) => {
    setMashups(prev => [{
      id: jobId,
      title: result.title || "Mashup",
      format: result.format || "mp3",
      file: result.url,
    }, ...prev]);
  };

  return (
    <div className="app">
      <TopBar />
      <div className="decks-row">
        <Deck
          side="A"
          ref={deckARef}
          file={trackA?.type === "file" ? trackA.file : null}
          onLoaded={handleTrack(setTrackA)}
        />
        <Mixer
          trackA={trackA} trackB={trackB}
          onCreateMashup={handleCreateMashup}
          onCrossfadeChange={handleCrossfadeChange}
        />
        <Deck
          side="B"
          ref={deckBRef}
          file={trackB?.type === "file" ? trackB.file : null}
          onLoaded={handleTrack(setTrackB)}
        />
      </div>
      <MashupsBar mashups={mashups} />
      {showProgress && (
        <MashupProgressModal
          jobId={jobId}
          onClose={() => setShowProgress(false)}
          onDone={handleJobDone}
        />
      )}
    </div>
  );
}
