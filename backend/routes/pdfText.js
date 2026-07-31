import express from "express";
import multer from "multer";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Extraction de texte brut d'un PDF (DJPLAYLIST — import d'une setlist/
// playlist au format PDF) ──────────────────────────────────────────────────
// Le texte extrait est renvoyé tel quel ; c'est le même parseur heuristique
// que pour un import .txt (cf. frontend/src/utils/playlistParse.js) qui s'en
// charge ensuite côté client — un seul endroit qui sait "deviner" titre/
// artiste/durée à partir de lignes de texte libres, quelle que soit la
// source (txt collé à la main, ou texte sorti d'un PDF).
//
// CORRECTIF CRITIQUE (31/07) : "pdf-parse" charge "pdfjs-dist", qui tente de
// polyfiller DOMMatrix via le paquet natif @napi-rs/canvas. Sur certaines
// machines (constaté : Windows, Node v26.5.0), ce binding natif échoue à se
// charger et pdfjs-dist PLANTE AU CHARGEMENT DU MODULE (ReferenceError:
// DOMMatrix is not defined). Ce fichier était importé tout en haut de
// server.js — donc AU DÉMARRAGE DU SERVEUR ENTIER, même si personne
// n'utilise jamais l'import PDF — ce qui empêchait TOUT le backend de
// redémarrer après le moindre changement de fichier (nodemon), pas
// seulement cette route. D'où le retour utilisateur "ça bug" en analyse :
// le serveur ne tournait plus du tout, sans rapport avec DJPLAYLIST.
// Fix : import PARESSEUX (dynamique), déclenché seulement quand un PDF est
// réellement soumis — un éventuel échec reste confiné à CETTE route (renvoie
// une erreur claire) au lieu de faire tomber tout le serveur.
let pdfParseModulePromise = null;
function loadPdfParse() {
  if (!pdfParseModulePromise) pdfParseModulePromise = import("pdf-parse");
  return pdfParseModulePromise;
}

router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier PDF manquant." });
  try {
    const { PDFParse } = await loadPdfParse();
    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    res.json({ text: result.text || "" });
  } catch (err) {
    pdfParseModulePromise = null; // ne garde pas en cache un échec de chargement, au cas où
    console.error("❌ [pdf-text] extraction échouée :", err.message);
    res.status(500).json({ error: "Import PDF indisponible sur ce serveur (" + err.message + ") — utilise plutôt un export M3U/TXT en attendant." });
  }
});

export default router;
