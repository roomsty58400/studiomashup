import React, { useEffect, useState } from "react";
import { buildDownloadUrl, triggerDownload } from "../utils/download.js";

// Labels courts — affichés sous la roue, pas de place pour des libellés longs
// dans ce cadre carré (même contrainte qu'avant : ≈270px de large max).
const STEPS = [
  { id: "download", label: "Téléch.", icon: "⬇" },
  { id: "analyze",  label: "Analyse", icon: "🎵" },
  { id: "separate", label: "Stems",   icon: "🧬" },
  { id: "mix",      label: "Mixage",  icon: "🎛" },
  { id: "render",   label: "Rendu",   icon: "🎬" },
];

// ── Roue de progression superposée au cadre "image du mashup" ──────────────
// Demande explicite : le suivi de traitement doit se superposer au cadre où
// s'affichera ensuite l'image/le player du mashup (comme la pochette IA ou
// le mini player, cf. Mixer.jsx), sous forme de roue circulaire plutôt qu'une
// barre linéaire + pastilles d'étapes. Le cadre carré ci-dessous reprend donc
// EXACTEMENT les mêmes dimensions (maxWidth/maxHeight 273, aspect-ratio 1/1)
// que le carré pochette/player qui prendra sa place juste après — transition
// visuelle continue, pas de saut de taille au moment où le mashup est prêt.
const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// statusUrlBase : préfixe du endpoint de statut à interroger — par défaut
// "/api/mashup" (comportement historique, inchangé pour tous les appelants
// existants qui ne passent pas cette prop). Ajouté (Phase 5 UI multi-sources)
// pour pouvoir réutiliser ce même composant tel quel avec la route dédiée
// "/api/mashup-multi/:id/status" plutôt que d'en dupliquer une copie quasi
// identique — le format de statut renvoyé est le même dans les 2 cas
// (status/step/label/flacUrl/mp4Url), cf. mashupMulti.js.
export default function MashupProgressBar({ jobId, onClose, onDone, onError, overlay = false, statusUrlBase = "/api/mashup" }) {
  const [status, setStatus]       = useState("pending");
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError]         = useState(null);
  const [resultUrl, setResultUrl] = useState(null);

  useEffect(() => {
    if (!jobId) return;
    // Compte les ratés CONSÉCUTIFS de polling (réseau, ou backend simplement
    // occupé/lent pendant un Demucs/ffmpeg lourd qui bloque un instant la
    // boucle d'événements Node) — distinct d'un VRAI échec de job. Un simple
    // raté de polling NE DOIT JAMAIS déclencher onError : le job en cours
    // tourne très probablement toujours côté serveur, et relancer une 2e
    // création tout aussi lourde EN PARALLÈLE de la 1ère (qui n'a pas
    // forcément planté) peut saturer le CPU/GPU et faire planter le process
    // — c'est exactement ce qui s'est produit.
    let consecutiveFetchFails = 0;
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`http://localhost:3001${statusUrlBase}/${jobId}/status`);
        const data = await res.json();
        // Vérification res.ok ajoutée (audit juillet 2026) : sans ça, un 404
        // "Job introuvable" (job en mémoire perdu après un redémarrage
        // backend, cf. bug déjà rencontré côté Mashup Wheel) était traité
        // comme une réponse de statut normale — data.status valait undefined
        // (ni "done" ni "error"), donc le polling continuait indéfiniment
        // toutes les 1.5s sans jamais rien afficher à l'utilisateur, la roue
        // de progression restant bloquée en silence. Un 404 est une réponse
        // DÉFINITIVE du serveur (pas un raté réseau ponctuel) : on l'affiche
        // directement comme erreur plutôt que de la compter dans
        // consecutiveFetchFails.
        if (!res.ok) {
          setError(data.error || `Erreur serveur (${res.status})`);
          clearInterval(interval);
          if (onError) onError(data);
          return;
        }
        consecutiveFetchFails = 0;
        setStatus(data.status);
        if (data.step !== undefined) setCurrentStep(data.step);
        if (data.status === "done") {
          // FLAC + MP4 sont désormais toujours générés ensemble — on garde
          // le lien FLAC ici pour le bouton "Télécharger" rapide du modal.
          setResultUrl(data.flacUrl);
          clearInterval(interval);
          if (onDone) onDone(data);
        }
        if (data.status === "error") {
          // Ici seulement le job est CONFIRMÉ arrêté côté serveur (son
          // process a déjà catché l'erreur et libéré ses ressources) — sans
          // risque de double création en parallèle.
          setError(data.message || "Erreur inconnue");
          clearInterval(interval);
          if (onError) onError(data);
        }
      } catch {
        consecutiveFetchFails += 1;
        // Tolère quelques ratés avant d'abandonner le suivi (le serveur peut
        // juste être temporairement lent/occupé) — et même après abandon, on
        // NE relance PAS automatiquement : on ignore juste ce job, sans
        // risquer d'en cumuler un 2e dessus.
        if (consecutiveFetchFails >= 5) {
          setError("Connexion au serveur perdue.");
          clearInterval(interval);
        }
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [jobId, statusUrlBase]);

  const isDone   = status === "done";
  const isError  = status === "error";
  const pct      = isDone ? 100 : Math.round((currentStep / STEPS.length) * 100);
  const step     = STEPS[Math.min(currentStep, STEPS.length - 1)];
  const ringColor = isError ? "#ff4444" : isDone ? "#00eaff" : "#00eaff";
  const dashOffset = CIRCUMFERENCE * (1 - pct / 100);

  // overlay=true (demande explicite : "le carré de la barre de progression
  // superposé sur l'image de la pochette, comme un calque transparent") :
  // ce composant ne possède alors plus son propre cadre carré opaque — il se
  // pose EN CALQUE, en position absolute, par-dessus la pochette (ou son
  // spinner "GÉNÉRATION…") déjà affichée dans le même cadre par le parent
  // (cf. Mixer.jsx) — fond semi-transparent + léger flou, pour que l'image
  // en dessous reste devinable au travers plutôt que totalement masquée.
  const containerStyle = overlay
    ? {
        position: "absolute", inset: 0, borderRadius: 8, overflow: "hidden",
        background: isError ? "rgba(40,0,0,0.55)" : "rgba(5,8,10,0.55)",
        backdropFilter: "blur(2px)",
      }
    : {
        position: "relative", width: "100%", maxWidth: 273, maxHeight: 273,
        aspectRatio: "1 / 1", margin: "0 auto", borderRadius: 8, overflow: "hidden",
        background: "#0a0a0a",
        border: `1px solid ${isError ? "rgba(255,68,68,0.3)" : "rgba(0,234,255,0.15)"}`,
        boxShadow: isError ? "0 0 20px rgba(255,68,68,0.1)" : "0 0 24px rgba(0,234,255,0.08)",
      };

  return (
    <div style={containerStyle}>
      {/* Fond "cadre image" — uniquement en mode autonome (pas de pochette à
          superposer) : texture discrète en attendant la vraie pochette/le
          vrai player. En mode overlay, ce fond est omis — c'est justement la
          pochette DU PARENT qui doit rester visible en transparence. */}
      {!overlay && (
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(circle at 50% 40%, #151515, #0a0a0a)",
        }} />
      )}

      {/* Bouton fermer — coin haut droit, au-dessus de la roue */}
      <button onClick={onClose} style={{
        position: "absolute", top: 8, right: 8, zIndex: 2,
        background: "rgba(0,0,0,0.5)", border: "1px solid #2a2a2a", color: "#666",
        borderRadius: 6, padding: "3px 7px", cursor: "pointer", fontSize: 11, lineHeight: 1,
      }}
        onMouseEnter={e => e.currentTarget.style.color = "white"}
        onMouseLeave={e => e.currentTarget.style.color = "#666"}>
        ✕
      </button>

      {/* Roue de progression circulaire, superposée au centre du cadre */}
      <div style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 10,
      }}>
        <svg width="128" height="128" viewBox="0 0 128 128" style={{ transform: "rotate(-90deg)" }}>
          <defs>
            <linearGradient id="progressWheelGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#00eaff" />
              <stop offset="100%" stopColor="#cc00ff" />
            </linearGradient>
          </defs>
          {/* Piste de fond */}
          <circle cx="64" cy="64" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
          {/* Progression */}
          <circle
            cx="64" cy="64" r={RADIUS} fill="none"
            stroke={isError ? ringColor : "url(#progressWheelGradient)"}
            strokeWidth="8" strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            style={{ transition: "stroke-dashoffset 0.6s ease" }}
          />
        </svg>

        {/* Contenu centré DANS la roue (pourcentage + icône/étape) */}
        <div style={{ position: "absolute", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          {isError ? (
            <span style={{ fontSize: 26 }}>❌</span>
          ) : isDone ? (
            <span style={{ fontSize: 26 }}>✅</span>
          ) : (
            <>
              <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 22, fontWeight: 900, color: "#00eaff" }}>
                {pct}%
              </div>
              <div style={{ fontSize: 16 }}>{step?.icon}</div>
            </>
          )}
        </div>
      </div>

      {/* Bandeau bas — statut texte + étape courante + téléchargement rapide,
          même bandeau dégradé que le titre affiché sous la pochette IA une
          fois le mashup prêt (cohérence visuelle de transition). */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        background: "linear-gradient(transparent, rgba(0,0,0,0.9))",
        padding: "16px 10px 8px", textAlign: "center",
      }}>
        <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 11, fontWeight: 900, letterSpacing: 1,
          color: isError ? "#ff4444" : isDone ? "#00eaff" : "#fff" }}>
          {isError ? "ERREUR" : isDone ? "PRÊT !" : "CRÉATION EN COURS…"}
        </div>
        {!isDone && !isError && (
          <div style={{ fontSize: 10, color: "#666", marginTop: 2, letterSpacing: 0.5 }}>
            {step?.label}
          </div>
        )}
        {isDone && resultUrl && (
          // <a download> ignoré en cross-origin (:5173 → :3001) — passe par la
          // route backend qui force Content-Disposition, cf. utils/download.js.
          <button type="button" onClick={() => triggerDownload(buildDownloadUrl(resultUrl))}
            style={{ display: "inline-block", marginTop: 6, padding: "4px 10px", borderRadius: 6,
              background: "#00eaff", color: "#000", fontWeight: 800, fontSize: 10.5,
              border: "none", cursor: "pointer", letterSpacing: 0.5 }}>
            ⬇ FLAC
          </button>
        )}
        {isError && error && (
          <div style={{ fontSize: 10, color: "#ff6666", marginTop: 4, maxHeight: 40, overflow: "hidden", textOverflow: "ellipsis" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
