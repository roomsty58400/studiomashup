import React, { useState, useRef, useEffect } from "react";
import { PitchShifter } from "soundtouchjs";
import { registerPlayer, notifyPlaying } from "../utils/mediaCoordinator.js";

// Cadre "COMBO" — à gauche de Mes MacheUps, sous le Deck A.
//
// Contenait auparavant les 4 combos croisés voix/instru (A, B, DUO_A, DUO_B)
// + un gros bouton "play" jaune pour créer un mashup personnalisé à partir du
// combo sélectionné. Remplacé (retour utilisateur, juillet 2026) par la
// fonction "MASHUP À LA CARTE" — déplacée ici depuis Mixer.jsx — qui permet un
// contrôle bien plus fin : choisir INDÉPENDAMMENT, pour chacun des stems
// Demucs, s'il vient du Deck A ou du Deck B, plutôt que de se limiter aux 4
// combinaisons figées d'avant. L'ancienne génération auto des 4 combos
// (comboA/B/DuoA/DuoB) a été retirée de MashupStudio.jsx en même temps (plus
// rien ne l'affichait).
//
// Sélecteur 2/4 stems : le nombre de stems séparés par Demucs par morceau
// est choisi ici (stemMode, remonté au parent via onStemModeChange). La
// grille "à la carte" s'adapte à ce choix :
//  - mode 4 (standard)     : voix, batterie, basse, autres
//  - mode 2 (instru complet) : Demucs ne sépare QUE voix/instrumental — pas
//    de grille, message d'explication à la place.
//
// Le mode 6 stems (guitare/piano séparés) a été retiré (retour utilisateur,
// juillet 2026) : le modèle htdemucs_6s sous-jacent est un modèle unique non
// "bagué" et documenté par les auteurs de Demucs comme moins abouti (plus de
// bruit/bleed, y compris sur voix/batterie/basse) que htdemucs_ft utilisé en
// mode 4 — un compromis qui n'en valait pas la peine pour l'app.
//
// 4 états par stem : 🔇 Muet / A / A+B / B, RÉELLEMENT appliqués jusqu'à la
// génération finale (routes/mashup.js, mode "stems" — cf. alignAndCombineStems
// dans services/ffmpeg.js pour "A+B").
//
// ── REFONTE JUILLET 2026 (retour utilisateur : "j'ai un problème de
// compréhension et d'organisation avec le cadre COMBO... garder l'esprit
// montage ingénieur du son en ayant un choix des modes et aides") ──────────
// 3 changements structurants par rapport à la version précédente :
//
// 1) RÉORGANISATION EN "MODULES" façon console de mixage — chaque bloc
//    (mode, IA-DJA, durée, grille de stems, clé/BPM, player, génération) a
//    maintenant son propre encadré visuel plutôt qu'une simple suite de
//    contrôles empilés, pour rendre la hiérarchie plus lisible d'un coup
//    d'œil (comme des channel strips), sans rien retirer de la finesse de
//    contrôle déjà en place.
//
// 2) CLÉ/BPM PROMU AU PREMIER PLAN ET RENDU RÉELLEMENT ÉCOUTABLE — avant,
//    ces réglages étaient cachés dans un accordéon replié tout en bas, et
//    leur propre texte prévenait qu'ils "n'affectent PAS l'aperçu" (seule la
//    génération finale, plusieurs minutes plus tard, permettait de juger du
//    résultat). Le moteur d'aperçu passe donc ici d'une lecture <audio> brute
//    à un vrai moteur Web Audio (soundtouchjs, licence MIT) : la voix est
//    RÉELLEMENT pitchée (demi-tons) et l'instrumental RÉELLEMENT étiré en
//    tempo dans le navigateur, EN DIRECT (curseur bougé pendant l'écoute =
//    effet audible immédiatement) — exactement le même découpage
//    pitch(voix)/tempo(instru) que le moteur serveur (mixFullRave/Duo, cf.
//    services/ffmpeg.js). Contrepartie assumée : il faut télécharger et
//    décoder le fichier ENTIER d'un stem avant de pouvoir le pitcher (~1-2s
//    la première fois, mis en cache ensuite), et ça consomme plus de RAM/CPU
//    que la lecture <audio> directe d'avant — acceptable pour un aperçu de
//    quelques stems à la fois, à garder en tête sur une machine modeste avec
//    beaucoup de stems actifs simultanément.
//    Ce changement de moteur permet aussi de SIMPLIFIER la gestion d'erreur :
//    plus de fetch "eager" au montage (source d'un ancien bug de case rouge
//    récurrent), le fichier n'est demandé qu'au moment réel où on appuie sur
//    play.
//
// 3) IA-DJA COMPACTÉ EN BOUTON + PANNEAU DE SUGGESTIONS MULTIPLES — avant,
//    un unique gros bouton lançait un calcul et appliquait DIRECTEMENT une
//    seule combinaison recommandée aux réglages, sans autre choix. Devenu un
//    petit bouton "🧠 IA·DJA" (légende au survol façon platine DJ, cf.
//    data-tooltip), qui ouvre un panneau proposant 3 pistes de départ
//    différentes (Prudent / Équilibré / Audacieux) à comparer — cliquer une
//    carte la sélectionne/surligne SANS toucher aux réglages ; il faut
//    valider avec "✓ Appliquer cette combi" pour l'appliquer réellement à la
//    grille de stems (qui reste, comme avant, librement modifiable ensuite).

// Base des URLs de stems servies par le backend (/outputs/analyze/<videoId>/...,
// cf. routes/analyze.js).
const API_BASE = "http://localhost:3001";

// ── Helpers clé/tempo pour l'aperçu "Superposition complète" (juillet 2026) ──
// Reproduction volontairement SIMPLIFIÉE, côté client, de deux petits
// morceaux de services/ffmpeg.js (semitoneShift + safeTempoRatio) — juste
// assez pour donner une idée honnête à l'oreille de l'écart tempo/tonalité
// entre A et B AVANT de générer, pas une reproduction exacte du moteur
// serveur (qui, lui, applique en plus un plan de tempo par segment et une
// logique "roue de Camelot" tenant compte majeur/mineur — cf. mixFullOverlay).
// PITCHES doit rester synchronisé avec la liste Python de services/analyzer.js.
const PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitchIndex = (name) => { const i = PITCHES.indexOf(name); return i === -1 ? null : i; };
// Décalage en demi-tons (borné à [-6,6]) à appliquer à "from" pour rejoindre
// "to" — même sémantique que semitoneShift() dans services/ffmpeg.js.
const semitoneShiftClient = (from, to) => {
  const i = pitchIndex(from), j = pitchIndex(to);
  if (i === null || j === null) return 0;
  let diff = (j - i) % 12;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
};
// Même fenêtre de sécurité que safeTempoRatio() côté serveur en repli
// "atempo" (sans rubberband, cf. ffmpeg.js) : au-delà, l'écart est jugé trop
// grand pour un étirement propre — on n'applique alors AUCUN changement de
// tempo plutôt qu'un résultat dégradé/artificiel dans l'aperçu.
const OVERLAY_TEMPO_SAFE = [0.72, 1.4];
const safeTempoRatioClient = (bpmA, bpmB) => {
  if (!bpmA || !bpmB || bpmA <= 0 || bpmB <= 0) return 1;
  const raw = bpmA / bpmB;
  const candidates = [raw, raw * 2, raw / 2];
  const best = candidates.reduce((a, b) => Math.abs(Math.log2(b)) < Math.abs(Math.log2(a)) ? b : a);
  if (best < OVERLAY_TEMPO_SAFE[0] || best > OVERLAY_TEMPO_SAFE[1]) return 1;
  return best;
};
// Décalage de hauteur B→A, plafonné à ±2 demi-tons (même seuil que
// MAX_FULL_MIX_SHIFT dans mixFullOverlay) — au-delà, 0 (pas de transposition)
// plutôt qu'un décalage trop audible/artificiel pour un simple aperçu.
const OVERLAY_MAX_SHIFT = 2;
const overlayShiftClient = (keyB, keyA) => {
  const shift = semitoneShiftClient(keyB, keyA);
  return Math.abs(shift) <= OVERLAY_MAX_SHIFT ? shift : 0;
};

// Liste ordonnée [clé, emoji+libellé] des stems à afficher dans la grille "à
// la carte", selon le mode Demucs choisi. Les clés correspondent exactement
// aux colonnes DB `${clé}_path` (cf. STEM_MODE_NAMES dans services/demucs.js).
const PARTS_BY_MODE = {
  4: [
    ["vocals", "🎤 Voix"],
    ["drums", "🥁 Batterie"],
    ["bass", "🎸 Basse"],
    ["other", "🎹 Autres"],
  ],
};

