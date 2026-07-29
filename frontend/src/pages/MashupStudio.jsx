import React, { useState, useRef, useEffect } from "react";
import Deck from "../components/Deck.jsx";
import Mixer from "../components/Mixer.jsx";
import MashupsBar from "../components/MashupsBar.jsx";
import ComboPanel from "../components/ComboPanel.jsx";
import CoverGenerator from "../components/CoverGenerator.jsx";
import DjAssistModal from "../components/DjAssistModal.jsx";
import MashupProgressBar from "../components/MashupProgressModal.jsx";
import Footer from "../components/Footer.jsx";

const API = "http://localhost:3001";

// ── Fusion MacheUp + MULTI (juillet 2026) ────────────────────────────────
// Écran unique : Deck A + Deck B par défaut au démarrage (comportement et
// apparence 100% identiques à l'ancien MashupStudio.jsx), avec possibilité
// d'ajouter des Decks C/D/E (mêmes couleurs étendues que Deck.jsx) pour
// basculer sur un mashup multi-sources (3-5 pistes, ex-écran "MULTI",
// pages/MashupMultiStudio.jsx, retiré — sa logique vit maintenant ici).
//
// Décision produit (cf. échange avec l'utilisateur) : UN SEUL bouton visible
// à la fois, quel que soit le nombre de decks — le lancement automatique du
// mashup dès que les 2 decks étaient prêts (ancien comportement à 2 pistes)
// est retiré ; il faut désormais toujours cliquer sur le bouton de création
// (celui de ComboPanel à 2 pistes, celui de la barre de config ci-dessous à
// 3-5 pistes). Les fonctions IA qui n'existent pas côté serveur pour le
// multi-sources (pochette auto, titre auto, DJ Assist) restent actives
// UNIQUEMENT à 2 decks et disparaissent dès qu'un 3e est ajouté.
const DECK_LETTERS_ALL = ["A", "B", "C", "D", "E"];
const MIN_DECKS = 2;
const MAX_DECKS = 5;
const COLOR_BY_LETTER = { A: "cyan", B: "magenta", C: "yellow", D: "teal", E: "orange" };
const COLOR_VARS = {
  cyan:    { accent: "var(--cyan)",    dim: "var(--cyan-dim)",    border: "var(--cyan-border)" },
  magenta: { accent: "var(--magenta)", dim: "var(--magenta-dim)", border: "var(--magenta-border)" },
  yellow:  { accent: "var(--yellow)",  dim: "var(--yellow-dim)",  border: "var(--yellow-border)" },
  teal:    { accent: "var(--teal)",    dim: "var(--teal-dim)",    border: "var(--teal-border)" },
  orange:  { accent: "var(--orange)",  dim: "var(--orange-dim)",  border: "var(--orange-border)" },
};
const colorOf = (letter) => COLOR_VARS[COLOR_BY_LETTER[letter]] || COLOR_VARS.cyan;

// Stems disponibles pour le mashup à la carte multi-sources (3-5 pistes) —
// mode 2 (voix/instru complet) volontairement absent : le contrat serveur
// (routes/mashupMulti.js, nonVocalPartsForMode) ne le supporte pas.
const MULTI_PARTS_BY_MODE = {
  4: [
    ["vocals", "🎤 Voix"],
    ["drums", "🥁 Batterie"],
    ["bass", "🎸 Basse"],
    ["other", "🎹 Autres"],
  ],
};
// Répartit chaque stem sur un deck différent en tournant (voix → 1er deck,
// puis un deck différent par stem suivant) — simple point de départ,
// entièrement modifiable ensuite via la grille "provenance".
const defaultMultiSelection = (mode, letters) => {
  const parts = (MULTI_PARTS_BY_MODE[mode] || MULTI_PARTS_BY_MODE[4]).map(([k]) => k);
  const n = letters.length;
  return Object.fromEntries(parts.map((p, i) => [p, letters[n > 0 ? i % n : 0]]));
};

