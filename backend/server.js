import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

import youtubeRoutes from "./routes/youtube.js";
import mashupRoutes from "./routes/mashup.js";
import authRoutes, { passport } from "./routes/auth.js";
import promptRoutes from "./routes/prompt.js";
import lyricsRoutes from "./routes/lyrics.js";
import coverRoutes from "./routes/cover.js";
import titlesRoutes from "./routes/titles.js";
import recognizeRoutes from "./routes/recognize.js";
import clipEditorRoutes from "./routes/clipEditor.js";
import stemsRoutes from "./routes/stems.js";
import analyzeRoutes from "./routes/analyze.js";

dotenv.config();

if (!process.env.AUDD_API_KEY) {
  console.warn(
    "⚠️  AUDD_API_KEY manquante dans backend/.env — la reconnaissance Shazam tournera sur le quota anonyme d'AudD (très limité, vite épuisé : \"authorization failed: no api_token passed and the limit was reached\"). Clé gratuite sur https://dashboard.audd.io puis ajouter AUDD_API_KEY=... dans .env."
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Créer les dossiers nécessaires au démarrage
["tmp", "tmp/a", "tmp/b", "tmp/mixed", "data/outputs", "data/outputs/clip-editor", "data/outputs/stems", "data/outputs/analyze"].forEach(d =>
  mkdirSync(join(__dirname, d), { recursive: true })
);

const app = express();

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());

// Session (requis pour Passport)
app.use(session({
  secret: process.env.SESSION_SECRET || "studiomashup-secret-local",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 jours
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Servir les fichiers générés
app.use("/outputs", express.static(join(__dirname, "data/outputs")));

app.use("/api/youtube", youtubeRoutes);
app.use("/api/mashup", mashupRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/prompt", promptRoutes);
app.use("/api/lyrics", lyricsRoutes);
app.use("/api/cover", coverRoutes);
app.use("/api/titles", titlesRoutes);
app.use("/api/recognize", recognizeRoutes);
app.use("/api/clip-editor", clipEditorRoutes);
app.use("/api/stems", stemsRoutes);
app.use("/api/analyze", analyzeRoutes);

app.get("/api/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