const STEM_LABELS = {
  vocals: "voix", drums: "batterie", bass: "basse", other: "autres", instrumental: "instrumental",
};

const MODE_INFO = {
  2: { short: "2", title: "2 stems (instru complet)" },
  4: { short: "4", title: "4 stems (standard)" },
};

// Les 4 états possibles pour un stem — appliqués RÉELLEMENT à la génération
// finale (routes/mashup.js, mode "stems") : "mute" = ce stem est absent du
// mashup final, "AB" = les 2 morceaux sont RÉELLEMENT combinés pour ce stem
// (alignés tempo/tonalité côté serveur avant mixage — cf.
// alignAndCombineStems dans services/ffmpeg.js).
const STEM_STATES = [
  { key: "mute", glyph: "🔇", width: 24, activeBg: "rgba(255,255,255,0.14)", activeColor: "var(--muted2)", title: "Muet — ce stem est absent du mashup (aperçu et génération finale)" },
  { key: "A", glyph: "A", width: 22, activeBg: "rgba(0,234,255,0.18)", activeColor: "var(--cyan)", title: "Stem du Deck A" },
  { key: "AB", glyph: "A+B", width: 30, activeBg: "rgba(255,214,0,0.18)", activeColor: "#ffd600", title: "Deck A + Deck B RÉELLEMENT mixés ensemble (aperçu inclus, puisqu'alignés tempo/tonalité au moment de la génération)" },
  { key: "B", glyph: "B", width: 22, activeBg: "rgba(204,0,255,0.18)", activeColor: "var(--magenta)", title: "Stem du Deck B" },
];

// Construit la sélection par défaut pour un mode donné : voix vient de A,
// tout le reste (l'instrumental, quel que soit son découpage) vient de B —
// équivalent du mashup classique, modifiable librement ensuite.
const defaultSelectionForMode = (mode) => {
  const parts = PARTS_BY_MODE[mode] || PARTS_BY_MODE[4];
  return Object.fromEntries(parts.map(([key]) => [key, key === "vocals" ? "A" : "B"]));
};

// Quel(s) côté(s) faut-il jouer pour un stem selon son état.
const sidesForState = (state) => {
  if (state === "mute" || !state) return [];
  if (state === "AB") return ["A", "B"];
  return [state]; // "A" ou "B"
};

// m:ss, pour l'affichage temps écoulé/total du player.
const formatTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

// Petit bouton "régleur" +/- accolé aux sliders Clé/BPM (retour utilisateur,
// juillet 2026 : nouvelle disposition du cadre COMBO avec réglage pas à pas
// en plus du slider à glisser).
const STEPPER_BTN_STYLE = {
  width: 20, height: 20, borderRadius: 5, flexShrink: 0, padding: 0,
  border: "1px solid var(--border)", background: "rgba(255,255,255,0.05)",
  color: "var(--muted2)", fontSize: 13, fontWeight: 800, lineHeight: 1, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center",
};

