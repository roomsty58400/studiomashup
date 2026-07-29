import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import LyricsModal from "./LyricsModal.jsx";
import PromptSunoModal from "./PromptSunoModal.jsx";
import { prefetchMedia } from "../utils/mediaCache.js";

const YT_API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY;

// Nombre de barres du visualiseur audio (fichiers mp3/uploadés)
const VIS_BARS = 56;

// Durée max (secondes) d'un clip proposé dans la liste de suggestions — un
// morceau "normal" dépasse rarement 10 min ; au-delà, c'est presque toujours
// une compilation/live/mix qui ne convient pas pour un mashup (et plombe
// inutilement le temps d'extraction/séparation). Exclu directement de la
// liste plutôt que juste signalé, à la demande de l'utilisateur. Les vidéos
// dont la durée n'a pas pu être récupérée (durationSec null) ne sont pas
// filtrées : on ne peut pas juger, donc on ne les exclut pas par défaut.
const MAX_RESULT_DURATION_SEC = 600; // 10 minutes

function loadYTApi() {
  if (window.YT || document.getElementById("yt-api-script")) return;
  const tag = document.createElement("script");
  tag.id = "yt-api-script";
  tag.src = "https://www.youtube.com/iframe_api";
  document.body.appendChild(tag);
}

// Téléchargement sans ouvrir de nouvel onglet — window.open(url, "_blank")
// ouvre brièvement un onglet vide (le serveur force le téléchargement via
// Content-Disposition, mais l'onglet vide reste visible un instant), ce qui
// donnait un effet de flash/scintillement à l'écran. Un <a> caché cliqué
// programmatiquement déclenche le même téléchargement forcé, sans aucune
// navigation ni onglet visible.
function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function formatDuration(sec) {
  if (sec == null) return null;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// label / colorKey (optionnels, Phase 5 UI multi-sources) : par défaut,
// dérivés de "side" exactement comme avant (aucun changement de comportement
// pour les 2 appelants existants, qui ne passent ni l'un ni l'autre). Ajoutés
// pour permettre à un écran à N decks de donner à chaque instance un "side"
// UNIQUE (nécessaire : iframeContainerId = "yt-player-${side}" collisionnerait
// entre 2 decks partageant le même "side", cassant la lecture YouTube d'un
// des deux) tout en gardant un libellé lisible ("DECK 1", "DECK 2"...) et une
// palette de couleur indépendante de cet identifiant.
//
// Palette étendue à 5 couleurs (fusion MacheUp/MULTI, juillet 2026) : A/B
// gardent exactement leurs couleurs cyan/magenta d'origine (zéro changement
// visuel pour l'écran 2 decks) ; C/D/E (nouveaux decks ajoutables) reçoivent
// 3 couleurs supplémentaires, définies comme variables CSS ci-dessous (cf.
// styles.css :root) pour rester cohérentes avec le reste de l'habillage.
const DECK_PALETTE = {
  cyan:    { accent: "#00eaff", dim: "rgba(0,234,255,0.18)" },
  magenta: { accent: "#cc00ff", dim: "rgba(204,0,255,0.18)" },
  yellow:  { accent: "#ffcc00", dim: "rgba(255,204,0,0.18)" },
  teal:    { accent: "#00ffb3", dim: "rgba(0,255,179,0.18)" },
  orange:  { accent: "#ff6a00", dim: "rgba(255,106,0,0.18)" },
};
const Deck = forwardRef(function Deck({ side, label, colorKey, onLoaded, onAnalyzed, file, disabled, onStemsReady, onAcquireAnalyzeLock, presetVideo, hideUpload, stemMode = 4 }, ref) {
  const displayLabel = label ?? side;
  const color = colorKey || (side === "A" ? "cyan" : "magenta");
  const { accent: accentColor, dim: accentDim } = DECK_PALETTE[color] || DECK_PALETTE.cyan;

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(80);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [searchError, setSearchError] = useState(null);
  // Filtre "Officiels uniquement" (clips ✓ OFFICIEL) — désactivé par défaut
  // pour ne pas réduire le choix sans que l'utilisateur l'ait demandé ;
  // filtrage 100% côté client (aucun appel réseau supplémentaire), donc
  // instantané à l'activation/désactivation.
  const [officialOnly, setOfficialOnly] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showSuno, setShowSuno] = useState(false);
  const [recognizing, setRecognizing]     = useState(false);
  const [recognizeResult, setRecognizeResult] = useState(null); // { found, title, artist, album, artwork }
  const [recognizeError,  setRecognizeError]  = useState(null);

  // Extraction voix / instru (FLAC) à la demande — un seul job Demucs partagé
  // produit les 2 stems, peu importe lequel des 2 boutons l'a déclenché.
  const [stemsJobId, setStemsJobId] = useState(null);
  const [stemsStatus, setStemsStatus] = useState("idle"); // idle | running | done | error
  const [stemsError, setStemsError] = useState(null);
  const stemsPollingRef = useRef(false);

  // ── Compteur de génération (même correctif que MashupWheel.jsx/
  // DjAssistModal.jsx, juillet 2026) ───────────────────────────────────────
  // Bug de la même famille, jamais corrigé ici : pollAnalyze/pollStems
  // utilisaient seulement un booléen partagé (analyzePollingRef/
  // stemsPollingRef) pour empêcher de LANCER un 2e polling en parallèle, mais
  // ne coupaient jamais une boucle déjà en vol. Si l'utilisateur sélectionne
  // un 2e morceau dans CE deck pendant que l'analyse/séparation du 1er tourne
  // encore côté serveur, l'ancienne boucle tick() (fermeture sur l'ancien
  // jobId) continuait d'appeler setAnalyzeStatus/setAnalyzeResult/
  // setStemsStatus pour le morceau précédent, en concurrence avec la nouvelle
  // — un résultat BPM/clé périmé pouvait écraser celui du morceau qu'on vient
  // de sélectionner, ou le badge restait bloqué sur "en cours" indéfiniment.
  // Incrémenté dans handleSelect/handleClear/handleFileChange (tout ce qui
  // change l'identité du morceau chargé) — PAS dans les boutons "réessayer"
  // (qui relancent une analyse/séparation pour le MÊME morceau, donc restent
  // valides). Chaque tick() vérifie qu'il appartient toujours à la
  // génération courante avant d'appliquer le moindre setState.
  const generationRef = useRef(0);

  // Analyse complète (BPM/clé/structure + 4 stems) pour le moteur de scoring
  // de compatibilité — distinct des boutons Voix/Instru FLAC ci-dessus (qui
  // ne font qu'une séparation 2 stems légère, sans analyse musicale).
  const [analyzeStatus, setAnalyzeStatus] = useState("idle"); // idle | running | done | error
  const [analyzeResult, setAnalyzeResult] = useState(null); // ligne "track" renvoyée par /api/analyze
  const [analyzeError, setAnalyzeError] = useState(null);
  const analyzePollingRef = useRef(false);

  const audioRef        = useRef(null);
  const playerRef       = useRef(null);
  const canvasRef       = useRef(null);
  const analyserRef     = useRef(null);
  const audioCtxRef     = useRef(null);
  const animFrameRef    = useRef(null);
  const sourceConnected = useRef(false);
  const peaksRef         = useRef(new Float32Array(VIS_BARS));
  const smoothRef        = useRef(new Float32Array(VIS_BARS));
  const iframeContainerId = `yt-player-${side}`;
  const searchTimeout     = useRef(null);

  // Ferme l'AudioContext du visualiseur (fichier uploadé) au démontage de ce
  // Deck (audit juillet 2026) : les Decks C/D/E (mode multi-pistes) peuvent
  // être ajoutés puis retirés via removeDeck() (MashupStudio.jsx) — s'ils
  // avaient un fichier local chargé, leur AudioContext restait ouvert
  // indéfiniment après le démontage. Même risque d'épuisement de la limite
  // Chrome d'AudioContext non fermés par onglet que pour ComboPanel.jsx (cf.
  // commentaire là-bas) en cas d'ajout/retrait répété de decks avec fichiers.
  useEffect(() => {
    return () => { audioCtxRef.current?.close().catch(() => {}); };
  }, []);
  const searchAbortRef    = useRef(null);
  const progressInterval  = useRef(null);

  // Expose setVolume / play / pause / rewind — rewind() permet au Mixer de
  // reculer les 2 decks en simultané (cf. bouton ⏪ dans Mixer.jsx) sans
  // jamais couper la lecture, contrairement à pause()+seek qui interromprait
  // les 2 vidéos.
  useImperativeHandle(ref, () => ({
    setVolume: (v) => {
      setVolume(v);
      if (playerRef.current?.setVolume) playerRef.current.setVolume(v);
      if (audioRef.current) audioRef.current.volume = v / 100;
    },
    play: () => {
      if (playerRef.current?.playVideo) playerRef.current.playVideo();
      else if (audioRef.current && file) audioRef.current.play();
    },
    pause: () => {
      if (playerRef.current?.pauseVideo) playerRef.current.pauseVideo();
      else if (audioRef.current) audioRef.current.pause();
    },
    rewind: (seconds = 5) => {
      if (selectedVideo && playerRef.current?.getCurrentTime) {
        const cur = playerRef.current.getCurrentTime();
        playerRef.current.seekTo(Math.max(0, cur - seconds), true);
      } else if (audioRef.current) {
        audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - seconds);
      }
    },
    // Retour au tout début du clip (0:00) — remplace le recul de 5s dans le
    // Mixer (cf. bouton "⏮ Retour au départ"), sans couper la lecture en
    // cours (même esprit que rewind() ci-dessus).
    restart: () => {
      if (selectedVideo && playerRef.current?.seekTo) {
        playerRef.current.seekTo(0, true);
      } else if (audioRef.current) {
        audioRef.current.currentTime = 0;
      }
      setProgress(0);
    },
    // Coupe le deck (bouton ON/OFF du Mixer) : stoppe la lecture et efface
    // tout ce qui a été chargé/généré (vidéo/fichier, durées, séparation
    // stems, analyse) — même logique que le 🗑 du deck, exposée au Mixer.
    turnOff: () => handleClear(),
  }));

  useEffect(() => { loadYTApi(); }, []);

  // Signale au serveur qu'une vidéo n'est pas lisible en intégration (codes
  // YouTube 100/101/150 — "vidéo supprimée/privée" ou "lecture désactivée sur
  // d'autres sites Web", cf. message natif du lecteur) : persisté côté
  // serveur (services/blockedVideos.js) pour qu'elle ne soit plus jamais
  // proposée dans AUCUNE recherche (en complément du filtre status.embeddable
  // de l'API YouTube, qui peut être pris en défaut pour certaines vidéos,
  // comme constaté en pratique). Retire aussi ce résultat de la liste déjà
  // affichée dans ce deck (le filtre serveur ne s'applique qu'aux recherches
  // futures, pas à une liste déjà chargée).
  const blockUnplayableVideo = (video) => {
    if (!video?.id) return;
    fetch("http://localhost:3001/api/youtube/block", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: video.id }),
    }).catch(() => {});
    setResults(prev => prev.filter(r => r.id !== video.id));
  };

  // YouTube player
  useEffect(() => {
    if (!selectedVideo) return;
    const initPlayer = () => {
      if (playerRef.current) {
        playerRef.current.loadVideoById(selectedVideo.id);
        playerRef.current.pauseVideo();
        return;
      }
      playerRef.current = new window.YT.Player(iframeContainerId, {
        videoId: selectedVideo.id,
        playerVars: { autoplay: 0, controls: 0, modestbranding: 1, rel: 0 },
        events: {
          onReady: (e) => { e.target.setVolume(volume); },
          onError: (e) => {
            if ([100, 101, 150].includes(e.data)) blockUnplayableVideo(selectedVideo);
          },
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.PLAYING) {
              setPlaying(true);
              // clearInterval AVANT réassignation (audit juillet 2026) : si
              // 2 événements PLAYING arrivent d'affilée sans repasser par un
              // autre état (resynchronisation après un seekTo, changement de
              // qualité auto...), l'ancien intervalle était juste écrasé sans
              // être annulé — il continuait de tourner indéfiniment en
              // arrière-plan (setProgress dupliqué), le cleanup de démontage
              // ne connaissant plus que le DERNIER intervalle assigné.
              clearInterval(progressInterval.current);
              progressInterval.current = setInterval(() => {
                if (playerRef.current?.getCurrentTime) {
                  const cur = playerRef.current.getCurrentTime();
                  const dur = playerRef.current.getDuration();
                  if (dur) setProgress(cur / dur);
                }
              }, 500);
            } else {
              setPlaying(false);
              clearInterval(progressInterval.current);
            }
          },
        },
      });
    };
    if (window.YT?.Player) initPlayer();
    else window.onYouTubeIframeAPIReady = initPlayer;
  }, [selectedVideo]);

  useEffect(() => () => clearInterval(progressInterval.current), []);

  // Audio file src
  useEffect(() => {
    if (file && audioRef.current) {
      const url = URL.createObjectURL(file);
      audioRef.current.src = url;
      return () => URL.revokeObjectURL(url);
    }
  }, [file]);

  // ── Web Audio visualizer ──────────────────────────────────────────
  useEffect(() => {
    if (!file || selectedVideo) {
      cancelAnimationFrame(animFrameRef.current);
      return;
    }

    // Init AudioContext + AnalyserNode once par élément audio
    if (!sourceConnected.current && audioRef.current) {
      try {
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = actx.createAnalyser();
        analyser.fftSize = 512;                  // 256 bins — plus de détail pour le mapping log ci-dessous
        analyser.smoothingTimeConstant = 0.78;
        const source = actx.createMediaElementSource(audioRef.current);
        source.connect(analyser);
        analyser.connect(actx.destination);
        audioCtxRef.current  = actx;
        analyserRef.current  = analyser;
        sourceConnected.current = true;
      } catch (e) { console.error("AudioContext error:", e); }
    }

    // Resume suspended context (browser policy requires user gesture)
    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume();
    }

    const canvas   = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas) return;

    // Make canvas crisp on any DPR
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;

    const NUM_BARS = VIS_BARS;
    const peaks  = peaksRef.current;
    const smooth = smoothRef.current;
    let t = 0;

    // Répartition logarithmique des bins FFT par barre : avec un mapping
    // linéaire, l'énergie d'un mp3 (concentrée dans les basses/médiums) ne
    // couvre que les premiers bins → toute la moitié droite du visualiseur
    // restait quasi plate/morte. En répartissant les bins en échelle log
    // (comme un égaliseur classique), chaque barre couvre une plage de
    // fréquence proportionnelle et le rendu est vivant sur toute sa largeur.
    const binRanges = [];
    if (analyser) {
      const total = analyser.frequencyBinCount;
      const minIdx = 1, maxIdx = total - 1;
      const logMin = Math.log2(minIdx), logMax = Math.log2(maxIdx);
      for (let i = 0; i < NUM_BARS; i++) {
        const t0 = i / NUM_BARS, t1 = (i + 1) / NUM_BARS;
        const idx0 = Math.max(minIdx, Math.round(2 ** (logMin + t0 * (logMax - logMin))));
        const idx1 = Math.max(idx0 + 1, Math.round(2 ** (logMin + t1 * (logMax - logMin))));
        binRanges.push([idx0, Math.min(idx1, maxIdx)]);
      }
    }

    const draw = () => {
      animFrameRef.current = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, W, H);
      t += 0.018;

      let fftData = null;
      if (analyser && playing) {
        fftData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(fftData);
      }

      const gap  = 3;
      const barW = (W - (NUM_BARS - 1) * gap) / NUM_BARS;

      for (let i = 0; i < NUM_BARS; i++) {
        let target;
        if (fftData && binRanges[i]) {
          const [idx0, idx1] = binRanges[i];
          let sum = 0, count = 0;
          for (let k = idx0; k < idx1; k++) { sum += fftData[k]; count++; }
          target = count ? (sum / count) / 255 : 0;
          // Compense la perte d'énergie naturelle dans les aigus pour que
          // les barres de droite restent visibles plutôt que figées en bas.
          target = Math.min(target * (1 + (i / NUM_BARS) * 0.7), 1);
        } else {
          // Animation au repos — vague sinusoïdale douce
          target = (Math.sin(t * 1.4 + i * 0.28) * 0.5 + 0.5) * 0.18 + 0.04;
        }

        // Lissage inter-frame en plus de celui de l'AnalyserNode : évite les
        // barres qui "sautent" d'une frame à l'autre, mouvement plus fluide.
        smooth[i] += (target - smooth[i]) * (fftData ? 0.45 : 0.08);
        const v = smooth[i];

        // Peak-hold : petit repère qui monte avec la barre puis retombe lentement
        if (v >= peaks[i]) peaks[i] = v;
        else peaks[i] = Math.max(v, peaks[i] - 0.012);

        const h = Math.max(2, v * H * 0.94);
        const x = i * (barW + gap);

        // Gradient : base sombre → couleur d'accent → blanc au sommet
        const grad = ctx.createLinearGradient(0, H, 0, H - h);
        grad.addColorStop(0,    accentDim);
        grad.addColorStop(0.55, accentColor);
        grad.addColorStop(1,    playing ? "#ffffff" : accentColor);
        ctx.fillStyle = grad;

        // Sommet arrondi
        const radius = Math.min(barW / 2, 4);
        ctx.beginPath();
        ctx.moveTo(x, H);
        ctx.lineTo(x, H - h + radius);
        ctx.quadraticCurveTo(x, H - h, x + radius, H - h);
        ctx.lineTo(x + barW - radius, H - h);
        ctx.quadraticCurveTo(x + barW, H - h, x + barW, H - h + radius);
        ctx.lineTo(x + barW, H);
        ctx.closePath();
        ctx.fill();

        // Lueur sur les pics
        if (playing && v > 0.55) {
          ctx.shadowColor = accentColor;
          ctx.shadowBlur  = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Trait de peak-hold
        if (playing && peaks[i] > 0.04) {
          const capY = H - peaks[i] * H * 0.94;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x, capY - 2, barW, 2);
          ctx.globalAlpha = 1;
        }
      }

      // Reflet en miroir (subtil)
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.scale(1, -1);
      ctx.translate(0, -H * 2);
      ctx.drawImage(canvas, 0, 0, W * dpr, H * dpr, 0, 0, W, H);
      ctx.restore();
    };

    draw();
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [file, playing, selectedVideo]);
  // ─────────────────────────────────────────────────────────────────

  const searchYouTube = async (q) => {
    if (!q || q.length < 2) {
      searchAbortRef.current?.abort();
      setResults([]); setShowResults(false); setSearchError(null);
      return;
    }

    // Annule la recherche précédente encore en vol : sans ça, si une recherche
    // plus ancienne ("str") répond après une plus récente ("stromae"), ses
    // résultats obsolètes écrasaient les bons (course de requêtes / résultats
    // affichés ne correspondant pas à ce qui est tapé).
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`http://localhost:3001/api/youtube/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      const data = await res.json();
      if (controller.signal.aborted) return; // une recherche plus récente a pris le relais
      if (Array.isArray(data)) {
        const mapped = data
          .map(item => ({
            id: item.videoId, title: item.title,
            channel: item.channel, thumb: item.thumbnail,
            durationSec: item.durationSec ?? null,
            isOfficial: !!item.isOfficial,
            unavailable: !!item.unavailable,
            unavailableReason: item.unavailableReason || null,
          }))
          // Clips trop longs (compilations, lives, mix...) exclus de la
          // liste — pas juste signalés, on ne veut plus les voir du tout.
          .filter(v => v.durationSec == null || v.durationSec <= MAX_RESULT_DURATION_SEC);
        setResults(mapped);
        setShowResults(true);
      } else {
        // Le backend renvoie {error: "..."} (quota dépassé, clé manquante,
        // timeout...) plutôt qu'un tableau vide silencieux — on l'affiche
        // pour que "rien ne s'affiche" ait enfin une explication visible.
        setResults([]);
        setSearchError(data?.error || "Recherche YouTube indisponible.");
        setShowResults(true);
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error(e);
        setResults([]);
        setSearchError("Connexion au serveur perdue : " + e.message);
        setShowResults(true);
      }
    }
    if (!controller.signal.aborted) setSearching(false);
  };

  const handleQueryChange = (e) => {
    const q = e.target.value; setQuery(q);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => searchYouTube(q), 500);
  };

  // Extraction voix / instru (FLAC) — sondage du job jusqu'à "done"/"error".
  // Garde-fou : au-delà de 8 minutes (le chemin lent — re-téléchargement +
  // Demucs 2-stems sans cache — ne devrait normalement plus jamais être pris
  // une fois l'analyse terminée, mais reste possible en repli), on abandonne
  // plutôt que de laisser le bouton afficher "en cours" indéfiniment sans
  // aucun retour à l'utilisateur.
  const STEMS_MAX_POLL_MS = 8 * 60 * 1000;
  const pollStems = (jobId) => {
    if (stemsPollingRef.current) return;
    stemsPollingRef.current = true;
    const gen = generationRef.current;
    const startedAt = Date.now();
    const tick = async () => {
      if (gen !== generationRef.current) { stemsPollingRef.current = false; return; } // morceau changé entretemps
      try {
        const res = await fetch(`http://localhost:3001/api/stems/${jobId}/status`);
        const data = await res.json();
        if (gen !== generationRef.current) { stemsPollingRef.current = false; return; }
        if (!res.ok) { setStemsStatus("error"); setStemsError(data.error || "Job introuvable"); stemsPollingRef.current = false; return; }
        setStemsStatus(data.status);
        if (data.status === "error") setStemsError(data.message || "Erreur inconnue");
        if (data.status === "done") {
          // Remonte les URLs voix/instru au parent — utilisées par le cadre
          // "combos" (voix d'un deck + instru de l'autre) à gauche de Mes
          // MacheUps.
          if (onStemsReady) onStemsReady({ vocals: data.vocals, instrumental: data.instrumental });
        }
        if (data.status === "running") {
          if (Date.now() - startedAt > STEMS_MAX_POLL_MS) {
            setStemsStatus("error"); setStemsError("Délai dépassé — réessaie."); stemsPollingRef.current = false; return;
          }
          setTimeout(tick, 1500);
        } else stemsPollingRef.current = false;
      } catch (e) {
        if (gen !== generationRef.current) { stemsPollingRef.current = false; return; }
        setStemsStatus("error"); setStemsError(e.message); stemsPollingRef.current = false;
      }
    };
    tick();
  };

  // Paramètre "video" explicite (comme startAnalyzeFor) pour pouvoir être
  // appelée juste après une mise à jour d'état (sélection, ou fin d'analyse)
  // sans dépendre d'un re-render pas encore effectué.
  const startStemsFor = async (video) => {
    if (!video || stemsStatus === "running" || stemsStatus === "done") return;
    setStemsStatus("running"); setStemsError(null);
    try {
      const res = await fetch("http://localhost:3001/api/stems/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: video.id, title: video.title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Échec du lancement");
      setStemsJobId(data.jobId);
      stemsPollingRef.current = false;
      pollStems(data.jobId);
    } catch (e) {
      setStemsStatus("error"); setStemsError(e.message);
    }
  };

  // Bouton "↺ Réessayer" en cas d'erreur — réutilise l'état courant.
  const handleStartStems = () => startStemsFor(selectedVideo);

  // Analyse complète (BPM/clé/structure + 4 stems) pour le scoring de
  // compatibilité — vérifie d'abord le cache (/cached/:videoId) avant de
  // lancer un job, pour éviter de re-déclencher Demucs sur un morceau déjà
  // analysé précédemment (cache permanent côté serveur, SQLite).
  // Renvoie une Promise qui se résout seulement une fois le job terminé
  // (done OU error) — nécessaire pour que startAnalyzeFor puisse "attendre"
  // la fin réelle de l'analyse avant de relâcher le verrou partagé avec
  // l'autre Deck (cf. onAcquireAnalyzeLock).
  const pollAnalyze = (jobId) => new Promise((resolve) => {
    if (analyzePollingRef.current) { resolve(); return; }
    analyzePollingRef.current = true;
    const gen = generationRef.current;
    const tick = async () => {
      if (gen !== generationRef.current) { analyzePollingRef.current = false; resolve(); return; } // morceau changé entretemps
      try {
        const res = await fetch(`http://localhost:3001/api/analyze/${jobId}/status`);
        const data = await res.json();
        if (gen !== generationRef.current) { analyzePollingRef.current = false; resolve(); return; }
        if (!res.ok) { setAnalyzeStatus("error"); setAnalyzeError(data.error || "Job introuvable"); analyzePollingRef.current = false; resolve(); return; }
        if (data.status === "done") {
          setAnalyzeStatus("done"); setAnalyzeResult(data.track);
          if (onAnalyzed) onAnalyzed(data.track);
          analyzePollingRef.current = false;
          // Dès l'analyse terminée, dérive aussitôt voix/instru (FLAC) à
          // partir des 4 stems déjà séparés — quasi instantané (pas de 2e
          // Demucs), pour gagner le temps qu'aurait pris un clic manuel
          // séparé. data.track a la même forme que "selectedVideo" (id/title).
          startStemsFor(data.track);
          resolve();
        } else if (data.status === "error") {
          setAnalyzeStatus("error"); setAnalyzeError(data.message || "Erreur inconnue");
          analyzePollingRef.current = false;
          resolve();
        } else {
          setTimeout(tick, 2000);
        }
      } catch (e) {
        if (gen !== generationRef.current) { analyzePollingRef.current = false; resolve(); return; }
        setAnalyzeStatus("error"); setAnalyzeError(e.message); analyzePollingRef.current = false;
        resolve();
      }
    };
    tick();
  });

  // Prend "video" en paramètre explicite (plutôt que de lire l'état
  // "selectedVideo") pour pouvoir être appelée juste après setSelectedVideo()
  // dans handleSelect, sans dépendre du re-render React (qui n'aurait pas
  // encore appliqué la mise à jour à ce moment précis — closure obsolète).
  const startAnalyzeFor = async (video) => {
    if (!video) return;
    setAnalyzeStatus("running"); setAnalyzeError(null);
    try {
      // Cache d'abord : si déjà analysé DANS LE MÊME MODE (2/4 stems, cf.
      // sélecteur du cadre COMBO), pas besoin de relancer Demucs — appel
      // léger, pas besoin de passer par le verrou ci-dessous. Le serveur
      // renvoie 404 si le cache existe mais sous un AUTRE mode (cf.
      // routes/analyze.js) — on retombe alors sur l'analyse complète.
      const cachedRes = await fetch(`http://localhost:3001/api/analyze/cached/${video.id}?stemMode=${stemMode}`);
      if (cachedRes.ok) {
        const track = await cachedRes.json();
        setAnalyzeStatus("done"); setAnalyzeResult(track);
        if (onAnalyzed) onAnalyzed(track);
        startStemsFor(track);
        return;
      }

      // Pas en cache → analyse complète (téléchargement + Demucs 4 stems),
      // lourde en CPU/GPU. Passe par le verrou partagé avec l'autre Deck
      // (onAcquireAnalyzeLock, fourni par MashupStudio.jsx) pour ne JAMAIS
      // avoir les analyses A et B en cours en même temps — 2 process Demucs
      // simultanés (1 par deck) suffisent à saturer le CPU/GPU et faire
      // planter le process (même principe que la sérialisation déjà en place
      // entre piste A et B dans le Create Macheup, routes/mashup.js).
      const runAnalyzeJob = async () => {
        const res = await fetch("http://localhost:3001/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: video.id, title: video.title, stemMode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Échec du lancement");
        if (data.cached && data.track) {
          setAnalyzeStatus("done"); setAnalyzeResult(data.track);
          if (onAnalyzed) onAnalyzed(data.track);
          startStemsFor(data.track);
          return;
        }
        analyzePollingRef.current = false;
        await pollAnalyze(data.jobId);
      };

      if (onAcquireAnalyzeLock) await onAcquireAnalyzeLock(runAnalyzeJob);
      else await runAnalyzeJob();
    } catch (e) {
      setAnalyzeStatus("error"); setAnalyzeError(e.message);
    }
  };

  // Bouton "↺ Réessayer" en cas d'erreur — réutilise l'état courant.
  const handleStartAnalyze = () => startAnalyzeFor(selectedVideo);

  const handleSelect = (video) => {
    generationRef.current++; // invalide tout polling d'analyse/stems en vol pour l'ancien morceau
    searchAbortRef.current?.abort();
    clearTimeout(searchTimeout.current);
    setQuery(video.title); setShowResults(false); setResults([]);
    setSelectedVideo(video); setPlaying(false); setProgress(0);
    setAnalyzeStatus("idle"); setAnalyzeResult(null); setAnalyzeError(null);
    analyzePollingRef.current = false;
    if (onAnalyzed) onAnalyzed(null);
    // Analyse lancée automatiquement et en masqué dès la validation du choix
    // du clip — l'utilisateur n'a plus besoin de cliquer sur quoi que ce soit
    // (même esprit que la séparation auto. dans le Clip Editor).
    startAnalyzeFor(video);
    setStemsJobId(null); setStemsStatus("idle"); setStemsError(null);
    stemsPollingRef.current = false;
    if (onStemsReady) onStemsReady(null);
    if (onLoaded) onLoaded({ type: "youtube", ...video });
  };

  // ── Préchargement externe (Mashup Wheel → "Envoyer en Deck B") ──
  // Permet à une page tierce de faire sélectionner automatiquement une vidéo
  // précise à ce Deck, exactement comme si l'utilisateur l'avait choisie dans
  // le moteur de recherche — même chemin (handleSelect), aucune duplication
  // de logique. presetAppliedRef évite de rejouer handleSelect en boucle à
  // chaque re-render (seulement quand l'id proposé change réellement).
  const presetAppliedRef = useRef(null);
  useEffect(() => {
    if (presetVideo && presetVideo.id !== presetAppliedRef.current) {
      presetAppliedRef.current = presetVideo.id;
      handleSelect(presetVideo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetVideo]);

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (f) {
      generationRef.current++; // invalide tout polling d'analyse/stems en vol pour l'ancien morceau
      clearTimeout(searchTimeout.current);
      searchAbortRef.current?.abort();
      setSelectedVideo(null);
      setResults([]);
      setShowResults(false);
      setSearching(false);
      setQuery(f.name);
      setStemsJobId(null); setStemsStatus("idle"); setStemsError(null);
      stemsPollingRef.current = false;
      setAnalyzeStatus("idle"); setAnalyzeResult(null); setAnalyzeError(null);
      analyzePollingRef.current = false;
      if (onAnalyzed) onAnalyzed(null);
      if (onStemsReady) onStemsReady(null);
      if (onLoaded) onLoaded({ type: "file", file: f });
    }
  };

  const togglePlay = () => {
    if (selectedVideo && playerRef.current) {
      playing ? playerRef.current.pauseVideo() : playerRef.current.playVideo();
      return;
    }
    if (audioRef.current && file) {
      // Resume AudioContext on first user gesture
      if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
      if (playing) { audioRef.current.pause(); setPlaying(false); }
      else         { audioRef.current.play();  setPlaying(true); }
    }
  };


  const handleSeek = (e) => {
    const val = parseFloat(e.target.value); setProgress(val);
    if (selectedVideo && playerRef.current) {
      const dur = playerRef.current.getDuration();
      if (dur) playerRef.current.seekTo(val * dur, true);
    } else if (audioRef.current?.duration) {
      audioRef.current.currentTime = val * audioRef.current.duration;
    }
  };

  const handleVolumeChange = (e) => {
    const v = parseFloat(e.target.value); setVolume(v);
    if (playerRef.current?.setVolume) playerRef.current.setVolume(v);
    if (audioRef.current) audioRef.current.volume = v / 100;
  };

  // ── Shazam / reconnaissance audio ──────────────────────────────
  const handleRecognize = async () => {
    setRecognizeResult(null);
    setRecognizeError(null);

    // Pour un fichier local : envoyer les 800 premiers Ko (≈10-20s MP3)
    if (file) {
      setRecognizing(true);
      try {
        const slice = file.slice(0, 800 * 1024);
        const blob  = new Blob([slice], { type: file.type || "audio/mpeg" });
        const fd = new FormData();
        fd.append("audio", blob, file.name);
        const res  = await fetch("http://localhost:3001/api/recognize", { method: "POST", body: fd });
        const data = await res.json();
        if (data.found) setRecognizeResult(data);
        else setRecognizeError(data.message || "Chanson non reconnue");
      } catch (e) {
        setRecognizeError("Erreur réseau : " + e.message);
      }
      setRecognizing(false);
      return;
    }

    // Pour une vidéo YouTube : l'identité est déjà connue, afficher les infos
    if (selectedVideo) {
      setRecognizeResult({
        found:   true,
        title:   selectedVideo.title,
        artist:  selectedVideo.channel,
        album:   null,
        artwork: selectedVideo.thumb,
        fromYT:  true,
      });
    }
  };
  // ────────────────────────────────────────────────────────────────

  const handleClear = () => {
    generationRef.current++; // invalide tout polling d'analyse/stems en vol pour l'ancien morceau
    // Si le player YouTube n'est pas encore "ready" (ou a déjà été détruit),
    // stopVideo()/destroy() peuvent lever une exception — sans ce try/catch,
    // ça interrompait le reste de la fonction et AUCUN état n'était remis à
    // zéro (d'où le bouton 🗑 qui semblait ne rien faire : le player restait
    // affiché car setSelectedVideo(null) n'était jamais atteint).
    try {
      if (playerRef.current) {
        if (typeof playerRef.current.destroy === "function") playerRef.current.destroy();
        else if (typeof playerRef.current.stopVideo === "function") playerRef.current.stopVideo();
      }
    } catch (e) { console.warn("Erreur fermeture player YouTube:", e); }
    playerRef.current = null;

    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; }
    cancelAnimationFrame(animFrameRef.current);
    clearTimeout(searchTimeout.current);
    searchAbortRef.current?.abort();
    setPlaying(false); setProgress(0); setQuery(""); setResults([]);
    setShowResults(false); setSelectedVideo(null);
    // Efface aussi les jobs/éléments temporaires en cours (séparation stems,
    // analyse BPM/clé, identification Shazam) — sinon ils restent affichés
    // pour le morceau qui vient d'être effacé.
    setStemsJobId(null); setStemsStatus("idle"); setStemsError(null);
    stemsPollingRef.current = false;
    setAnalyzeStatus("idle"); setAnalyzeResult(null); setAnalyzeError(null);
    analyzePollingRef.current = false;
    setRecognizeResult(null); setRecognizeError(null);
    if (onAnalyzed) onAnalyzed(null);
    if (onStemsReady) onStemsReady(null);
    if (onLoaded) onLoaded(null);
    // BUG "la démo ne se relance pas" (juillet 2026) : presetAppliedRef (cf.
    // plus bas) retient l'id de la dernière vidéo appliquée via presetVideo
    // pour éviter de rejouer handleSelect en boucle à chaque re-render. Mais
    // rien ne le remettait à zéro ici — donc après un changement de mode
    // 2/4 stems (qui vide les Decks via handleTogglePower→turnOff→handleClear,
    // cf. MashupStudio.jsx) ou un clic sur 🗑, recliquer sur DEMO avec les
    // MÊMES morceaux (même id) ne redéclenchait plus rien : le Deck restait
    // vide, l'utilisateur avait l'impression que "la démo ne se lance pas".
    presetAppliedRef.current = null;
  };

  const fmt = (s) => {
    if (!s || isNaN(s)) return "0:00";
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  };

  // Liste affichée dans le dropdown : résultats bruts, ou seulement les
  // clips ✓ OFFICIEL si le filtre est actif (cf. checkbox ci-dessous).
  const visibleResults = officialOnly ? results.filter(v => v.isOfficial) : results;

  const duration    = selectedVideo && playerRef.current?.getDuration    ? playerRef.current.getDuration()    : (audioRef.current?.duration    || 0);
  const currentTime = selectedVideo && playerRef.current?.getCurrentTime ? playerRef.current.getCurrentTime() : (audioRef.current?.currentTime || 0);

  // Cible utilisée par Lyrics / Prompt Suno : la vidéo YouTube sélectionnée,
  // ou sinon le morceau identifié par Shazam (fichier local reconnu).
  const lyricsTarget = selectedVideo
    ? selectedVideo
    : (recognizeResult?.found ? { title: recognizeResult.title, channel: recognizeResult.artist } : null);

  // Préchargement silencieux des Lyrics + Prompt Suno dès qu'un morceau est identifié,
  // pour que l'ouverture des modals soit instantanée (pas d'attente visible).
  useEffect(() => {
    if (lyricsTarget?.title) prefetchMedia(lyricsTarget.title, lyricsTarget.channel);
  }, [lyricsTarget?.title, lyricsTarget?.channel]);

  return (
    <div className={`deck deck-${color}`} style={{ position: "relative" }}>
      <audio ref={audioRef}
        onTimeUpdate={() => { if (audioRef.current?.duration) setProgress(audioRef.current.currentTime / audioRef.current.duration); }}
        onEnded={() => setPlaying(false)} />

      {/* Deck éteint via le bouton ON/OFF du Mixer : verrouille toute
          interaction (recherche, lecture, boutons) et l'indique clairement,
          plutôt que de simplement vider le deck sans explication. */}
      {disabled && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 5, borderRadius: 14,
          background: "rgba(5,5,5,0.72)", backdropFilter: "blur(1px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 16px", borderRadius: 8,
            border: "1px solid rgba(255,80,80,0.35)", background: "rgba(255,80,80,0.08)",
            color: "#ff8080", fontFamily: "Orbitron,sans-serif", fontSize: 13,
            fontWeight: 800, letterSpacing: 2,
          }}>⏻ DECK {displayLabel} ÉTEINT</div>
        </div>
      )}

      <div className="deck-inner" style={{ pointerEvents: disabled ? "none" : "auto" }}>
        {/* Header */}
        <div className="deck-header">
          <div className="deck-label">
            <span className="deck-dot" />
            DECK {displayLabel} · {color.toUpperCase()}
          </div>
          <div className="deck-header-right">
            <button className="deck-trash" onClick={handleClear}>🗑</button>
            <div className="deck-letter">{displayLabel}</div>
          </div>
        </div>

        {/* Search */}
        <div className="search-label">Artiste / Chanson Search</div>
        <div style={{ position: "relative" }}>
          <div className="search-row">
            <input type="text" placeholder="Cherche un titre, artiste, ou c..."
              value={query} onChange={handleQueryChange}
              onFocus={() => results.length > 0 && setShowResults(true)} />
            {!hideUpload && (
              <label className="charge-btn charge-btn-big">
                ⬇ UPLOAD TON TRACK
                <input type="file" accept="audio/*" onChange={handleFileChange} style={{ display: "none" }} />
              </label>
            )}
          </div>

          {showResults && (
            <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#0f0f0f", border:`1px solid ${accentColor}33`, borderRadius:8, zIndex:50, maxHeight:320, overflowY:"auto", boxShadow:"0 8px 32px rgba(0,0,0,0.8)" }}>
              {/* Filtre "Officiels uniquement" — n'apparaît que s'il y a des
                  résultats à filtrer, pour ne pas encombrer les états
                  recherche/erreur/vide. */}
              {!searching && !searchError && results.length > 0 && (
                <label style={{ display:"flex", alignItems:"center", gap:6, padding:"7px 12px",
                  borderBottom:"1px solid #1a1a1a", fontSize:11, fontWeight:700, color: officialOnly ? "var(--green)" : "#888",
                  cursor:"pointer", userSelect:"none", position:"sticky", top:0, background:"#0f0f0f", zIndex:1 }}>
                  <input type="checkbox" checked={officialOnly} onChange={e => setOfficialOnly(e.target.checked)}
                    style={{ accentColor: "var(--green)", cursor:"pointer" }} />
                  ✓ Officiels uniquement <span style={{ opacity:0.6, fontWeight:400 }}>(meilleure source audio pour la séparation)</span>
                </label>
              )}
              {searching && <div style={{ padding:"12px 14px", color:"#444", fontSize: 14 }}>Recherche...</div>}
              {!searching && searchError && (
                <div style={{ padding:"12px 14px", color:"#ff6666", fontSize: 13 }}>⚠ {searchError}</div>
              )}
              {!searching && !searchError && results.length === 0 && query.length >= 2 && (
                <div style={{ padding:"12px 14px", color:"#444", fontSize: 13 }}>Aucun résultat.</div>
              )}
              {!searching && !searchError && results.length > 0 && visibleResults.length === 0 && (
                <div style={{ padding:"12px 14px", color:"#444", fontSize: 13 }}>Aucun clip officiel trouvé — désactive le filtre pour voir les autres résultats.</div>
              )}
              {visibleResults.map(video => (
                <div key={video.id} onClick={() => { if (!video.unavailable) handleSelect(video); }}
                  title={video.unavailable ? video.unavailableReason : undefined}
                  style={{ display:"flex", gap:10, padding:"8px 12px", cursor: video.unavailable ? "not-allowed" : "pointer",
                    borderBottom:"1px solid #111", opacity: video.unavailable ? 0.45 : 1 }}
                  onMouseEnter={e=>{ if (!video.unavailable) e.currentTarget.style.background="#1a1a1a"; }}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{ position:"relative", flexShrink:0 }}>
                    <img src={video.thumb} alt="" style={{ width:60, height:45, objectFit:"cover", borderRadius:4 }} />
                    {video.durationSec != null && (
                      <span style={{ position:"absolute", bottom:2, right:2, background:"rgba(0,0,0,0.85)", color:"#fff",
                        fontSize:9, fontWeight:700, padding:"1px 4px", borderRadius:3 }}>{formatDuration(video.durationSec)}</span>
                    )}
                  </div>
                  <div style={{ overflow:"hidden", flex:1 }}>
                    <div style={{ fontSize: 14, fontWeight:600, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", color:"white" }}>{video.title}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:2 }}>
                      <span style={{ fontSize: 12, color:accentColor, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{video.channel}</span>
                      {video.isOfficial && (
                        <span style={{ fontSize:9, fontWeight:700, color:"var(--green)", border:"1px solid rgba(170,255,0,0.4)",
                          borderRadius:3, padding:"0 4px", flexShrink:0 }}>✓ OFFICIEL</span>
                      )}
                    </div>
                    {video.unavailable && (
                      <div style={{ fontSize:10, color:"#ff6666", marginTop:2 }}>⛔ {video.unavailableReason}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Video / Visualizer + Vol */}
        <div className="deck-content-row">
          <div className="deck-main">
            {selectedVideo ? (
              /* YouTube iframe — hauteur alignée sur celle du sélecteur de
                 volume (qui s'etire pour remplir tout .deck-content-row) :
                 plus de hauteur fixe en dur, on s'etire pareil via height:100%
                 + minHeight:185 (meme plancher que le placeholder ci-dessous —
                 réduit pour que les cadres tiennent sans dépasser de la page). */
              <div className="waveform-area" style={{ height:"100%", minHeight:185, position:"relative", overflow:"hidden", background:"#000" }}>
                <div id={iframeContainerId} style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%" }} />
              </div>
            ) : (
              /* Audio visualizer canvas — même comportement de hauteur que ci-dessus */
              <div className="waveform-area" style={{ height:"100%", minHeight:185, position:"relative", background: file ? "rgba(0,0,0,0.7)" : "rgba(0,0,0,0.4)", borderRadius:8, overflow:"hidden" }}>
                {file ? (
                  <canvas
                    ref={canvasRef}
                    style={{ position:"absolute", inset:0, width:"100%", height:"100%", display:"block" }}
                  />
                ) : (
                  /* Empty state */
                  <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:6 }}>
                    <div style={{ fontFamily:"Orbitron,sans-serif", fontSize: 24, fontWeight:900,
                      color:accentColor, opacity:0.12, letterSpacing:4 }}>DECK {displayLabel}</div>
                    <div style={{ fontSize: 11, color:"#333", letterSpacing:2 }}>CHARGE UN FICHIER OU CHERCHE</div>
                  </div>
                )}

                {/* Playing glow overlay */}
                {file && playing && (
                  <div style={{
                    position:"absolute", inset:0, pointerEvents:"none",
                    background: `radial-gradient(ellipse at 50% 100%, ${accentColor}18 0%, transparent 70%)`,
                  }} />
                )}
              </div>
            )}
          </div>

          <div className="vol-slider-wrap">
            <div className="vol-icon">{volume == 0 ? "🔇" : volume < 50 ? "🔉" : "🔊"}</div>
            <div className="vol-track-wrap">
              <div className="vol-track-fill" style={{ height: `${volume}%` }} />
              <div className="vol-ticks">
                {[0,1,2,3,4].map(i => <span key={i} />)}
              </div>
              <input type="range" className="vol-slider"
                min="0" max="100" step="1" value={volume}
                onChange={handleVolumeChange} />
            </div>
          </div>
        </div>

        {/* Progress */}
        <div className="progress-row">
          <span className="progress-time">{fmt(currentTime)}</span>
          <input type="range" className="progress-bar"
            min="0" max="1" step="0.001" value={progress} onChange={handleSeek} />
          <span className="progress-time">–</span>
          <span className="progress-time">{fmt(duration)}</span>
        </div>

        {/* ── Cadre Outils : Lyrics / Prompt Suno / Shazam + analyse ──
            Regroupés ici juste sous la barre de lecture. */}
        <div className="deck-tools-frame">
          <div className="deck-footer" style={{ marginBottom: selectedVideo ? 8 : 0 }}>
            <button className="ghost-btn"
              onClick={() => lyricsTarget && setShowLyrics(true)}
              disabled={!lyricsTarget}>
              📄 LYRICS
            </button>
            <button className="ghost-btn"
              onClick={() => lyricsTarget && setShowSuno(true)}
              disabled={!lyricsTarget}>
              ✦ PROMPT SUNO
            </button>
            <button
              className="ghost-btn"
              onClick={handleRecognize}
              disabled={!file && !selectedVideo}
              title="Identifier cette chanson (Shazam)"
              style={{
                borderColor: recognizeResult ? `${accentColor}55` : undefined,
                color: recognizeResult ? accentColor : undefined,
              }}
            >
              {recognizing ? "…" : "⬡ Shazam"}
            </button>
          </div>

          {/* Analyse complète (BPM/clé/structure) pour le scoring de
              compatibilité entre Deck A et Deck B, affiché dans le Mixer.
              Pleine largeur tant qu'elle n'est pas terminée (idle/en
              cours/erreur — le texte est trop long pour un badge compact).
              Une fois "done", le résultat devient un badge compact fusionné
              avec la ligne Voix/Instru FLAC juste en dessous (cf. bloc
              suivant) au lieu d'occuper sa propre ligne pleine largeur — ça
              économise une rangée entière de hauteur dans le deck après une
              analyse, justement la cause du scroll de page en trop. */}
          {selectedVideo && analyzeStatus !== "done" && (
            <button type="button"
              disabled={analyzeStatus === "running"}
              onClick={handleStartAnalyze}
              title={analyzeStatus === "error" ? `Erreur : ${analyzeError || "réessaie"}` : "Analyser le morceau (BPM, clé, structure) pour le score de compatibilité"}
              style={{ width: "100%", padding: "6px 0", borderRadius: 6, fontSize: 11, fontWeight: 700,
                border: `1px solid ${analyzeStatus === "error" ? "rgba(255,80,80,0.35)" : "rgba(255,255,255,0.12)"}`,
                background: analyzeStatus === "error" ? "rgba(255,80,80,0.08)" : "rgba(255,255,255,0.03)",
                color: analyzeStatus === "error" ? "#ff8080" : "var(--muted2)",
                cursor: analyzeStatus === "running" ? "default" : "pointer", opacity: analyzeStatus === "running" ? 0.6 : 1 }}>
              {analyzeStatus === "running" ? "⏳ Analyse en cours…"
                : analyzeStatus === "error" ? "↺ Réessayer l'analyse"
                : "🧬 Analyser (BPM/clé/structure)"}
            </button>
          )}

          {/* Extraction voix / instru (FLAC) — un seul job Demucs partagé pour
              les 2 boutons : peu importe lequel déclenche la séparation, l'autre
              stem devient disponible en même temps. Le badge BPM/clé (une fois
              l'analyse terminée) rejoint cette même ligne, à gauche des 2
              boutons FLAC, au lieu d'une ligne séparée. */}
          {selectedVideo && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {analyzeStatus === "done" && (
                <button type="button" onClick={handleStartAnalyze}
                  title="Relancer l'analyse (BPM, clé, structure)"
                  style={{
                    flexShrink: 0, whiteSpace: "nowrap", padding: "6px 10px", borderRadius: 6,
                    fontSize: 11, fontWeight: 700,
                    border: "1px solid rgba(0,234,255,0.35)", background: "rgba(0,234,255,0.08)",
                    color: "var(--cyan)", cursor: "pointer",
                  }}>
                  ✅ {analyzeResult?.bpm ?? "?"} BPM · {analyzeResult?.camelot ?? "?"}
                </button>
              )}
              {["vocals", "instrumental"].map((which) => {
                const label = which === "vocals" ? "🎤 Voix" : "🎹 Instru";
                const isDone = stemsStatus === "done";
                const isRunning = stemsStatus === "running";
                const isError = stemsStatus === "error";
                // Tant que l'analyse (BPM/clé/structure) n'est pas terminée, on
                // bloque ces boutons : cliquer pendant l'analyse relançait un 2e
                // Demucs indépendant en parallèle de celui de l'analyse — les 2
                // se battaient pour le même GPU (souvent unique sur la machine),
                // l'un basculait sur CPU (beaucoup plus lent), et le bouton
                // restait affiché "en cours" pendant un temps qui semblait
                // infini. En attendant la fin de l'analyse, le job dérivé (ultra
                // rapide, sans 2e Demucs) est garanti d'être utilisé.
                const waitingForAnalysis = analyzeStatus === "running" && !isDone && !isRunning && !isError;
                const disabled = isRunning || waitingForAnalysis;
                return (
                  <button key={which} type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (isDone && stemsJobId) {
                        triggerDownload(`http://localhost:3001/api/stems/${stemsJobId}/download/${which}`);
                      } else if (!disabled) {
                        handleStartStems();
                      }
                    }}
                    title={waitingForAnalysis ? "Patiente : l'extraction démarrera automatiquement dès la fin de l'analyse"
                      : isError ? `Erreur : ${stemsError || "réessaie"}`
                      : isDone ? `Télécharger (${which === "vocals" ? "voix" : "instrumental"}, FLAC)`
                      : "Extraire voix + instrumental (FLAC)"}
                    style={{ flex: 1, padding: "6px 0", borderRadius: 6, fontSize: 11, fontWeight: 700,
                      border: `1px solid ${isDone ? "rgba(170,255,0,0.35)" : isError ? "rgba(255,80,80,0.35)" : "rgba(255,255,255,0.12)"}`,
                      background: isDone ? "rgba(170,255,0,0.08)" : isError ? "rgba(255,80,80,0.08)" : "rgba(255,255,255,0.03)",
                      color: isDone ? "var(--green)" : isError ? "#ff8080" : "var(--muted2)",
                      cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}>
                    {isRunning ? "⏳ Séparation…" : waitingForAnalysis ? "⏳ Attente analyse…" : isDone ? `⬇ ${label} (FLAC)` : isError ? "↺ Réessayer" : `${label} (FLAC)`}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Lyrics / Prompt Suno — fenêtres flottantes fermables (LyricsModal/
            PromptSunoModal gèrent elles-mêmes leur overlay plein écran) ;
            fonctionnent identiquement quel que soit le Deck/la page (Studio,
            Mashup Wheel...) puisque ce composant Deck est partagé partout. */}
        {showLyrics && <LyricsModal video={lyricsTarget} onClose={() => setShowLyrics(false)} />}
        {showSuno   && <PromptSunoModal video={lyricsTarget} onClose={() => setShowSuno(false)} />}

        {/* ── Fenêtre flottante résultat Shazam (retour utilisateur, juillet
            2026 : Lyrics/Prompt Suno/Shazam doivent TOUS les 3 s'ouvrir en
            fenêtres flottantes fermables, pas inline dans le Deck) — même
            overlay plein écran que LyricsModal/PromptSunoModal, fermable via
            ✕ ou clic à l'extérieur. */}
        {(recognizeResult || recognizeError) && (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
            onClick={() => { setRecognizeResult(null); setRecognizeError(null); }}
          >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#0c0c0c",
              border: `1px solid ${recognizeError ? "rgba(255,80,80,0.25)" : accentColor + "33"}`,
              borderRadius: 14,
              padding: "20px 22px",
              width: 420, maxWidth: "90vw",
              position: "relative",
              boxShadow: "0 20px 60px rgba(0,0,0,0.8)",
              animation: "fadeIn 0.2s ease",
            }}>
            <button onClick={() => { setRecognizeResult(null); setRecognizeError(null); }} style={{
              position: "absolute", top: 10, right: 12,
              background: "transparent", border: "1px solid #333", color: "#555", borderRadius: 6,
              width: 28, height: 28, cursor: "pointer", fontSize: 15, lineHeight: 1,
            }}
            onMouseEnter={e => e.currentTarget.style.color = "white"}
            onMouseLeave={e => e.currentTarget.style.color = "#555"}
            >✕</button>

            {recognizeError && (
              <div style={{ fontSize: 13, color: "#ff6666", paddingRight: 16 }}>
                🔍 {recognizeError}
              </div>
            )}

            {recognizeResult && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", paddingRight: 20 }}>
                {recognizeResult.artwork && (
                  <img src={recognizeResult.artwork} alt="cover"
                    style={{ width: 46, height: 46, borderRadius: 6, objectFit: "cover", flexShrink: 0,
                      border: `1px solid ${accentColor}33` }} />
                )}
                <div style={{ minWidth: 0 }}>
                  {recognizeResult.fromYT && (
                    <div style={{ fontSize: 10, color: accentColor, letterSpacing: 2,
                      textTransform: "uppercase", marginBottom: 3 }}>Info YouTube</div>
                  )}
                  {!recognizeResult.fromYT && (
                    <div style={{ fontSize: 10, color: accentColor, letterSpacing: 2,
                      textTransform: "uppercase", marginBottom: 3 }}>✓ Reconnu</div>
                  )}
                  <div style={{ fontSize: 14, fontWeight: 700, color: "white",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {recognizeResult.title}
                  </div>
                  <div style={{ fontSize: 12, color: accentColor, marginTop: 2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {recognizeResult.artist}
                  </div>
                  {recognizeResult.album && (
                    <div style={{ fontSize: 11, color: "#555", marginTop: 2,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {recognizeResult.album}
                      {recognizeResult.releaseDate ? ` · ${recognizeResult.releaseDate.slice(0,4)}` : ""}
                    </div>
                  )}

                  {/* Lyrics / Prompt Suno à partir du morceau identifié */}
                  {recognizeResult.title && (
                    <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                      <button onClick={() => setShowLyrics(true)}
                        style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                          background: `${accentColor}1f`, color: accentColor,
                          border: `1px solid ${accentColor}55`, cursor: "pointer",
                          letterSpacing: 1, whiteSpace: "nowrap" }}>
                        📄 Lyrics
                      </button>
                      <button onClick={() => setShowSuno(true)}
                        style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                          background: `${accentColor}1f`, color: accentColor,
                          border: `1px solid ${accentColor}55`, cursor: "pointer",
                          letterSpacing: 1, whiteSpace: "nowrap" }}>
                        ✦ Prompt Suno
                      </button>
                    </div>
                  )}
                  {/* Streaming links */}
                  {recognizeResult.title && !recognizeResult.fromYT && (() => {
                    const q = encodeURIComponent(`${recognizeResult.artist || ""} ${recognizeResult.title}`);
                    return (
                      <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                        <a href={`https://open.spotify.com/search/${q}`} target="_blank" rel="noreferrer"
                          style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                            background: "rgba(30,215,96,0.15)", color: "#1ed760",
                            border: "1px solid rgba(30,215,96,0.35)", textDecoration: "none",
                            letterSpacing: 1, whiteSpace: "nowrap" }}>
                          ▶ Spotify
                        </a>
                        <a href={`https://www.deezer.com/search/${q}`} target="_blank" rel="noreferrer"
                          style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                            background: "rgba(161,100,255,0.15)", color: "#a164ff",
                            border: "1px solid rgba(161,100,255,0.35)", textDecoration: "none",
                            letterSpacing: 1, whiteSpace: "nowrap" }}>
                          ▶ Deezer
                        </a>
                        <a href={`https://www.youtube.com/results?search_query=${q}`} target="_blank" rel="noreferrer"
                          style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                            background: "rgba(255,0,0,0.12)", color: "#ff4e4e",
                            border: "1px solid rgba(255,60,60,0.35)", textDecoration: "none",
                            letterSpacing: 1, whiteSpace: "nowrap" }}>
                          ▶ YouTube
                        </a>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(-4px) } to { opacity:1; transform:none } }`}</style>
          </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default Deck;
