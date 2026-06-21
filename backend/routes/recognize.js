import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const upload = multer({
  dest: join(__dirname, "../tmp"),
  limits: { fileSize: 12 * 1024 * 1024 },
});

router.post("/", upload.single("audio"), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ found: false, message: "Fichier audio manquant" });

    const apiToken = process.env.AUDD_API_KEY || "";

    // Lire le fichier et le transmettre à AudD
    const fileBuffer = readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: req.file.mimetype || "audio/mpeg" });

    const formData = new FormData();
    if (apiToken) formData.append("api_token", apiToken);
    formData.append("return", "spotify,apple_music");
    formData.append("file", blob, req.file.originalname || "sample.mp3");

    console.log("[Recognize] Envoi à AudD…");
    const response = await fetch("https://api.audd.io/", {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(20000),
    });

    const data = await response.json();
    console.log("[Recognize] Réponse AudD :", data.status, data.result?.title || "(rien)");

    if (data.status === "success" && data.result) {
      const r = data.result;
      const artwork =
        r.spotify?.album?.images?.[0]?.url ||
        r.apple_music?.artwork?.url?.replace("{w}x{h}", "300x300") ||
        null;

      return res.json({
        found: true,
        title:       r.title       || null,
        artist:      r.artist      || null,
        album:       r.album       || null,
        releaseDate: r.release_date || null,
        artwork,
        score:       r.score ?? null,
      });
    }

    // Pas reconnu ou erreur AudD
    let msg = data.error?.error_message || "Chanson non reconnue";

    // Cas précis : pas de clé API configurée → AudD bascule sur son quota
    // anonyme, très limité, vite épuisé. Sans ce message, ça ressemblait à
    // un "vrai" échec de reconnaissance alors que c'est un souci de config.
    if (!apiToken && /api_token/i.test(msg)) {
      msg = "Quota Shazam anonyme épuisé : ajoute une clé AUDD_API_KEY (gratuite sur dashboard.audd.io) dans backend/.env pour débloquer la reconnaissance.";
    }

    res.json({ found: false, message: msg });

  } catch (err) {
    console.error("[Recognize] Erreur :", err.message);
    res.status(500).json({ found: false, message: "Erreur serveur : " + err.message });
  } finally {
    if (filePath && existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
  }
});

export default router;
