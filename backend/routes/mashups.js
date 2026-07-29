// ── Historique persistant des macheups générés (GET/DELETE) ────────────────
// Nouvelle route (juillet 2026), volontairement séparée de routes/mashup.js
// (qui gère la CRÉATION d'un macheup) : celle-ci ne fait que lire/nettoyer
// l'historique déjà écrit par services/mashupHistory.js au moment où un job
// se termine (routes/mashup.js et routes/mashupMulti.js, "status: done").
//
// Corrige le bug "Mes macheups n'affiche jamais qu'une seule entrée" —
// jusqu'ici, MashupsBar.jsx (frontend) ne montrait QUE le state React en
// mémoire de MashupStudio.jsx, remis à zéro à chaque rechargement de page.
// GET / permet au frontend de retrouver tout l'historique après un
// rechargement ; DELETE /:id et DELETE / permettent de vraiment supprimer les
// fichiers du disque (avant ce correctif, le bouton ✕ ne faisait que masquer
// la carte côté React sans jamais toucher au disque).
import express from "express";
import { loadMashupHistory, removeMashupFromHistory, clearMashupHistory } from "../services/mashupHistory.js";

const router = express.Router();

// Liste complète, plus récent en premier (déjà l'ordre stocké par
// addMashupToHistory, qui préfixe systématiquement).
router.get("/", (req, res) => {
  res.json({ mashups: loadMashupHistory() });
});

// Supprime UNE entrée + ses fichiers (FLAC/MP4/MP4 muet) — bouton ✕ par
// carte dans MashupsBar.jsx.
router.delete("/:id", (req, res) => {
  const removed = removeMashupFromHistory(req.params.id);
  res.json({ ok: true, removed: !!removed });
});

// Vide tout l'historique + supprime tous les fichiers correspondants —
// nouveau bouton "🧹 Vider l'historique" (retour utilisateur juillet 2026).
router.delete("/", (req, res) => {
  const count = clearMashupHistory();
  res.json({ ok: true, count });
});

export default router;
