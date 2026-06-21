import React, { useState, useRef, useEffect } from "react";
import Deck from "../components/Deck.jsx";
import Mixer from "../components/Mixer.jsx";
import MashupsBar from "../components/MashupsBar.jsx";
import MashupProgressBar from "../components/MashupProgressModal.jsx";
import CoverGenerator from "../components/CoverGenerator.jsx";
import Footer from "../components/Footer.jsx";

export default function MashupStudio() {
  const [trackA, setTrackA] = useState(null);
  const [trackB, setTrackB] = useState(null);
  // Résultats d'analyse (BPM/clé/structure, cf. /api/analyze) de chaque deck
  // — utilisés par le Mixer pour afficher le score de compatibilité.
  const [analysisA, setAnalysisA] = useState(null);
  const [analysisB, setAnalysisB] = useState(null);
  const [mashups, setMashups] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [showProgress, setShowProgress] = useState(false);
  const [showCover, setShowCover] = useState(false);
  const [coverUrl, setCoverUrl] = useState(null);
  const [mashupResult, setMashupResult] = useState(null); // { flacUrl, mp4Url, title }
  const [generatingCover, setGeneratingCover] = useState(false);
  // Titre du mashup choisi automatiquement par l'IA — plus besoin de le
  // taper, gagne du temps. Reste interne (pas de champ dans le Mixer).
  const [autoTitle, setAutoTitle] = useState("");

  const deckARef = useRef(null);
  const deckBRef = useRef(null);

  // Tracks du mashup courant (pour l'auto-cover déclenchée à la création)
  const pendingTrackA = useRef(null);
  const pendingTrackB = useRef(null);
  const pendingTitle  = useRef(null);

  // Évite de regénérer titre/pochette en boucle pour la même paire de pistes
  // (l'effet ci-dessous se redéclenche à chaque changement de trackA/trackB).
  const lastAutoPairRef = useRef(null);

  const handleTrack = (setter) => (data) => {
    if (!data) { setter(null); return; }
    setter(data);
  };

  // Choisit automatiquement un titre de mashup via l'IA (1er des 10 titres
  // suggérés par /api/titles, déjà classés "meilleur d'abord" côté backend).
  // Repli simple si l'appel échoue, pour ne jamais bloquer la suite.
  const generateAutoTitle = async (ta, tb) => {
    const fallback = `${ta.channel || ta.title || "Track A"} x ${tb.channel || tb.title || "Track B"}`;
    try {
      const res = await fetch("http://localhost:3001/api/titles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleA: ta.title || "", artistA: ta.channel || "",
          titleB: tb.title || "", artistB: tb.channel || "",
        }),
      });
      const data = await res.json();
      return data.titles?.[0] || fallback;
    } catch (e) {
      console.error("Auto-title generation failed:", e);
      return fallback;
    }
  };

  // Génère la pochette IA du mashup — appelée dès que les 2 decks ont une
  // piste sélectionnée (en même temps que l'analyse démarre), plutôt que
  // d'attendre la fin du Create Macheup : la pochette est ainsi déjà prête,
  // affichée sous le bouton, au moment où l'utilisateur clique sur Create.
  const generateCover = async (ta, tb, mashupTitleOverride) => {
    setGeneratingCover(true);
    let cover = null;
    try {
      const artistA = ta.channel || "Artist A";
      const artistB = tb.channel || "Artist B";
      const mashupTitle = mashupTitleOverride || `${artistA} × ${artistB}`;
      const res = await fetch("http://localhost:3001/api/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleA:  ta.title || "Track A",
          artistA,
          titleB:  tb.title || "Track B",
          artistB,
          mashupTitle,
          format: "1:1",
        }),
      });
      const data = await res.json();
      if (data.url) {
        cover = `http://localhost:3001${data.url}`;
        setCoverUrl(cover);
      }
    } catch (e) {
      console.error("Auto-cover generation failed:", e);
    }
    setGeneratingCover(false);
    return cover;
  };

  // Dès que les 2 decks ont chacun une piste, on lance l'analyse (gérée dans
  // Deck.jsx), PUIS le titre auto (IA) ET la pochette (IA, avec ce titre
  // intégré dans le visuel) — sans attendre la création du mashup.
  useEffect(() => {
    if (!trackA || !trackB) return;
    const pairKey = `${trackA.id || trackA.file?.name}::${trackB.id || trackB.file?.name}`;
    if (lastAutoPairRef.current === pairKey) return;
    lastAutoPairRef.current = pairKey;
    (async () => {
      const t = await generateAutoTitle(trackA, trackB);
      setAutoTitle(t);
      generateCover(trackA, trackB, t);
    })();
  }, [trackA, trackB]);

  const handleSyncPlay = () => {
    deckARef.current?.play();
    deckBRef.current?.play();
  };
  const handleSyncPause = () => {
    deckARef.current?.pause();
    deckBRef.current?.pause();
  };
  const handleSyncRewind = () => {
    deckARef.current?.rewind();
    deckBRef.current?.rewind();
  };

  const handleMasterVolumeChange = (v) => {
    deckARef.current?.setVolume(v);
    deckBRef.current?.setVolume(v);
  };

  const handleCrossfadeChange = (cf) => {
    const volA = Math.round((1 - cf) * 100);
    const volB = Math.round(cf * 100);
    if (deckARef.current) deckARef.current.setVolume(volA);
    if (deckBRef.current) deckBRef.current.setVolume(volB);
  };

  const handleCreateMashup = async ({ crossfade, mode }) => {
    if (!trackA || !trackB) { alert("Chargez les deux pistes d'abord !"); return; }

    const defaultTitle = [trackA.title || trackA.file?.name, trackB.title || trackB.file?.name]
      .map(s => s?.replace(/\.[^.]+$/, "") || "Track")
      .join(" x ");
    // Titre choisi automatiquement par l'IA dès la sélection des 2 clips
    // (cf. useEffect plus haut) — repli sur un titre simple s'il n'a pas eu
    // le temps d'arriver (sélection puis clic Create très rapides).
    const finalTitle = autoTitle || defaultTitle;

    pendingTrackA.current = trackA;
    pendingTrackB.current = trackB;
    pendingTitle.current  = finalTitle;

    try {
      // Uploader les fichiers locaux avant de lancer le job
      const uploadFile = async (track) => {
        if (track.type !== "file") return { type: "youtube", id: track.id };
        const fd = new FormData();
        fd.append("audio", track.file);
        const res = await fetch("http://localhost:3001/api/mashup/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return { type: "file", fileId: data.fileId };
      };

      const [tA, tB] = await Promise.all([uploadFile(trackA), uploadFile(trackB)]);

      // FLAC + MP4 sont toujours générés ensemble côté serveur (en parallèle)
      // — plus de choix de format ici.
      const res = await fetch("http://localhost:3001/api/mashup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackA: tA, trackB: tB, mode, crossfade, title: finalTitle }),
      });
      const data = await res.json();
      if (data.jobId) { setJobId(data.jobId); setShowProgress(true); }
      else alert("Erreur : " + (data.error || "Réponse inattendue"));
    } catch (e) { alert("Erreur : " + e.message); }
  };

  const handleJobDone = async (result) => {
    const ta = pendingTrackA.current;
    const tb = pendingTrackB.current;
    const mt = pendingTitle.current;

    // La pochette a normalement déjà été générée dès la sélection des 2
    // clips (cf. useEffect ci-dessus) — on la réutilise directement. Filet
    // de sécurité seulement si elle n'a pas encore pu être générée (échec
    // réseau, génération encore en cours...).
    let cover = coverUrl;
    if (!cover && ta && tb) cover = await generateCover(ta, tb, mt);

    const flacUrl = result.flacUrl ? `http://localhost:3001${result.flacUrl}` : null;
    const mp4Url  = result.mp4Url  ? `http://localhost:3001${result.mp4Url}`  : null;

    const mashupData = {
      id: jobId,
      title: result.title || mt || "MacheUp",
      flacUrl, mp4Url,
      cover: cover || undefined,
    };
    setMashups(prev => [mashupData, ...prev]);

    // Le MP4 (quand dispo) prend la priorité dans le lecteur du Mixer, à la
    // place de la pochette statique.
    setMashupResult({ flacUrl, mp4Url, title: mashupData.title });
  };

  return (
    <div className="app">
      <div className="decks-row">
        <Deck
          side="A"
          ref={deckARef}
          file={trackA?.type === "file" ? trackA.file : null}
          onLoaded={handleTrack(setTrackA)}
          onAnalyzed={setAnalysisA}
        />
        <Mixer
          trackA={trackA} trackB={trackB}
          analysisA={analysisA} analysisB={analysisB}
          onCreateMashup={handleCreateMashup}
          onCrossfadeChange={handleCrossfadeChange}
          onMasterVolumeChange={handleMasterVolumeChange}
          onOpenCover={() => setShowCover(true)}
          onSyncPlay={handleSyncPlay}
          onSyncPause={handleSyncPause}
          onSyncRewind={handleSyncRewind}
          coverUrl={coverUrl}
          mashupResult={mashupResult}
          generatingCover={generatingCover}
        />
        <Deck
          side="B"
          ref={deckBRef}
          file={trackB?.type === "file" ? trackB.file : null}
          onLoaded={handleTrack(setTrackB)}
          onAnalyzed={setAnalysisB}
        />
      </div>

      {showProgress && (
        <MashupProgressBar
          jobId={jobId}
          onClose={() => setShowProgress(false)}
          onDone={handleJobDone}
        />
      )}

      <MashupsBar mashups={mashups} onDelete={(id) => setMashups(prev => prev.filter(m => m.id !== id))} />
      <Footer />

      {showCover && (
        <CoverGenerator
          trackA={trackA}
          trackB={trackB}
          onClose={() => setShowCover(false)}
          onCoverGenerated={(url) => { setCoverUrl(url); }}
        />
      )}
    </div>
  );
}
