import express from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Extraction de texte brut d'un PDF (DJPLAYLIST — import d'une setlist/
// playlist au format PDF) ──────────────────────────────────────────────────
// Le texte extrait est renvoyé tel quel ; c'est le même parseur heuristique
// que pour un import .txt (cf. frontend/src/utils/playlistParse.js) qui s'en
// charge ensuite côté client — un seul endroit qui sait "deviner" titre/
// artiste/durée à partir de lignes de texte libres, quelle que soit la
// source (txt collé à la main, ou texte sorti d'un PDF).
router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier PDF manquant." });
  try {
    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    res.json({ text: result.text || "" });
  } catch (err) {
    console.error("❌ [pdf-text] extraction échouée :", err.message);
    res.status(500).json({ error: "PDF illisible : " + err.message });
  }
});

export default router;
