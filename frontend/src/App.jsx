import React, { useState } from "react";
import TopBar from "./components/TopBar.jsx";
import MashupStudio from "./pages/MashupStudio.jsx";
import ClipEditor from "./pages/ClipEditor.jsx";
import MashupWheel from "./pages/MashupWheel.jsx";
import Ext from "./pages/Ext.jsx";
import MacheupDJ from "./pages/MacheupDJ.jsx";
import DjPlaylist from "./pages/DjPlaylist.jsx";

export default function App() {
  const [view, setView] = useState("studio"); // "studio" (2 à 5 decks, fusion MacheUp/MULTI) | "clip" | "wheel" | "ext" | "dj" | "djplaylist"

  // Paire de vidéos choisie dans Mashup Wheel ("Envoyer en Deck A/B") — à
  // précharger dans les decks du Studio au prochain affichage. Pas besoin de
  // la "consommer"/effacer après coup : Deck.jsx ne réapplique un preset que
  // si son id change réellement (cf. presetAppliedRef), donc la laisser en
  // mémoire ici n'entraîne aucune ré-application intempestive si l'utilisateur
  // modifie ensuite les decks à la main.
  const [pendingPair, setPendingPair] = useState(null); // { trackA, trackB } | null

  const sendToStudio = (pair) => {
    setPendingPair(pair);
    setView("studio");
  };

  // ── Envoi vers DJMUP (page EXT.) depuis Mashup Wheel — "roue" ③ de pioche
  // aléatoire (juillet 2026, demande explicite : "générer un mashup dans
  // DJMUP") ────────────────────────────────────────────────────────────────
  // Même principe que sendToStudio/pendingPair ci-dessus, mais vers la page
  // EXT. plutôt que Studio, avec un drapeau autoStart optionnel pour lancer
  // directement l'automatisation RaveDJ (bouton 🤖 AUTO) sans étape
  // intermédiaire — cf. Ext.jsx, presetPair.
  const [pendingExtPair, setPendingExtPair] = useState(null); // { trackA, trackB, autoStart } | null
  const sendToExt = (pair) => {
    setPendingExtPair(pair);
    setView("ext");
  };

  // ── Bouton DEMO de la TopBar (juillet 2026, remplace l'ancien bouton SET
  // qui n'avait jamais eu de fonction) ────────────────────────────────────
  // Charge dans les Decks A/B les 2 pistes utilisées pour les tests en
  // conditions réelles de l'app (Darude - Sandstorm × Eiffel 65 - Blue, cf.
  // rapport-audit-2026-07-26.md) et passe le panneau COMBO en mode "à la
  // carte" avec "Durée ciblée (façon RaveDJ)" activé (cf. ComboPanel.jsx,
  // demoToken) — un seul clic pour retrouver l'état de démo/test habituel,
  // sans avoir à rechercher les 2 morceaux à la main. `tailored: true` sert
  // de signal pour ComboPanel (peu importe trackA/trackB) ; sendToStudio
  // crée toujours un nouvel objet, donc le useEffect de ComboPanel se
  // redéclenche même en cliquant DEMO plusieurs fois de suite.
  const handleDemo = () => {
    sendToStudio({
      trackA: { id: "erb4n8PW2qw", title: "Darude - Sandstorm (Official Video)", channel: "Darude", thumb: "https://i.ytimg.com/vi/erb4n8PW2qw/hqdefault.jpg" },
      trackB: { id: "4iwHb189X84", title: "Eiffel 65 - Blue (Da Ba Dee) 1998 Official Music Video (Remastered) HD", channel: "Eiffel 65", thumb: "https://i.ytimg.com/vi/4iwHb189X84/hqdefault.jpg" },
      tailored: true,
    });
  };

  // Pistes A/B actuellement chargées dans le Studio (id/title/channel
  // YouTube seulement) — remontées ici pour que la page EXT. (fenêtre
  // d'émulation RaveDJ) sache quoi proposer sans dupliquer l'état du Studio.
  // Mis à jour par MashupStudio via onTracksChange à chaque changement de
  // Deck A/B ; survit à un changement de vue (l'utilisateur peut aller sur
  // EXT. sans perdre la référence à ce qui est chargé dans le Studio).
  const [currentTracks, setCurrentTracks] = useState({ A: null, B: null });

  // Les 4 pages restent montées en permanence (au lieu d'un rendu conditionnel
  // `view === "x" && <X/>`) pour que changer de vue ne détruise plus leur état
  // interne (decks chargés, sélection de stems, résultats d'analyse, etc.).
  // Un rendu conditionnel démonte/remonte le composant à chaque bascule, ce
  // qui réinitialise tous ses useState — d'où le bug "ça vide les decks".
  // À la place, chaque page est enveloppée dans un div dont le `display`
  // bascule entre "contents" (page active : le div devient invisible pour la
  // mise en page, ses enfants restent des enfants flex directs de #root
  // exactement comme avant) et "none" (page inactive : masquée mais son état
  // React continue de vivre en arrière-plan).
  return (
    <>
      <TopBar activeView={view} onChangeView={setView} onDemo={handleDemo} />
      <div style={{ display: view === "studio" ? "contents" : "none" }}>
        <MashupStudio pendingPair={pendingPair} onTracksChange={setCurrentTracks} />
      </div>
      <div style={{ display: view === "clip" ? "contents" : "none" }}>
        <ClipEditor />
      </div>
      <div style={{ display: view === "wheel" ? "contents" : "none" }}>
        <MashupWheel onSendToStudio={sendToStudio} onSendToExt={sendToExt} />
      </div>
      <div style={{ display: view === "ext" ? "contents" : "none" }}>
        <Ext trackA={currentTracks.A} trackB={currentTracks.B} presetPair={pendingExtPair} />
      </div>
      <div style={{ display: view === "dj" ? "contents" : "none" }}>
        <MacheupDJ />
      </div>
      <div style={{ display: view === "djplaylist" ? "contents" : "none" }}>
        <DjPlaylist />
      </div>
    </>
  );
}