// ── Petit en-tête de module façon "channel strip" — juste un libellé en
// capitales + une bordure/fond légèrement différenciés, réutilisé partout
// dans le panneau pour donner une hiérarchie visuelle claire (retour
// utilisateur : "problème de compréhension et d'organisation").
function Module({ title, right, children, style }) {
  return (
    <div style={{
      background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8,
      padding: "8px 10px", marginBottom: 8, ...style,
    }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
          <span style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 0.8, color: "var(--muted2)", fontSize: 10 }}>
            {title}
          </span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Toggle "durée ciblée" ────────────────────────────────────────────────
// (l'ex-MashupModeToggle "superposition complète"/"voix+instru" a été
// retiré : ses 2 boutons sont désormais inlinés directement dans le rendu,
// fusionnés avec le bouton IA-DJA en une seule rangée de 3 onglets — cf.
// plus bas, retour utilisateur juillet 2026 sur la nouvelle disposition.)
function DurationModeToggle({ durationMode, setDurationMode }) {
  const tailored = durationMode === "tailored";
  return (
    <button
      type="button"
      onClick={() => setDurationMode(tailored ? "full" : "tailored")}
      title="Ciblée : plafonne la durée du mashup autour du meilleur segment (façon RaveDJ, qui ne mashe jamais un morceau entier). Complète : dure aussi longtemps que la piste de référence."
      style={{
        width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
        padding: "8px 8px", fontSize: 13, fontWeight: 800, cursor: "pointer",
        border: `1px solid ${tailored ? "var(--cyan, #00eaff)" : "var(--border)"}`,
        background: tailored ? "rgba(0,234,255,0.1)" : "transparent",
        color: tailored ? "#00eaff" : "#e6e6f0",
        borderRadius: 6,
      }}
    >
      {tailored ? "☑" : "☐"} Durée ciblée (façon RaveDJ) — sinon durée complète
    </button>
  );
}

// ── Moteur Web Audio de l'aperçu (remplace les <audio> bruts) ───────────
// Un LiveNode par (part, side) — créé PARESSEUSEMENT (rien n'est
// téléchargé tant qu'on n'a pas cliqué play), et réutilisé tant que son URL
// ne change pas (mêmes réglages pitch/tempo appliqués en direct, même
// pendant la lecture — c'est ce qui permet de bouger un curseur PENDANT
// l'écoute et d'entendre l'effet immédiatement, comme un vrai fader).
// Expose une interface volontairement proche d'un <audio> HTMLElement
// (currentTime/duration/paused/play()/pause()) pour que toute la logique de
// lecture/scrubbing/reconciliation ci-dessous (déjà réglée avec soin) reste
// quasiment inchangée.
class LiveNode {
  constructor(ctx, url) {
    this.ctx = ctx;
    this.url = url;
    this.buffer = null;
    this.shifter = null;
    this.gain = ctx.createGain();
    this.paused = true;
    this.pendingTime = 0;
    this.pitch = 1;
    this.tempo = 1;
    this.onEnded = null;
    this._loadPromise = null;
    // VRAIE CAUSE du bug "le player de l'aperçu joue trop vite" (juillet 2026,
    // 2e diagnostic — le premier correctif, forcer l'AudioContext à 44100Hz,
    // n'a PAS suffi comme l'utilisateur l'a signalé) : soundtouchjs 0.3.0
    // (SimpleFilter/FilterSupport.fillOutputBuffer, cf. node_modules/
    // soundtouchjs/dist/soundtouch.js) précharge sa FIFO interne par blocs de
    // 8192*2 = 16384 échantillons À CHAQUE appel extract() (appelé une fois
    // par callback audio de 4096 échantillons), alors que le callback n'en
    // consomme réellement que 4096 pour la sortie — `sourcePosition` (donc
    // `PitchShifter.timePlayed`, l'ancien `currentTime` ci-dessous) avance
    // donc BIEN PLUS VITE que le temps réel écoulé (mesuré en direct : jusqu'à
    // ~11x). Conséquence en cascade DOUBLE, bien pire qu'un simple compteur
    // mal affiché : (1) la boucle "master" de ComboPanel (cf. plus bas)
    // détecte la fin de piste bien trop tôt (currentTime atteint "duration"
    // en ~1/10e du temps réel), coupant l'aperçu prématurément ; (2) elle
    // RESSAISIT (seek) réellement les autres stems sur cette fausse position
    // dès qu'ils "dérivent" de plus de 0.15s — ce qui fait RÉELLEMENT sauter
    // en avant leur lecture audio dans la piste. Le "trop vite" perçu était
    // donc un vrai décalage/saut audio, pas juste un timer optimiste.
    // Fix : ne plus faire confiance au compteur interne de soundtouchjs pour
    // la position — la calculer nous-mêmes à partir de l'horloge matérielle
    // de l'AudioContext (ctx.currentTime, TOUJOURS fiable, contrairement au
    // FIFO de la lib), ancrée à chaque play()/seek()/changement de tempo.
    this._posAtAnchor = 0;
    this._ctxTimeAtAnchor = 0;
  }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get currentTime() {
    if (this.paused || !this.shifter) return this.pendingTime;
    return this._posAtAnchor + (this.ctx.currentTime - this._ctxTimeAtAnchor) * this.tempo;
  }
  set currentTime(t) {
    this.pendingTime = Math.max(0, t);
    this._posAtAnchor = this.pendingTime;
    this._ctxTimeAtAnchor = this.ctx.currentTime;
    if (this.shifter && this.buffer && this.buffer.duration > 0) {
      this.shifter.percentagePlayed = Math.min(Math.max(this.pendingTime / this.buffer.duration, 0), 0.999);
    }
  }
  setPitchTempo(pitch, tempo) {
    // Ré-ancre la position AVANT de changer de tempo (avec l'ancien tempo,
    // donc), pour que le calcul horloge reste juste à partir de maintenant.
    if (!this.paused) {
      this._posAtAnchor = this.currentTime;
      this._ctxTimeAtAnchor = this.ctx.currentTime;
    }
    this.pitch = pitch;
    this.tempo = tempo;
    if (this.shifter) { this.shifter.pitch = pitch; this.shifter.tempo = tempo; }
  }
  _ensureLoaded() {
    if (this.buffer) return Promise.resolve(this.buffer);
    if (!this._loadPromise) {
      this._loadPromise = fetch(this.url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then(ab => this.ctx.decodeAudioData(ab))
        .then(buf => { this.buffer = buf; return buf; })
        .catch(err => { this._loadPromise = null; throw err; });
    }
    return this._loadPromise;
  }
  async play() {
    const buffer = await this._ensureLoaded();
    if (!this.shifter) {
      this.shifter = new PitchShifter(this.ctx, buffer, 4096, () => {
        this.paused = true;
        this.onEnded?.();
      });
      this.shifter.pitch = this.pitch;
      this.shifter.tempo = this.tempo;
      this.shifter.percentagePlayed = buffer.duration > 0
        ? Math.min(Math.max(this.pendingTime / buffer.duration, 0), 0.999)
        : 0;
    }
    this.shifter.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    // Ancre l'horloge de position (cf. commentaire du constructeur) au moment
    // RÉEL où la lecture démarre, pas seulement au moment où percentagePlayed
    // a été positionné plus haut.
    this._posAtAnchor = this.pendingTime;
    this._ctxTimeAtAnchor = this.ctx.currentTime;
    this.paused = false;
  }
  pause() {
    // Fige la position (calculée via l'horloge, cf. constructeur) AVANT de
    // passer paused=true, sinon le prochain getter currentTime la perdrait.
    if (!this.paused) this.pendingTime = this.currentTime;
    if (this.shifter) { try { this.shifter.disconnect(); } catch {} }
    try { this.gain.disconnect(); } catch {}
    this.paused = true;
  }
  destroy() {
    this.pause();
    this.shifter = null;
    this.buffer = null;
    this._loadPromise = null;
  }
}

export default function ComboPanel({
  analysisA, analysisB, crossfade, onCreateMashup, onPauseDecks,
  stemMode = 4, onStemModeChange, demoToken,
}) {
  // ── Mashup "classique" (mode 2 stems, sans grille à la carte) ────────────
  const [classicLoading, setClassicLoading] = useState(false);
  const [mashupMode, setMashupMode] = useState("full"); // "full" | "overlay"
  const [durationMode, setDurationMode] = useState("full"); // "full" | "tailored"

  // ── Bouton DEMO de la TopBar (juillet 2026) ──────────────────────────────
  // App.jsx passe un nouvel objet `demoToken` (référence toujours nouvelle,
  // même si le contenu est identique — cf. App.jsx::handleDemo) à chaque
  // clic sur DEMO, avec `tailored: true`. Force le panneau en mode Combo "à
  // la carte" (pas overlay) et bascule "Durée ciblée (façon RaveDJ)", pour
  // que la démo montre exactement le mode demandé sans manip manuelle.
  useEffect(() => {
    if (!demoToken?.tailored) return;
    setMashupMode("full");
    setDurationMode("tailored");
  }, [demoToken]);
  const handleClassicMashup = async () => {
    if (!onCreateMashup) return;
    setClassicLoading(true);
    try {
      await onCreateMashup({ crossfade, mode: mashupMode, durationMode });
    } finally {
      setClassicLoading(false);
    }
  };
  const parts = PARTS_BY_MODE[stemMode] || null; // null en mode 2 (pas de grille)

  // ── Mashup "à la carte" — provenance par stem Demucs ────────────────────
  const [stemSelection, setStemSelection] = useState(() => defaultSelectionForMode(stemMode));
  const [stemsMashupLoading, setStemsMashupLoading] = useState(false);
  const setStemOrigin = (part, state) => setStemSelection(s => ({ ...s, [part]: state }));

  const stemSelectionRef = useRef(stemSelection);
  useEffect(() => { stemSelectionRef.current = stemSelection; }, [stemSelection]);

  // Si le mode change (sélecteur 2/4/6), la sélection précédente n'a plus de
  // sens — on repart d'une sélection par défaut propre pour le nouveau mode.
  useEffect(() => { setStemSelection(defaultSelectionForMode(stemMode)); }, [stemMode]);

  // ── Réglages clé/octave (demi-tons) + BPM (tempo) ───────────────────────
  // Déclarés ICI (avant le moteur de lecture ci-dessous, qui en dépend) —
  // pitchShiftOverride/tempoRatioOverride, déjà acheminés bout en bout par
  // MashupStudio.jsx vers POST /api/mashup. null = comportement automatique
  // inchangé (calcul rubberband/camelotAwareShift standard côté serveur).
  // DÉSORMAIS AUSSI appliqués en direct à l'aperçu ci-dessous (cf. moteur
  // Web Audio/soundtouchjs plus haut) : la voix est pitchée, l'instrumental
  // est étiré en tempo — même répartition que le moteur serveur.
  const [manualPitch, setManualPitch] = useState(null); // demi-tons, null = auto
  const [manualTempo, setManualTempo] = useState(null); // ratio (1 = inchangé), null = auto
  const [showAdvanced, setShowAdvanced] = useState(true); // ouvert par défaut (retour utilisateur : "mettre en avant visible")
  const hasManualOverride = manualPitch !== null || manualTempo !== null;
  const pitchValue = manualPitch ?? 0;
  const tempoValue = manualTempo ?? 1;
  const handleResetAdvanced = () => { setManualPitch(null); setManualTempo(null); };

  // Pitch/tempo effectifs pour un stem donné — SEULE la voix est pitchée
  // (demi-tons), SEUL le reste (batterie/basse/autres...) est étiré en
  // tempo — reflète exactement la répartition du moteur serveur (cf.
  // mixFullRave : pitchFilter sur la voix seule "tempo=1", tempoFilter sur
  // l'instru seul "pitch=1").
  const pitchTempoForPart = (part) => {
    if (part === "vocals") return { pitch: manualPitch != null ? Math.pow(2, manualPitch / 12) : 1, tempo: 1 };
    return { pitch: 1, tempo: manualTempo != null ? manualTempo : 1 };
  };

  // ── Moteur Web Audio (contexte + cache de nœuds par (part,side)) ────────
  const audioCtxRef = useRef(null);
  const getAudioCtx = () => {
    if (!audioCtxRef.current) {
      // BUG "le player joue trop vite" (juillet 2026) : soundtouchjs 0.3.0
      // (PitchShifter → SoundTouch → Stretch, cf. node_modules/soundtouchjs/
      // dist/soundtouch.js) code EN DUR sa fréquence d'échantillonnage interne
      // à 44100 Hz (`new Stretch()` appelle `setParameters(44100, ...)`), et
      // rien dans PitchShifter ne la recale sur la fréquence RÉELLE de
      // l'AudioContext. `new AudioContext()` SANS option choisit la fréquence
      // native du périphérique de sortie — 48000 Hz sur la plupart des
      // machines Windows — donc les fenêtres de calcul du time-stretch
      // (seekWindowLength/overlapLength, en ÉCHANTILLONS) étaient calculées
      // pour 44100 Hz tout en recevant réellement des échantillons à
      // 48000 Hz : ≈48000/44100 ≈ 1.088, soit très exactement l'effet
      // "joue trop vite" perçu, même à tempo=1/pitch=1 (aucun réglage manuel
      // touché). Fixer explicitement l'AudioContext à 44100 Hz élimine cet
      // écart à la source, sans avoir à patcher la lib tierce.
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    }
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  };
  const nodesRef = useRef({}); // { [part]: { A: LiveNode, B: LiveNode } }
  const stemUrlForSide = (part, side) => {
    const track = side === "B" ? analysisB : analysisA;
    const path = track?.[`${part}_path`];
    return path ? `${API_BASE}${path}` : null;
  };
  // Renvoie le LiveNode courant pour (part, side), en (re)créant si l'URL a
  // changé (nouveau morceau chargé dans le Deck, ré-analyse...) — sinon
  // réutilise le même nœud (position/lecture en cours préservées).
  const getNode = (part, side) => {
    const url = stemUrlForSide(part, side);
    if (!nodesRef.current[part]) nodesRef.current[part] = {};
    const existing = nodesRef.current[part][side];
    if (!url) {
      if (existing) existing.destroy();
      nodesRef.current[part][side] = null;
      return null;
    }
    if (existing && existing.url === url) return existing;
    if (existing) existing.destroy();
    const fresh = new LiveNode(getAudioCtx(), url);
    nodesRef.current[part][side] = fresh;
    return fresh;
  };

  const [playingScope, setPlayingScope] = useState(null); // null | "global" | part | "loading:<part>" | "loading:global"
  const [currentTime, setCurrentTime] = useState(0);
  const [livePreviewError, setLivePreviewError] = useState(null);

  const sidesFor = (part) => sidesForState(stemSelection[part]);
  const partReady = (part) => sidesFor(part).every(side => !!stemUrlForSide(part, side));
  const livePreviewReady = !!parts
    && parts.every(([part]) => partReady(part))
    && parts.some(([part]) => stemSelection[part] !== "mute");

  const comboActivePairs = parts ? parts.flatMap(([part]) => sidesFor(part).map(side => [part, side])) : [];
  const comboActiveNodes = () => comboActivePairs.map(([p, s]) => getNode(p, s)).filter(Boolean);
  const comboDurations = comboActiveNodes().map(n => n.duration).filter(d => Number.isFinite(d) && d > 0);
  const comboDuration = comboDurations.length ? Math.max(...comboDurations) : 0;

  const comboActivePairsRef = () => parts
    ? parts.flatMap(([part]) => sidesForState(stemSelectionRef.current[part]).map(side => [part, side]))
    : [];
  const comboActiveNodesRef = () => comboActivePairsRef().map(([p, s]) => getNode(p, s)).filter(Boolean);

  const stopAllAudio = () => {
    Object.values(nodesRef.current).forEach(sides => {
      if (!sides) return;
      sides.A?.pause();
      sides.B?.pause();
    });
  };
  const stopLivePreview = () => { stopAllAudio(); setPlayingScope(null); };

  useEffect(() => registerPlayer("stems-preview-live", stopLivePreview), []);

  // Démarre la lecture d'UN côté (part, side) à une position donnée, avec
  // les réglages pitch/tempo courants pour ce stem. Le chargement (fetch +
  // décodage) n'a lieu qu'ICI, au moment réel où on demande à jouer — plus
  // aucun fetch "eager" au montage (source de l'ancien bug de case rouge
  // récurrent juste après une séparation Demucs).
  // ptOverride : {pitch,tempo} explicite plutôt que déduit de pitchTempoForPart(part)
  // — utilisé par l'aperçu "Superposition complète" ci-dessous, qui applique un
  // pitch/tempo par CÔTÉ (A ou B) plutôt que par stem (cf. overlayPitchTempo).
  const playNodeAt = (part, side, time, attempt = 0, ptOverride = null) => {
    const node = getNode(part, side);
    if (!node) return Promise.resolve();
    const { pitch, tempo } = ptOverride || pitchTempoForPart(part);
    node.setPitchTempo(pitch, tempo);
    node.currentTime = time;
    return node.play().catch(err => {
      if (attempt === 0) {
        console.warn(`[live-preview] échec lecture stem "${part}" (${side}) — nouvelle tentative dans 700ms :`, err?.message || err);
        return new Promise(resolve => setTimeout(() => resolve(playNodeAt(part, side, time, 1, ptOverride)), 700));
      }
      console.error(`[live-preview] échec lecture stem "${part}" (${side}) (${node.url}) après 2 tentatives :`, err);
      setLivePreviewError(
        `Le stem "${STEM_LABELS[part]}" (${side}) ne s'est pas chargé (fichier manquant/périmé côté serveur, ou format illisible — relance l'analyse du morceau concerné).`
      );
    });
  };

  // ── Aperçu "Superposition complète" (demande explicite, juillet 2026) ──
  // Contrairement au moteur ci-dessus (pensé pour le mashup "à la carte", où
  // chaque stem a une provenance A/B/AB/mute choisie indépendamment), ce mode
  // ne sépare rien : il faut faire jouer les 2 morceaux COMPLETS ensemble.
  // On reconstitue chaque "piste complète" en sommant TOUS les stems déjà
  // séparés de ce côté (vocals+instrumental en mode 2, vocals+drums+bass+
  // other en mode 4) — même cache LiveNode/getNode que ci-dessus, réutilisé
  // tel quel, juste appliqué à TOUS les stems des 2 côtés plutôt qu'à une
  // sélection. A joue tel quel ; B est recalé (tempo + tonalité, approximation
  // simplifiée — cf. helpers en tête de fichier) pour se rapprocher du résultat
  // final, sans reproduire exactement le plan de tempo par segment du serveur.
  const overlayParts = stemMode === 2 ? ["vocals", "instrumental"] : PARTS_BY_MODE[4].map(([p]) => p);
  const overlaySideReady = (side) => overlayParts.every(part => !!stemUrlForSide(part, side));
  const overlayReady = overlaySideReady("A") && overlaySideReady("B");
  const overlayPitchTempo = () => ({
    A: { pitch: 1, tempo: 1 },
    B: {
      pitch: Math.pow(2, overlayShiftClient(analysisB?.key_pitch, analysisA?.key_pitch) / 12),
      tempo: safeTempoRatioClient(analysisA?.bpm, analysisB?.bpm),
    },
  });
  const overlayActivePairs = () => overlayParts.flatMap(part => ["A", "B"].map(side => [part, side]));
  const overlayActiveNodes = () => overlayActivePairs().map(([p, s]) => getNode(p, s)).filter(Boolean);
  const overlayDurations = overlayActiveNodes().map(n => n.duration).filter(d => Number.isFinite(d) && d > 0);
  const overlayDuration = overlayDurations.length ? Math.max(...overlayDurations) : 0;

  const handleOverlayPlayPause = () => {
    if (playingScope === "overlay") {
      overlayActiveNodes().forEach(n => n.pause());
      setPlayingScope(null);
      return;
    }
    if (!overlayReady) return;
    setLivePreviewError(null);
    stopAllAudio();
    if (onPauseDecks) onPauseDecks();
    notifyPlaying("stems-preview-live");
    const pt = overlayPitchTempo();
    const startAt = currentTime;
    setPlayingScope("overlay");
    Promise.all(overlayActivePairs().map(([part, side]) => playNodeAt(part, side, startAt, 0, pt[side]))).catch(() => {});
  };

  const handleOverlaySeek = (t) => {
    setCurrentTime(t);
    overlayActiveNodes().forEach(n => { n.currentTime = t; });
  };

  // ── Aperçu SOLO d'un stem (bouton ▶ de la ligne) ────────────────────────
  const toggleRowPlay = (part) => {
    if (playingScope === part) { stopLivePreview(); return; }
    if (!partReady(part) || sidesFor(part).length === 0) return;
    setLivePreviewError(null);
    stopAllAudio();
    if (onPauseDecks) onPauseDecks();
    notifyPlaying("stems-preview-live");
    setPlayingScope(part);
    Promise.all(sidesFor(part).map(side => playNodeAt(part, side, 0))).catch(() => {});
  };

  // ── Player "combinaison" (▶/⏸ + scrubber) ───────────────────────────────
  const prevGlobalPairsRef = useRef([]);
  const handleComboPlayPause = () => {
    if (playingScope === "global") {
      comboActiveNodesRef().forEach(n => n.pause());
      setPlayingScope(null);
      return;
    }
    if (!livePreviewReady) return;
    setLivePreviewError(null);
    stopAllAudio();
    if (onPauseDecks) onPauseDecks();
    notifyPlaying("stems-preview-live");
    const pairs = comboActivePairsRef();
    prevGlobalPairsRef.current = pairs.map(([p, s]) => `${p}|${s}`);
    const startAt = currentTime;
    setPlayingScope("global");
    Promise.all(pairs.map(([part, side]) => playNodeAt(part, side, startAt))).catch(() => {});
  };

  const handleComboSeek = (t) => {
    setCurrentTime(t);
    comboActiveNodesRef().forEach(n => { n.currentTime = t; });
  };

  // Reconciliation : si la sélection change PENDANT que le player de
  // combinaison joue, seules les pistes concernées s'arrêtent/démarrent, à
  // la même position que le reste — pour comparer des variantes à la volée.
  const selectionKey = parts ? parts.map(([p]) => stemSelection[p]).join(",") : "";
  useEffect(() => {
    if (playingScope !== "global") {
      // BUG (audit juillet 2026) : cet effet réagit à CHAQUE changement de
      // selectionKey, qui encode l'état de TOUS les stems en une seule
      // chaîne — donc modifier un stem sans rapport (ex. batterie) pendant
      // un aperçu SOLO d'un autre stem (ex. voix) coupait ce dernier sans
      // raison, puisque la condition ne regardait que "playingScope !==
      // global" sans vérifier QUEL stem avait réellement changé. On ne coupe
      // désormais que si c'est le stem EN COURS d'aperçu solo qui vient
      // lui-même de passer à 🔇 Muet (plus aucun côté à jouer) — un
      // changement sur un autre stem n'a plus d'effet sur cet aperçu.
      if (playingScope && sidesForState(stemSelection[playingScope]).length === 0) stopLivePreview();
      return;
    }
    const nowPairs = comboActivePairsRef().map(([p, s]) => `${p}|${s}`);
    const prevPairs = prevGlobalPairsRef.current;
    const nowSet = new Set(nowPairs);
    const prevSet = new Set(prevPairs);
    let refTime = currentTime;
    for (const key of nowPairs) {
      if (prevSet.has(key)) {
        const [p, s] = key.split("|");
        const n = getNode(p, s);
        if (n) { refTime = n.currentTime; break; }
      }
    }
    prevPairs.forEach(key => {
      if (!nowSet.has(key)) {
        const [p, s] = key.split("|");
        getNode(p, s)?.pause();
      }
    });
    nowPairs.forEach(key => {
      if (!prevSet.has(key)) {
        const [p, s] = key.split("|");
        playNodeAt(p, s, refTime).catch(() => {});
      }
    });
    prevGlobalPairsRef.current = nowPairs;
    if (nowPairs.length === 0) setPlayingScope(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  // Réglages pitch/tempo changés PENDANT la lecture : appliqués en direct à
  // tous les nœuds actifs (c'est tout l'intérêt du moteur Web Audio ici — un
  // curseur bougé pendant l'écoute s'entend immédiatement, comme un vrai
  // fader de console, plutôt que de devoir couper/relancer).
  useEffect(() => {
    if (!parts) return;
    parts.forEach(([part]) => {
      const { pitch, tempo } = pitchTempoForPart(part);
      sidesForState(stemSelection[part]).forEach(side => {
        const n = nodesRef.current[part]?.[side];
        if (n) n.setPitchTempo(pitch, tempo);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualPitch, manualTempo]);

  // Boucle de progression du player de combinaison — généralisée (audit
  // juillet 2026) pour couvrir aussi playingScope==="overlay" (aperçu
  // Superposition complète), qui suit exactement la même logique
  // maître/esclave de resynchronisation, juste avec un jeu de nœuds actifs
  // différent (overlayActiveNodes au lieu de comboActiveNodesRef).
  useEffect(() => {
    if (playingScope !== "global" && playingScope !== "overlay") return;
    let raf;
    const tick = () => {
      const nodes = playingScope === "overlay" ? overlayActiveNodes() : comboActiveNodesRef();
      if (nodes.length === 0) { setPlayingScope(null); return; }
      const master = nodes.reduce((a, b) => (a.currentTime > b.currentTime ? a : b));
      setCurrentTime(master.currentTime);
      nodes.forEach(n => {
        if (n !== master && !n.paused && Math.abs(n.currentTime - master.currentTime) > 0.15) {
          n.currentTime = master.currentTime;
        }
      });
      const durs = nodes.map(n => n.duration).filter(d => Number.isFinite(d) && d > 0);
      const dur = durs.length ? Math.max(...durs) : 0;
      if (dur && master.currentTime >= dur - 0.05) {
        nodes.forEach(n => n.pause());
        setPlayingScope(null);
        setCurrentTime(0);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingScope]);

  // Nouvelle analyse reçue du Deck (chargement, ré-analyse...) : les nœuds
  // existants pointent peut-être vers des fichiers désormais périmés/
  // régénérés — on coupe tout et on vide le cache pour forcer un
  // rechargement propre au prochain play plutôt que de rejouer un buffer
  // resté en mémoire depuis l'ancien fichier.
  useEffect(() => {
    stopLivePreview();
    Object.values(nodesRef.current).forEach(sides => {
      sides?.A?.destroy();
      sides?.B?.destroy();
    });
    nodesRef.current = {};
    setLivePreviewError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisA, analysisB]);

  // Ferme l'AudioContext au démontage (audit juillet 2026) : ComboPanel n'est
  // PAS monté en permanence — il ne s'affiche que si isDuo (2 decks, cf.
  // MashupStudio.jsx), et est donc démonté/remonté à chaque passage entre 2
  // et 3+ decks. Sans fermeture explicite, chaque démontage laissait son
  // AudioContext ouvert indéfiniment ; les navigateurs (Chrome en tête)
  // limitent le nombre d'AudioContext non fermés par onglet (~4-6) — après
  // plusieurs allers-retours 2 ↔ multi-decks, `new AudioContext()` finissait
  // par échouer silencieusement et l'aperçu live des stems (fonction centrale
  // de ce panneau) cessait de fonctionner jusqu'à un rechargement de page.
  useEffect(() => {
    return () => {
      Object.values(nodesRef.current).forEach(sides => {
        sides?.A?.destroy();
        sides?.B?.destroy();
      });
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  const handleLiveStemEnded = () => {
    // Géré par la boucle de progression pour "global" ; pour un aperçu solo,
    // LiveNode.onEnded (câblé plus bas au moment du play) coupe directement.
  };

  // ── IA-DJA : suggère 3 combinaisons à comparer ──────────────────────────
  // Analyse la compatibilité RÉELLE des 2 morceaux (même moteur que le score
  // affiché dans Mixer.jsx et la roue MachWheel — services/scoring.js via
  // POST /api/analyze/score, aucun nouveau calcul serveur) et en déduit 3
  // pistes de départ à comparer, plutôt qu'une seule combinaison imposée :
  //   🛡 Prudent    : aucune fusion — voix A / reste B, toujours fiable.
  //   ⚖ Équilibré  : logique historique — fusion A+B seulement là où le
  //                   score le justifie (batterie si BPM ok, le reste si
  //                   BPM ET tonalité ok ; rien si décrochage vocal engagé).
  //   🔥 Audacieux  : fusion A+B pour tout l'instrumental, même hors budget
  //                   recommandé — à tester à l'oreille si on veut un double
  //                   mix dense, jamais appliqué sans clic explicite.
  // Cliquer une carte la SÉLECTIONNE/surligne seulement ; il faut valider
  // avec "Appliquer cette combi" pour l'écrire réellement dans la grille de
  // stems (modifiable librement ensuite, comme n'importe quel réglage).
  const [iaOpen, setIaOpen] = useState(false);
  const [iaLoading, setIaLoading] = useState(false);
  const [iaResult, setIaResult] = useState(null); // { score, candidates: [...] }
  const [iaError, setIaError] = useState(null);
  const [iaSelectedKey, setIaSelectedKey] = useState(null);

  const buildIaCandidates = (data, nonVocalKeys) => {
    const { subscores, vocalLockEngaged, invalidReason } = data;
    const bpmOk = subscores.bpm >= 80;
    const keyOk = subscores.key >= 80;
    const fusedList = (sel) => {
      const list = nonVocalKeys.filter(k => sel[k] === "AB").map(k => STEM_LABELS[k]);
      return list.length ? list.join(", ") : "aucun";
    };

    const prudent = { vocals: "A" };
    nonVocalKeys.forEach(k => { prudent[k] = "B"; });

    const equilibre = { vocals: "A" };
    if (vocalLockEngaged) {
      nonVocalKeys.forEach(k => { equilibre[k] = "B"; });
    } else {
      nonVocalKeys.forEach(k => {
        equilibre[k] = k === "drums" ? (bpmOk ? "AB" : "B") : ((bpmOk && keyOk) ? "AB" : "B");
      });
    }

    const audacieux = { vocals: "A" };
    nonVocalKeys.forEach(k => { audacieux[k] = "AB"; });

    return [
      {
        key: "prudent", label: "🛡 Prudent", selection: prudent,
        reason: "Aucune fusion — voix de A, tout l'instrumental de B. Le mix classique, toujours fiable.",
      },
      {
        key: "equilibre", label: "⚖ Équilibré", selection: equilibre,
        recommended: !vocalLockEngaged,
        reason: vocalLockEngaged
          ? `⚠ ${invalidReason || "Décrochage vocal important entre les 2 morceaux"} — pas de fusion tant que la tonalité n'est pas plus proche.`
          : (bpmOk && keyOk)
            ? `BPM (${subscores.bpm}/100) et tonalité (${subscores.key}/100) très compatibles — fusion proposée pour : ${fusedList(equilibre)}.`
            : bpmOk
              ? `BPM compatible (${subscores.bpm}/100), tonalité plus incertaine (${subscores.key}/100) — fusion prudente (batterie non tonale seulement) : ${fusedList(equilibre)}.`
              : `Compatibilité rythmique limitée (BPM ${subscores.bpm}/100, tonalité ${subscores.key}/100) — mix classique conservé.`,
      },
      {
        key: "audacieux", label: "🔥 Audacieux", selection: audacieux,
        reason: vocalLockEngaged
          ? "Fusionne tout malgré le décrochage vocal détecté — risque de choc harmonique, à tes oreilles de juger."
          : `Fusionne tout l'instrumental (${fusedList(audacieux)}) même là où le score ne le recommande pas partout — pour un double mix dense.`,
      },
    ];
  };

  const handleIaDjAssist = async () => {
    if (!analysisA?.id || !analysisB?.id || !parts) return;
    setIaLoading(true);
    setIaError(null);
    try {
      const res = await fetch(`${API_BASE}/api/analyze/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIdA: analysisA.id, videoIdB: analysisB.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Échec du calcul de compatibilité");
      const nonVocalKeys = parts.filter(([p]) => p !== "vocals").map(([p]) => p);
      const candidates = buildIaCandidates(data, nonVocalKeys);
      setIaResult({ score: data.score, candidates });
      setIaSelectedKey(candidates.find(c => c.recommended)?.key || candidates[0].key);
    } catch (e) {
      setIaError(e.message);
    } finally {
      setIaLoading(false);
    }
  };

  const handleToggleIaPanel = () => {
    const opening = !iaOpen;
    setIaOpen(opening);
    if (opening && !iaResult && !iaLoading) handleIaDjAssist();
  };

  const handleApplyIaSuggestion = () => {
    const candidate = iaResult?.candidates.find(c => c.key === iaSelectedKey);
    if (!candidate) return;
    setStemSelection(sel => ({ ...sel, ...candidate.selection }));
  };

  const handleStemsMashup = async () => {
    if (!onCreateMashup) return;
    setStemsMashupLoading(true);
    try {
      await onCreateMashup({
        crossfade, mode: "stems", stemSelection, durationMode,
        pitchShiftOverride: manualPitch, tempoRatioOverride: manualTempo,
      });
    } finally {
      setStemsMashupLoading(false);
    }
  };

  const ready = !!(analysisA && analysisB);

  // ── Module d'aperçu pour "Superposition complète" (demande explicite,
  // juillet 2026) — même esprit que le module "▶ APERÇU DE LA COMBINAISON"
  // du mashup à la carte, mais sans grille de sélection (rien à choisir en
  // overlay, les 2 morceaux complets jouent toujours ensemble). Réutilisé
  // par les 2 branches du rendu ci-dessous (mode 2 stems ET mode 4 stems
  // avec "overlay" sélectionné) plutôt que dupliqué.
  const renderOverlayPreview = () => (
    <Module title="▶ APERÇU DE LA SUPERPOSITION" style={{ marginBottom: 8 }}>
      {!overlayReady ? (
        <div style={{ color: "var(--muted2)", fontSize: 11 }}>
          En attente de la séparation des stems des 2 morceaux (nécessaire pour reconstituer chaque piste complète, même en mode superposition) pour activer l'aperçu.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={handleOverlayPlayPause}
              disabled={playingScope !== "overlay" && !overlayReady}
              title="Joue les 2 morceaux complets ensemble (B recalé en tempo/tonalité sur A, approximation)"
              style={{
                width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                border: "1px solid rgba(0,234,255,0.4)",
                background: playingScope === "overlay" ? "rgba(0,234,255,0.28)" : "rgba(0,234,255,0.1)",
                color: "var(--cyan)", fontSize: 12,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >{playingScope === "overlay" ? "⏸" : "▶"}</button>
            <span style={{ fontSize: 10, color: "var(--muted2)", width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {formatTime(currentTime)}
            </span>
            <input
              type="range" min={0} max={overlayDuration || 0.001} step={0.05}
              value={Math.min(currentTime, overlayDuration || 0)}
              disabled={!overlayDuration}
              onChange={e => handleOverlaySeek(Number(e.target.value))}
              style={{ flex: 1, accentColor: "#00eaff" }}
            />
            <span style={{ fontSize: 10, color: "var(--muted2)", width: 30, fontVariantNumeric: "tabular-nums" }}>
              {formatTime(overlayDuration)}
            </span>
          </div>
          <div style={{ fontSize: 9, color: "var(--muted2)", marginTop: 3, textAlign: "center" }}>
            Aperçu approximatif : B est recalé en tempo/tonalité sur A, sans le plan de tempo par segment du moteur final — le vrai mashup généré peut légèrement différer.
          </div>
          {livePreviewError && (
            <div style={{
              marginTop: 6, fontSize: 10, lineHeight: 1.4, color: "#ff6b6b",
              background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.3)",
              borderRadius: 6, padding: "6px 8px",
            }}>
              ⚠ {livePreviewError}
            </div>
          )}
        </>
      )}
    </Module>
  );

  return (
    <div className="combo-panel">
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%" }}>
        {/* Titre "COMBO" vertical, à gauche du cadre (inchangé). */}
        <div className="combo-panel-title-vertical">COMBO</div>

        <div style={{ flex: 1 }}>
          {/* ── Sélecteur 2/4 stems ── */}
          <div style={{
            display: "flex", gap: 4, marginBottom: 8, background: "var(--surface2)",
            border: "1px solid var(--border)", borderRadius: 8, padding: 3,
          }}>
            {[2, 4].map(m => {
              const active = stemMode === m;
              return (
                <button
                  key={m}
                  onClick={() => onStemModeChange && onStemModeChange(m)}
                  title={MODE_INFO[m].title}
                  style={{
                    flex: 1, padding: "5px 0", borderRadius: 6, border: "none",
                    fontSize: 11, fontWeight: 800, cursor: "pointer", letterSpacing: 0.3,
                    background: active ? "rgba(0,234,255,0.18)" : "transparent",
                    color: active ? "var(--cyan)" : "var(--muted2)",
                  }}
                >
                  {m} stems
                </button>
              );
            })}
          </div>

          {!ready ? (
            <div style={{ color: "var(--muted2)", fontSize: 12, padding: "10px 4px" }}>
              En attente de l'analyse complète des Decks A et B (BPM/clé/stems) pour proposer le mashup à la carte.
            </div>
          ) : (
            <div style={{
              background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10,
              padding: "10px 12px", fontSize: 12,
            }}>
              <div style={{ fontFamily: "Orbitron,sans-serif", fontWeight: 900, letterSpacing: 1, color: "var(--muted2)", fontSize: 11, marginBottom: 8 }}>
                🎛 MASHUP À LA CARTE
              </div>

              {/* ── Mode + IA-DJA — 3 boutons alignés façon onglets (retour
                  utilisateur, juillet 2026 : nouvelle disposition du cadre
                  COMBO), au lieu d'un toggle 2 options + bouton isolé. ── */}
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <button
                  type="button"
                  onClick={() => setMashupMode("full")}
                  title="Mode classique : voix isolée de A + instrumental isolé de B (Demucs)"
                  style={{
                    flex: 1, padding: "7px 6px", fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                    border: `1px solid ${mashupMode === "full" ? "var(--green)" : "var(--border)"}`,
                    background: mashupMode === "full" ? "rgba(170,255,0,0.12)" : "transparent",
                    color: mashupMode === "full" ? "var(--green)" : "var(--muted2)",
                    borderRadius: 6, whiteSpace: "nowrap",
                  }}
                >🎤 Voix + instru</button>
                <button
                  type="button"
                  onClick={() => setMashupMode("overlay")}
                  title="Superpose les 2 morceaux complets, sans isoler la voix — façon RaveDJ"
                  style={{
                    flex: 1, padding: "7px 6px", fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                    border: `1px solid ${mashupMode === "overlay" ? "var(--cyan)" : "var(--border)"}`,
                    background: mashupMode === "overlay" ? "rgba(0,234,255,0.12)" : "transparent",
                    color: mashupMode === "overlay" ? "var(--cyan)" : "var(--muted2)",
                    borderRadius: 6, whiteSpace: "nowrap",
                  }}
                >🌐 Superposition complète</button>
                {parts && mashupMode !== "overlay" && (
                  <button
                    type="button"
                    onClick={handleToggleIaPanel}
                    disabled={!analysisA?.id || !analysisB?.id}
                    data-tooltip="Analyse la compatibilité réelle des 2 morceaux (BPM/tonalité) et propose 3 combinaisons de stems à comparer, à valider ou ignorer librement."
                    style={{
                      flex: 1, padding: "7px 6px", fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                      border: `1px solid ${iaOpen ? "var(--magenta)" : "var(--border)"}`,
                      background: iaOpen ? "rgba(204,0,255,0.16)" : "transparent",
                      color: iaOpen ? "var(--magenta)" : "var(--muted2)",
                      borderRadius: 6, whiteSpace: "nowrap",
                    }}
                  >{iaLoading ? "🧠 …" : "🧠 IA·DJA"}</button>
                )}
              </div>

              {iaOpen && parts && mashupMode !== "overlay" && (
                <div style={{
                  marginBottom: 8, background: "var(--surface)", border: "1px solid rgba(204,0,255,0.4)",
                  borderRadius: 8, padding: "8px 9px",
                }}>
                  {iaLoading && (
                    <div style={{ fontSize: 11, color: "var(--muted2)" }}>Analyse de la compatibilité en cours…</div>
                  )}
                  {iaError && (
                    <div style={{ fontSize: 10, lineHeight: 1.4, color: "#ff6b6b" }}>⚠ {iaError}</div>
                  )}
                  {iaResult && !iaLoading && (
                    <>
                      <div style={{ fontSize: 10, color: "var(--magenta)", marginBottom: 7 }}>
                        Score de compatibilité global : <strong>{iaResult.score}/100</strong> — choisis une piste de départ :
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {iaResult.candidates.map(c => {
                          const selected = iaSelectedKey === c.key;
                          return (
                            <button
                              key={c.key}
                              onClick={() => setIaSelectedKey(c.key)}
                              style={{
                                textAlign: "left", padding: "6px 8px", borderRadius: 7, cursor: "pointer",
                                border: `1px solid ${selected ? "var(--magenta)" : "var(--border)"}`,
                                background: selected ? "rgba(204,0,255,0.16)" : "transparent",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <span style={{ fontSize: 11, fontWeight: 800, color: selected ? "var(--magenta)" : "var(--text)" }}>{c.label}</span>
                                {c.recommended && (
                                  <span style={{ fontSize: 9, fontWeight: 800, color: "#aaff00" }}>recommandé</span>
                                )}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--muted2)", lineHeight: 1.4, marginTop: 3 }}>{c.reason}</div>
                            </button>
                          );
                        })}
                      </div>
                      <button
                        onClick={handleApplyIaSuggestion}
                        style={{
                          marginTop: 8, width: "100%", padding: "6px 0", borderRadius: 6,
                          background: "rgba(204,0,255,0.2)", border: "1px solid rgba(204,0,255,0.45)",
                          color: "var(--magenta)", fontSize: 10.5, fontWeight: 800, cursor: "pointer",
                        }}
                      >✓ Appliquer cette combi</button>
                    </>
                  )}
                </div>
              )}

              {!parts ? (
                // Mode 2 stems : Demucs ne sépare que voix/instrumental.
                <>
                  <div style={{ color: "var(--muted2)", fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>
                    En mode 2 stems, Demucs ne sépare que la voix et l'instrumental complet
                    — il n'y a pas de batterie/basse/autres à combiner séparément.
                    Passe en 4 stems ci-dessus pour activer le mashup à la carte.
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <DurationModeToggle durationMode={durationMode} setDurationMode={setDurationMode} />
                  </div>
                  {mashupMode === "overlay" && renderOverlayPreview()}
                  <button onClick={handleClassicMashup} disabled={classicLoading} style={{
                    width: "100%", padding: "9px 0", borderRadius: 7,
                    background: "rgba(170,255,0,0.1)", border: "1px solid rgba(170,255,0,0.3)",
                    color: "var(--green)", fontSize: 12, fontWeight: 800, cursor: classicLoading ? "default" : "pointer",
                    letterSpacing: 0.5, opacity: classicLoading ? 0.6 : 1,
                  }}>{classicLoading ? "GÉNÉRATION…" : "✦ CRÉER LE MACHEUP"}</button>
                </>
              ) : mashupMode === "overlay" ? (
                <>
                  <div style={{ color: "var(--muted2)", fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>
                    Mode superposition : les 2 morceaux COMPLETS sont mixés tels quels
                    (pas de séparation par stem) — la sélection par instrument et les
                    réglages clé/BPM ci-dessous ne s'appliquent pas dans ce mode.
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <DurationModeToggle durationMode={durationMode} setDurationMode={setDurationMode} />
                  </div>
                  {renderOverlayPreview()}
                  <button onClick={handleClassicMashup} disabled={classicLoading} style={{
                    width: "100%", padding: "9px 0", borderRadius: 7,
                    background: "rgba(170,255,0,0.1)", border: "1px solid rgba(170,255,0,0.3)",
                    color: "var(--green)", fontSize: 12, fontWeight: 800, cursor: classicLoading ? "default" : "pointer",
                    letterSpacing: 0.5, opacity: classicLoading ? 0.6 : 1,
                  }}>{classicLoading ? "GÉNÉRATION…" : "✦ CRÉER LE MACHEUP"}</button>
                </>
              ) : (
                <>
                  {/* ── Module 2 : durée ── */}
                  <div style={{ marginBottom: 8 }}>
                    <DurationModeToggle durationMode={durationMode} setDurationMode={setDurationMode} />
                  </div>

                  {/* ── Modules 3+4 : provenance par stem + clé/BPM, en 2
                      colonnes avec bordure verte (retour utilisateur,
                      juillet 2026 : nouvelle disposition du cadre COMBO).
                      gridTemplateColumns en repeat(auto-fit, minmax(...))
                      plutôt que "1fr 1fr" fixe (audit juillet 2026) : sous
                      ~480px de large pour ce cadre (fenêtre étroite, ou
                      cadre COMBO affiché à côté d'autres panneaux), les 2
                      colonnes fixes rétrécissaient au point de faire se
                      chevaucher les boutons +/- des sliders ; en auto-fit,
                      la 2ème colonne passe automatiquement sous la 1ère dès
                      que 240px ne tiennent plus côte à côte. ── */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8, marginBottom: 8 }}>
                    <Module title="🎚 PROVENANCE PAR STEM" style={{ border: "1px solid var(--green)", marginBottom: 0 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {parts.map(([part, label]) => {
                          const rowPlayable = partReady(part) && sidesFor(part).length > 0;
                          const rowPlaying = playingScope === part;
                          return (
                            <div key={part} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 11, color: "var(--muted2)", flex: 1, minWidth: 50 }}>{label}</span>
                              <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
                                {STEM_STATES.map(({ key, glyph, width, activeBg, activeColor, title }) => {
                                  const active = stemSelection[part] === key;
                                  return (
                                    <button key={key} onClick={() => setStemOrigin(part, key)} title={title} style={{
                                      width, padding: "4px 0", fontSize: 10, fontWeight: 800, cursor: "pointer",
                                      border: "none", borderLeft: key !== "mute" ? "1px solid var(--border)" : "none",
                                      background: active ? activeBg : "transparent",
                                      color: active ? activeColor : "var(--muted2)",
                                    }}>{glyph}</button>
                                  );
                                })}
                              </div>
                              <button
                                onClick={() => toggleRowPlay(part)}
                                disabled={!rowPlayable && playingScope !== part}
                                title={rowPlayable
                                  ? "Écouter uniquement ce stem, selon le choix ci-contre (redémarre depuis le début)"
                                  : (stemSelection[part] === "mute" ? "Stem muet — rien à écouter" : "Fichier(s) manquant(s) pour ce stem")}
                                style={{
                                  width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                                  border: "1px solid rgba(0,234,255,0.3)",
                                  background: rowPlaying ? "rgba(0,234,255,0.28)" : "rgba(0,234,255,0.08)",
                                  color: "var(--cyan)", fontSize: 10,
                                  cursor: (rowPlayable || rowPlaying) ? "pointer" : "default",
                                  opacity: (rowPlayable || rowPlaying) ? 1 : 0.35,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                }}
                              >{rowPlaying ? "⏸" : "▶"}</button>
                            </div>
                          );
                        })}
                      </div>
                    </Module>

                    {/* Clé/BPM — promu au premier plan, réglable ET écoutable
                        AVANT génération (cf. moteur Web Audio plus haut). Le
                        petit bouton ▲/▼ reste disponible pour replier le
                        module et gagner de la place, mais reste OUVERT par
                        défaut. Boutons +/- (STEPPER_BTN_STYLE) ajoutés de
                        part et d'autre des sliders pour un réglage pas à pas
                        (retour utilisateur, en plus du glissé). */}
                    <Module
                      title={<>🎚 CLÉ / BPM {hasManualOverride && <span style={{ color: "#ffaa00" }}>· manuel</span>}</>}
                      style={{ border: "1px solid var(--green)", marginBottom: 0 }}
                      right={
                        <button
                          onClick={() => setShowAdvanced(v => !v)}
                          title={showAdvanced ? "Replier" : "Déplier"}
                          style={{ background: "transparent", border: "none", color: "var(--muted2)", fontSize: 11, cursor: "pointer", padding: 2 }}
                        >{showAdvanced ? "▲" : "▼"}</button>
                      }
                    >
                      {showAdvanced && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                          <div style={{ fontSize: 9.5, color: "var(--muted2)", lineHeight: 1.4 }}>
                            Écoutable en direct dans le player ci-dessous (voix pitchée, instrumental étiré en tempo) —
                            bouge/clique pendant la lecture pour entendre l'effet immédiatement, avant de générer.
                          </div>
                          <div>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted2)", marginBottom: 3 }}>
                              <span>🎤 Clé / octave (voix)</span>
                              <span style={{ fontWeight: 700, color: manualPitch !== null ? "#ffd600" : "var(--muted2)" }}>
                                {pitchValue > 0 ? "+" : ""}{pitchValue.toFixed(0)} demi-ton(s){manualPitch === null ? " (auto)" : ""}
                              </span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <button
                                onClick={() => setManualPitch(Math.max(-6, (manualPitch ?? 0) - 1))}
                                title="− 1 demi-ton" style={STEPPER_BTN_STYLE}
                              >−</button>
                              <input type="range" min="-6" max="6" step="1" value={pitchValue}
                                onChange={e => setManualPitch(Number(e.target.value))}
                                style={{ flex: 1, accentColor: "#ffd600" }} />
                              <button
                                onClick={() => setManualPitch(Math.min(6, (manualPitch ?? 0) + 1))}
                                title="+ 1 demi-ton" style={STEPPER_BTN_STYLE}
                              >+</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted2)", marginBottom: 3 }}>
                              <span>🎹 BPM (tempo instrumental)</span>
                              <span style={{ fontWeight: 700, color: manualTempo !== null ? "#ffd600" : "var(--muted2)" }}>
                                {tempoValue >= 1 ? "+" : ""}{Math.round((tempoValue - 1) * 100)}%{manualTempo === null ? " (auto)" : ""}
                              </span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <button
                                onClick={() => setManualTempo(Math.max(0.5, Math.round(((manualTempo ?? 1) - 0.01) * 100) / 100))}
                                title="− 1%" style={STEPPER_BTN_STYLE}
                              >−</button>
                              <input type="range" min="0.5" max="2" step="0.01" value={tempoValue}
                                onChange={e => setManualTempo(Number(e.target.value))}
                                style={{ flex: 1, accentColor: "#ffd600" }} />
                              <button
                                onClick={() => setManualTempo(Math.min(2, Math.round(((manualTempo ?? 1) + 0.01) * 100) / 100))}
                                title="+ 1%" style={STEPPER_BTN_STYLE}
                              >+</button>
                            </div>
                          </div>
                          {hasManualOverride && (
                            <button onClick={handleResetAdvanced} style={{
                              alignSelf: "flex-start", padding: "4px 10px", borderRadius: 6,
                              background: "transparent", border: "1px solid var(--border)",
                              color: "var(--muted2)", fontSize: 10, fontWeight: 700, cursor: "pointer",
                            }}>↺ Auto</button>
                          )}
                          {manualTempo !== null && (
                            <div style={{ fontSize: 10, color: "#ffaa00", lineHeight: 1.4,
                              background: "rgba(255,170,0,0.08)", border: "1px solid rgba(255,170,0,0.3)",
                              borderRadius: 6, padding: "6px 8px" }}>
                              ⚠ Tempo réglé manuellement : le mashup sera généré en AUDIO SEUL (pas de vidéo).
                            </div>
                          )}
                        </div>
                      )}
                    </Module>
                  </div>

                  {/* ── Module 5 : player de combinaison, cette fois à côté du
                      bouton de génération plutôt qu'au-dessus (retour
                      utilisateur, juillet 2026 : nouvelle disposition). ── */}
                  <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
                    <Module title="▶ APERÇU DE LA COMBINAISON" style={{ flex: "1 1 220px", marginBottom: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button
                          onClick={handleComboPlayPause}
                          disabled={playingScope !== "global" && !livePreviewReady}
                          title={livePreviewReady
                            ? "Joue tous les stems selon leur état ci-dessus, avec les réglages clé/BPM appliqués en direct"
                            : "En attente de l'analyse complète des 2 morceaux (stems Demucs), ou tous les stems sont muets"}
                          style={{
                            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                            border: "1px solid rgba(0,234,255,0.4)",
                            background: playingScope === "global" ? "rgba(0,234,255,0.28)" : "rgba(0,234,255,0.1)",
                            color: "var(--cyan)", fontSize: 12,
                            cursor: (playingScope === "global" || livePreviewReady) ? "pointer" : "default",
                            opacity: (playingScope === "global" || livePreviewReady) ? 1 : 0.4,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >{playingScope === "global" ? "⏸" : "▶"}</button>
                        <span style={{ fontSize: 10, color: "var(--muted2)", width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {formatTime(currentTime)}
                        </span>
                        <input
                          type="range" min={0} max={comboDuration || 0.001} step={0.05}
                          value={Math.min(currentTime, comboDuration || 0)}
                          disabled={!comboDuration}
                          onChange={e => handleComboSeek(Number(e.target.value))}
                          style={{ flex: 1, accentColor: "#00eaff" }}
                        />
                        <span style={{ fontSize: 10, color: "var(--muted2)", width: 30, fontVariantNumeric: "tabular-nums" }}>
                          {formatTime(comboDuration)}
                        </span>
                      </div>
                      <div style={{ fontSize: 9, color: "var(--muted2)", marginTop: 3, textAlign: "center" }}>
                        Change un réglage pendant l'écoute pour comparer sans tout couper.
                      </div>
                      {livePreviewError && (
                        <div style={{
                          marginTop: 6, fontSize: 10, lineHeight: 1.4, color: "#ff6b6b",
                          background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.3)",
                          borderRadius: 6, padding: "6px 8px",
                        }}>
                          ⚠ {livePreviewError}
                        </div>
                      )}
                    </Module>

                    <button onClick={handleStemsMashup} disabled={stemsMashupLoading} style={{
                      flex: "0 1 130px", minWidth: 110, padding: "9px 8px", borderRadius: 7,
                      background: "rgba(204,0,255,0.1)", border: "1px solid rgba(204,0,255,0.3)",
                      color: "var(--magenta)", fontSize: 11.5, fontWeight: 800, cursor: stemsMashupLoading ? "default" : "pointer",
                      letterSpacing: 0.5, opacity: stemsMashupLoading ? 0.6 : 1,
                      display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", lineHeight: 1.3,
                    }}>{stemsMashupLoading ? "GÉNÉRATION…" : "🎚 GÉNÉRER MASHUP À LA CARTE"}</button>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted2)", lineHeight: 1.4, marginTop: 6 }}>
                    Les stems venant du morceau minoritaire sont automatiquement recalés
                    (tempo + tonalité) sur celui majoritaire avant combinaison. "A+B" mixe
                    réellement les 2 morceaux pour ce stem ; "🔇 Muet" l'exclut du mashup final.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