export default function MashupStudio({ pendingPair, onTracksChange } = {}) {
  // ── Decks actifs (A+B par défaut, extensible à C/D/E) ──
  const [deckLetters, setDeckLetters] = useState(["A", "B"]);
  const isDuo = deckLetters.length === 2;

  // État par deck, indexé par lettre plutôt que par variable A/B fixe — même
  // contenu qu'avant (trackA/trackB, analysisA/analysisB, stemsA/stemsB),
  // juste généralisé à N decks.
  const [tracks, setTracks] = useState({});
  const [analyses, setAnalyses] = useState({});
  const [stems, setStems] = useState({});

  const [mashups, setMashups] = useState([]);
  // ── Historique persistant "Mes macheups" (correctif juillet 2026) ────────
  // Avant ce correctif, `mashups` ne vivait QUE dans ce state React — rempli
  // uniquement quand un job se terminait dans CETTE session (handleJobDone/
  // handleMultiJobDone plus bas), jamais relu depuis le serveur. Résultat
  // observé lors de l'audit : après plusieurs macheups générés avec succès
  // (fichiers bien présents sur le disque, vérifié directement), le panneau
  // n'en montrait jamais qu'un seul — parce que tout rechargement de page
  // remettait ce state à [], et le bouton "↺ ACTUALISER" de MashupsBar.jsx
  // n'avait même pas de onClick (no-op silencieux).
  // Le serveur persiste maintenant chaque macheup terminé dans un fichier
  // JSON (services/mashupHistory.js, routes/mashups.js) — refreshMashups()
  // relit cette liste, appelée au montage ET par le bouton "ACTUALISER".
  const refreshMashups = async () => {
    try {
      const res = await fetch(`${API}/api/mashups`);
      const data = await res.json();
      setMashups(Array.isArray(data.mashups) ? data.mashups : []);
    } catch (e) {
      console.warn("[MashupStudio] impossible de charger l'historique des macheups :", e.message);
    }
  };
  useEffect(() => { refreshMashups(); }, []);
  const handleDeleteMashup = async (id) => {
    setMashups(prev => prev.filter(m => m.id !== id)); // optimiste
    try {
      await fetch(`${API}/api/mashups/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      console.warn("[MashupStudio] échec suppression macheup :", e.message);
    }
  };
  const handleClearMashups = async () => {
    if (!confirm("Vider tout l'historique des macheups ? Les fichiers FLAC/MP4 générés seront aussi supprimés du disque — irréversible.")) return;
    setMashups([]); // optimiste
    try {
      await fetch(`${API}/api/mashups`, { method: "DELETE" });
    } catch (e) {
      console.warn("[MashupStudio] échec vidage historique macheups :", e.message);
    }
  };
  const [jobId, setJobId] = useState(null);
  const [showProgress, setShowProgress] = useState(false);
  const [showCover, setShowCover] = useState(false);
  const [coverUrl, setCoverUrl] = useState(null);
  const [mashupResult, setMashupResult] = useState(null); // { flacUrl, mp4Url, title }
  const [generatingCover, setGeneratingCover] = useState(false);
  // Titre choisi automatiquement par l'IA — 2 decks seulement (le serveur ne
  // sait pas encore générer de titre/pochette pour 3-5 pistes).
  const [autoTitle, setAutoTitle] = useState("");
  // Titre saisi à la main — 3-5 decks seulement (pas d'auto-titre là).
  const [multiTitle, setMultiTitle] = useState("");
  const [power, setPower] = useState(true);
  const [crossfade, setCrossfade] = useState(0.5);
  const [stemMode, setStemMode] = useState(4);
  const [createError, setCreateError] = useState(null);

  // ── DJ Assist — 2 decks seulement (a besoin d'un Deck A youtube analysé) ──
  const [showAssist, setShowAssist] = useState(false);
  const [assistTrackB, setAssistTrackB] = useState(null);
  const assistReady = isDuo && tracks.A?.type === "youtube" && !!analyses.A?.bpm;
  const handleAssistPick = (video) => { setAssistTrackB(video); setShowAssist(false); };

  // Remonte les pistes A/B chargées vers App.jsx — demande explicite : la
  // page EXT. (fenêtre d'émulation RaveDJ) a besoin de savoir quels morceaux
  // sont chargés dans les decks, sans dupliquer tout l'état du Studio.
  // Volontairement limité à A/B (type "youtube" seulement — un fichier
  // uploadé n'a pas d'URL YouTube à proposer à RaveDJ).
  useEffect(() => {
    if (!onTracksChange) return;
    const only = (t) => (t && t.type === "youtube" ? { id: t.id, title: t.title || "", channel: t.channel || "" } : null);
    onTracksChange({ A: only(tracks.A), B: only(tracks.B) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.A, tracks.B]);

  // ── Provenance des stems pour le mashup multi-sources (3-5 decks) ──
  const [multiSelection, setMultiSelection] = useState(() => defaultMultiSelection(4, ["A", "B"]));
  const [creatingMulti, setCreatingMulti] = useState(false);

  const deckRefs = useRef({}); // { A: instance, B: instance, ... }

  const pendingTracksRef = useRef({}); // { A: track, B: track } au moment du clic Create (2 decks)
  const pendingTitleRef = useRef(null);
  const lastAutoPairRef = useRef(null); // évite de regénérer titre/pochette en boucle pour la même paire

  // ── Verrou d'analyse partagé entre TOUS les decks actifs (2 à 5) — chaque
  // tâche d'analyse (Demucs) attend que la précédente soit terminée avant de
  // démarrer, peu importe quel deck l'a déclenchée. Simple chaîne de
  // promesses, indifférente au nombre d'appelants.
  const analyzeLockRef = useRef(Promise.resolve());
  const acquireAnalyzeLock = (taskFn) => {
    const run = analyzeLockRef.current.then(taskFn, taskFn);
    analyzeLockRef.current = run.catch(() => {});
    return run;
  };

  const setTrackFor = (letter) => (data) => setTracks(prev => ({ ...prev, [letter]: data || null }));
  const setAnalysisFor = (letter) => (data) => setAnalyses(prev => ({ ...prev, [letter]: data || null }));
  const setStemsFor = (letter) => (data) => setStems(prev => ({ ...prev, [letter]: data || null }));

  // Repart d'une sélection propre dès que le mode stems ou l'ensemble de
  // decks actifs change (les clés/lettres précédentes peuvent ne plus
  // exister) — même principe que ComboPanel pour son propre sélecteur 2 decks.
  useEffect(() => {
    if (!isDuo) setMultiSelection(defaultMultiSelection(stemMode, deckLetters));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stemMode, deckLetters.join(","), isDuo]);

  // ── Ajout/retrait de decks C/D/E ──
  const addDeck = () => {
    if (deckLetters.length >= MAX_DECKS) return;
    const next = DECK_LETTERS_ALL.find(l => !deckLetters.includes(l));
    if (!next) return;
    // Le mode 2 stems n'existe pas côté mashup multi-sources.
    if (deckLetters.length === 2 && stemMode === 2) setStemMode(4);
    setShowCover(false);
    setShowAssist(false);
    setDeckLetters(prev => [...prev, next].sort());
  };
  const removeDeck = (letter) => {
    if (deckLetters.length <= MIN_DECKS) return;
    if (letter === "A" || letter === "B") return; // A/B toujours présents
    deckRefs.current[letter]?.turnOff?.();
    setDeckLetters(prev => prev.filter(l => l !== letter));
    setTracks(prev => { const n = { ...prev }; delete n[letter]; return n; });
    setAnalyses(prev => { const n = { ...prev }; delete n[letter]; return n; });
    setStems(prev => { const n = { ...prev }; delete n[letter]; return n; });
    delete deckRefs.current[letter];
  };

  // Choisit automatiquement un titre de mashup via l'IA (2 decks seulement).
  const generateAutoTitle = async (ta, tb) => {
    const fallback = `${ta.channel || ta.title || "Track A"} x ${tb.channel || tb.title || "Track B"}`;
    try {
      const res = await fetch(`${API}/api/titles`, {
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

  // Génère la pochette IA du mashup (2 decks seulement) — dès que les 2 decks
  // ont une piste sélectionnée, avant même le clic sur le bouton de création.
  const generateCover = async (ta, tb, mashupTitleOverride) => {
    setGeneratingCover(true);
    let cover = null;
    try {
      const artistA = ta.channel || "Artist A";
      const artistB = tb.channel || "Artist B";
      const mashupTitle = mashupTitleOverride || `${artistA} × ${artistB}`;
      const res = await fetch(`${API}/api/cover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleA: ta.title || "Track A", artistA,
          titleB: tb.title || "Track B", artistB,
          mashupTitle, format: "1:1",
        }),
      });
      const data = await res.json();
      if (data.url) { cover = `${API}${data.url}`; setCoverUrl(cover); }
    } catch (e) {
      console.error("Auto-cover generation failed:", e);
    }
    setGeneratingCover(false);
    return cover;
  };

  // Dès que les 2 decks (A+B) ont chacun une piste, lance le titre auto (IA)
  // ET la pochette (IA) — sans attendre la création du mashup. Inactif dès
  // qu'un 3e deck est ajouté (isDuo devient false).
  useEffect(() => {
    if (!isDuo) return;
    const trackA = tracks.A, trackB = tracks.B;
    if (!trackA || !trackB) return;
    const pairKey = `${trackA.id || trackA.file?.name}::${trackB.id || trackB.file?.name}`;
    if (lastAutoPairRef.current === pairKey) return;
    lastAutoPairRef.current = pairKey;
    (async () => {
      const t = await generateAutoTitle(trackA, trackB);
      setAutoTitle(t);
      generateCover(trackA, trackB, t);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDuo, tracks.A, tracks.B]);

  const handleSyncPlay = () => { deckLetters.forEach(l => deckRefs.current[l]?.play()); };
  const handleSyncPause = () => { deckLetters.forEach(l => deckRefs.current[l]?.pause()); };
  const handleSyncRestart = () => { deckLetters.forEach(l => deckRefs.current[l]?.restart()); };
  const handleMasterVolumeChange = (v) => { deckLetters.forEach(l => deckRefs.current[l]?.setVolume(v)); };

  // Le crossfader ne pilote un panoramique de volume EN DIRECT qu'à 2 decks
  // (équilibre A/B) — à 3-5 decks, "crossfade" n'est plus qu'un simple
  // paramètre du mashup final (fondu), exactement comme dans l'ex-écran
  // MULTI : pas de panoramique multi-decks à inventer.
  const handleCrossfadeChange = (cf) => {
    setCrossfade(cf);
    if (!isDuo) return;
    const volA = Math.round((1 - cf) * 100);
    const volB = Math.round(cf * 100);
    deckRefs.current.A?.setVolume(volA);
    deckRefs.current.B?.setVolume(volB);
  };

  // Bouton ON/OFF du Mixer (2 decks seulement, cf. rendu plus bas) — coupe
  // tous les decks actifs et efface ce qui a été généré temporairement.
  const handleTogglePower = async (next) => {
    setPower(next);
    if (next) return;

    deckLetters.forEach(l => deckRefs.current[l]?.turnOff());

    setAnalyses({});
    setShowProgress(false);
    setJobId(null);
    setAutoTitle("");
    setCoverUrl(null);
    setGeneratingCover(false);
    setCreateError(null);
    lastAutoPairRef.current = null;
    pendingTracksRef.current = {};
    pendingTitleRef.current = null;

    const { flacUrl, mp4Url } = mashupResult || {};
    setMashupResult(null);
    try {
      await fetch(`${API}/api/mashup/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flacUrl, mp4Url }),
      });
    } catch (e) {
      console.error("Échec suppression des fichiers temporaires du mashup :", e);
    }
  };

  // Changement de mode de séparation (2/4 stems, cadre COMBO à 2 decks) —
  // recharge les decks (cycle OFF→ON déjà éprouvé), les stems déjà séparés
  // sous l'ancien mode n'ont plus aucune utilité.
  const handleStemModeChange = (nextMode) => {
    if (nextMode === stemMode) return;
    const hasContent = deckLetters.some(l => tracks[l]);
    if (hasContent && !confirm(
      `Passer en mode ${nextMode} stems va recharger les Decks (les morceaux déjà chargés seront à ressélectionner). Continuer ?`
    )) return;
    setStemMode(nextMode);
    if (hasContent) {
      handleTogglePower(false);
      handleTogglePower(true);
    }
  };

  // ── Création du mashup — 2 decks (A+B) : chemin riche existant (mode
  // full/stems, overrides pitch/tempo manuels), POST /api/mashup, inchangé
  // sauf l'accès à trackA/trackB désormais via tracks.A/tracks.B. ──
  const handleCreateMashup2 = async ({ crossfade, mode, pitchShiftOverride = null, tempoRatioOverride = null, stemSelection = null, durationMode = "full" }) => {
    const trackA = tracks.A, trackB = tracks.B;
    if (!trackA || !trackB) { alert("Chargez les deux pistes d'abord !"); return; }

    const defaultTitle = [trackA.title || trackA.file?.name, trackB.title || trackB.file?.name]
      .map(s => s?.replace(/\.[^.]+$/, "") || "Track")
      .join(" x ");
    const finalTitle = autoTitle || defaultTitle;

    pendingTracksRef.current = { A: trackA, B: trackB };
    pendingTitleRef.current = finalTitle;

    try {
      const uploadFile = async (track) => {
        if (track.type !== "file") return { type: "youtube", id: track.id };
        const fd = new FormData();
        fd.append("audio", track.file);
        const res = await fetch(`${API}/api/mashup/upload`, { method: "POST", body: fd });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return { type: "file", fileId: data.fileId };
      };

      const [tA, tB] = await Promise.all([uploadFile(trackA), uploadFile(trackB)]);

      const res = await fetch(`${API}/api/mashup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackA: tA, trackB: tB, mode, crossfade, title: finalTitle, pitchShiftOverride, tempoRatioOverride, stemSelection, stemMode, durationMode }),
      });
      const data = await res.json();
      if (data.jobId) { setJobId(data.jobId); setShowProgress(true); setCreateError(null); }
      else { setCreateError(data.error || "Réponse inattendue"); alert("Erreur : " + (data.error || "Réponse inattendue")); }
    } catch (e) {
      setCreateError(e.message);
      alert("Erreur : " + e.message);
    }
  };

  // Échec de génération (2 decks) — plus de relance auto silencieuse (elle
  // n'a de sens qu'avec un lancement automatique, retiré) : on affiche
  // l'erreur, l'utilisateur reclique sur le bouton s'il veut réessayer.
  const handleMashupError = (data) => {
    setShowProgress(false);
    setCreateError(data?.message || "La génération du mashup a échoué.");
  };

  const handleJobDone = async (result) => {
    const ta = pendingTracksRef.current.A;
    const tb = pendingTracksRef.current.B;
    const mt = pendingTitleRef.current;

    let cover = coverUrl;
    if (!cover && ta && tb) cover = await generateCover(ta, tb, mt);

    const flacUrl = result.flacUrl ? `${API}${result.flacUrl}` : null;
    const mp4Url  = result.mp4Url  ? `${API}${result.mp4Url}`  : null;

    const mashupData = {
      id: jobId,
      title: result.title || mt || "MacheUp",
      flacUrl, mp4Url,
      cover: cover || undefined,
    };
    setMashups(prev => [mashupData, ...prev]);
    setMashupResult({ flacUrl, mp4Url, silentUrl: result.silentUrl || null, title: mashupData.title });
    setCreateError(null);
  };

  // ── Création du mashup — 3 à 5 decks : POST /api/mashup-multi (ex-écran
  // MULTI, logique inchangée, juste déplacée ici). ──
  const activeMultiAnalyses = deckLetters.map(l => analyses[l]);
  const allMultiAnalyzed = activeMultiAnalyses.every(a => a && a.bpm != null && a.id);
  const multiParts = MULTI_PARTS_BY_MODE[stemMode] || MULTI_PARTS_BY_MODE[4];
  const multiSelectionValid = multiParts.every(([key]) => deckLetters.includes(multiSelection[key]));
  const canCreateMulti = allMultiAnalyzed && multiSelectionValid && !creatingMulti;

  const handleCreateMulti = async () => {
    if (!canCreateMulti) return;
    setCreateError(null);
    setCreatingMulti(true);
    setMashupResult(null);
    try {
      const payload = {
        tracks: activeMultiAnalyses.map(a => a.id),
        stemMode,
        stemSelection: Object.fromEntries(
          Object.entries(multiSelection).map(([part, letter]) => [part, deckLetters.indexOf(letter)])
        ),
        crossfade,
        title: multiTitle.trim() || "mashup-multi",
      };
      const res = await fetch(`${API}/api/mashup-multi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Échec de la création du mashup.");
      setJobId(data.jobId);
      setShowProgress(true);
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreatingMulti(false);
    }
  };

  const handleMultiJobDone = (data) => {
    const flacUrl = data.flacUrl ? `${API}${data.flacUrl}` : null;
    const mp4Url  = data.mp4Url  ? `${API}${data.mp4Url}`  : null;
    const mashupData = { id: jobId, title: data.title || multiTitle || "MacheUp Multi", flacUrl, mp4Url };
    setMashups(prev => [mashupData, ...prev]);
    setMashupResult({ flacUrl, mp4Url, title: mashupData.title });
  };
  const handleMultiJobError = (data) => {
    setShowProgress(false);
    setCreateError(data?.message || "Le mashup a échoué.");
  };

  return (
    <div className="app">
      {/* ── Gestion des decks (A+B fixes, C/D/E ajoutables) ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 16px 0" }}>
        <span style={{ fontSize: 11, color: "var(--muted2)", fontWeight: 700, letterSpacing: 1 }}>DECKS</span>
        {deckLetters.map(l => {
          const c = colorOf(l);
          return (
            <div key={l} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 8,
              border: `1px solid ${c.border}`, background: c.dim, color: c.accent,
              fontFamily: "Orbitron,sans-serif", fontSize: 12, fontWeight: 800,
            }}>
              {l}
              {l !== "A" && l !== "B" && (
                <button onClick={() => removeDeck(l)} title={`Retirer le Deck ${l}`} style={{
                  background: "transparent", border: "none", color: "inherit", cursor: "pointer",
                  fontSize: 13, lineHeight: 1, padding: 0, opacity: 0.8,
                }}>×</button>
              )}
            </div>
          );
        })}
        {deckLetters.length < MAX_DECKS && (
          <button onClick={addDeck} title="Ajouter un deck (mashup à la carte multi-sources)" style={{
            padding: "4px 12px", borderRadius: 8, border: "1px dashed var(--border)",
            background: "transparent", color: "var(--muted2)", fontSize: 12, fontWeight: 700, cursor: "pointer",
          }}>+ Ajouter un deck</button>
        )}
      </div>

      {isDuo ? (
        <div className="studio-grid">
          <Deck
            side="A"
            ref={el => { deckRefs.current.A = el; }}
            file={tracks.A?.type === "file" ? tracks.A.file : null}
            onLoaded={setTrackFor("A")}
            onAnalyzed={setAnalysisFor("A")}
            onStemsReady={setStemsFor("A")}
            onAcquireAnalyzeLock={acquireAnalyzeLock}
            disabled={!power}
            presetVideo={pendingPair?.trackA || null}
            stemMode={stemMode}
          />
          <Mixer
            trackA={tracks.A} trackB={tracks.B}
            analysisA={analyses.A} analysisB={analyses.B}
            onCreateMashup={handleCreateMashup2}
            onCrossfadeChange={handleCrossfadeChange}
            onMasterVolumeChange={handleMasterVolumeChange}
            onOpenCover={() => setShowCover(true)}
            onSyncPlay={handleSyncPlay}
            onSyncPause={handleSyncPause}
            onSyncRestart={handleSyncRestart}
            onPauseDecks={handleSyncPause}
            coverUrl={coverUrl}
            mashupResult={mashupResult}
            generatingCover={generatingCover}
            jobId={jobId}
            showProgress={showProgress}
            silentProgress={false}
            onCloseProgress={() => setShowProgress(false)}
            onJobDone={handleJobDone}
            onMashupError={handleMashupError}
            power={power}
            onTogglePower={handleTogglePower}
            onOpenAssist={() => setShowAssist(true)}
            assistReady={assistReady}
          />
          <Deck
            side="B"
            ref={el => { deckRefs.current.B = el; }}
            file={tracks.B?.type === "file" ? tracks.B.file : null}
            onLoaded={setTrackFor("B")}
            onAnalyzed={setAnalysisFor("B")}
            onStemsReady={setStemsFor("B")}
            onAcquireAnalyzeLock={acquireAnalyzeLock}
            disabled={!power}
            presetVideo={assistTrackB || pendingPair?.trackB || null}
            stemMode={stemMode}
          />

          <ComboPanel
            analysisA={analyses.A}
            analysisB={analyses.B}
            crossfade={crossfade}
            onCreateMashup={handleCreateMashup2}
            onPauseDecks={handleSyncPause}
            stemMode={stemMode}
            onStemModeChange={handleStemModeChange}
            demoToken={pendingPair}
          />
          <MashupsBar mashups={mashups} onDelete={handleDeleteMashup} onRefresh={refreshMashups} onClearAll={handleClearMashups} />
        </div>
      ) : (
        <div style={{ padding: "10px 16px", display: "flex", flexDirection: "column", gap: 12, minHeight: 0, overflowY: "auto" }}>
          {/* ── Barre de configuration (mashup multi-sources) ── */}
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12,
            padding: "12px 16px", display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center",
          }}>
            <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 1, fontSize: 13, color: "#ff5588" }}>
              🧬 MASHUP MULTI-SOURCES
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--muted2)", fontWeight: 700 }}>Stems</span>
              <div style={{ display: "flex", gap: 4, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, padding: 3 }}>
                {[4].map(m => {
                  const active = stemMode === m;
                  return (
                    <button key={m} onClick={() => setStemMode(m)} title="4 stems (standard)" style={{
                      padding: "5px 12px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 800,
                      cursor: "pointer", background: active ? "rgba(255,85,136,0.18)" : "transparent",
                      color: active ? "#ff5588" : "var(--muted2)",
                    }}>{m} stems</button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 160 }}>
              <span style={{ fontSize: 11, color: "var(--muted2)", fontWeight: 700, whiteSpace: "nowrap" }}>Fondu {Math.round(crossfade * 100)}%</span>
              <input type="range" min="0" max="1" step="0.05" value={crossfade}
                onChange={e => setCrossfade(parseFloat(e.target.value))}
                style={{ flex: 1 }} />
            </div>

            <input type="text" placeholder="Titre du mashup (optionnel)" value={multiTitle}
              onChange={e => setMultiTitle(e.target.value)}
              style={{
                flex: 1, minWidth: 180, padding: "7px 10px", borderRadius: 7,
                border: "1px solid var(--border)", background: "var(--surface2)", color: "white", fontSize: 12,
              }} />

            <button onClick={handleCreateMulti} disabled={!canCreateMulti} title={
              !allMultiAnalyzed ? "En attente de l'analyse complète (BPM/clé/stems) de tous les decks actifs"
              : !multiSelectionValid ? "Sélection de stems invalide"
              : "Créer le mashup"
            } style={{
              padding: "9px 20px", borderRadius: 8, border: "1px solid rgba(255,85,136,0.4)",
              background: canCreateMulti ? "rgba(255,85,136,0.16)" : "rgba(255,255,255,0.03)",
              color: canCreateMulti ? "#ff5588" : "var(--muted2)", fontSize: 12, fontWeight: 800,
              cursor: canCreateMulti ? "pointer" : "default", letterSpacing: 0.5, opacity: canCreateMulti ? 1 : 0.6,
            }}>
              {creatingMulti ? "GÉNÉRATION…" : "🎚 CRÉER LE MASHUP"}
            </button>
          </div>

          {createError && (
            <div style={{
              background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)",
              borderRadius: 8, padding: "8px 12px", color: "#ff8080", fontSize: 12,
            }}>⚠ {createError}</div>
          )}

          {showProgress && jobId && !mashupResult && (
            <div style={{ maxWidth: 320 }}>
              <MashupProgressBar
                jobId={jobId}
                statusUrlBase="/api/mashup-multi"
                onClose={() => setShowProgress(false)}
                onDone={handleMultiJobDone}
                onError={handleMultiJobError}
              />
            </div>
          )}

          {mashupResult && (
            <div style={{
              background: "var(--surface)", border: "1px solid rgba(0,234,255,0.25)", borderRadius: 12,
              padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
            }}>
              <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, fontSize: 12, color: "var(--cyan)" }}>
                ✅ MASHUP PRÊT
              </div>
              {mashupResult.mp4Url ? (
                <video src={mashupResult.mp4Url} controls style={{ maxWidth: 360, borderRadius: 8, background: "#000" }} />
              ) : (
                <audio src={mashupResult.flacUrl} controls />
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <a href={mashupResult.flacUrl} download style={{
                  padding: "6px 12px", borderRadius: 6, background: "rgba(0,234,255,0.12)",
                  border: "1px solid rgba(0,234,255,0.35)", color: "var(--cyan)", fontSize: 11, fontWeight: 700, textDecoration: "none",
                }}>⬇ FLAC</a>
                {mashupResult.mp4Url && (
                  <a href={mashupResult.mp4Url} download style={{
                    padding: "6px 12px", borderRadius: 6, background: "rgba(255,85,136,0.12)",
                    border: "1px solid rgba(255,85,136,0.35)", color: "#ff5588", fontSize: 11, fontWeight: 700, textDecoration: "none",
                  }}>⬇ MP4</a>
                )}
                <button onClick={() => { setMashupResult(null); setJobId(null); setShowProgress(false); }} style={{
                  padding: "6px 12px", borderRadius: 6, background: "transparent",
                  border: "1px solid var(--border)", color: "var(--muted2)", fontSize: 11, fontWeight: 700, cursor: "pointer",
                }}>Nouveau mashup</button>
              </div>
            </div>
          )}

          {/* ── Decks (N instances) ── */}
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            {deckLetters.map(l => (
              <Deck
                key={l}
                side={l}
                label={l}
                colorKey={COLOR_BY_LETTER[l]}
                hideUpload
                stemMode={stemMode}
                ref={el => { deckRefs.current[l] = el; }}
                onLoaded={setTrackFor(l)}
                onAnalyzed={setAnalysisFor(l)}
                onStemsReady={setStemsFor(l)}
                onAcquireAnalyzeLock={acquireAnalyzeLock}
                disabled={false}
              />
            ))}
          </div>

          {/* ── Provenance de chaque stem ── */}
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px" }}>
            <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 1, fontSize: 11, color: "var(--muted2)", marginBottom: 10 }}>
              🎛 PROVENANCE DE CHAQUE STEM
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {multiParts.map(([part, label]) => (
                <div key={part} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "var(--muted2)", minWidth: 100 }}>{label}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {deckLetters.map(l => {
                      const active = multiSelection[part] === l;
                      const trackLabel = analyses[l]?.title || tracks[l]?.title || `Deck ${l}`;
                      const c = colorOf(l);
                      return (
                        <button key={l}
                          onClick={() => setMultiSelection(s => ({ ...s, [part]: l }))}
                          title={trackLabel}
                          style={{
                            padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer",
                            border: `1px solid ${active ? c.border : "var(--border)"}`,
                            background: active ? c.dim : "transparent",
                            color: active ? c.accent : "var(--muted2)",
                          }}>{l}</button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted2)", lineHeight: 1.4, marginTop: 10 }}>
              Les stems venant d'un deck minoritaire sont automatiquement recalés (tempo + tonalité)
              sur le deck majoritaire avant combinaison — même moteur que le mashup à la carte classique.
            </div>
          </div>

          <MashupsBar mashups={mashups} onDelete={handleDeleteMashup} onRefresh={refreshMashups} onClearAll={handleClearMashups} />
        </div>
      )}

      <Footer />

      {showCover && isDuo && (
        <CoverGenerator
          trackA={tracks.A}
          trackB={tracks.B}
          onClose={() => setShowCover(false)}
          onCoverGenerated={(url) => { setCoverUrl(url); }}
        />
      )}

      {showAssist && isDuo && assistReady && (
        <DjAssistModal
          sourceTrack={{ id: analyses.A.id, title: tracks.A.title, channel: tracks.A.channel }}
          onPick={handleAssistPick}
          onClose={() => setShowAssist(false)}
        />
      )}
    </div>
  );
}
