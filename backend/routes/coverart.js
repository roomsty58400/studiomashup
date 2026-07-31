import express from "express";
import { fetchAlbumArt } from "../services/coverArt.js";
import { bestArtistSong } from "../utils/videoTitle.js";

const router = express.Router();

// GET /api/album-art?title=...&channel=...
// (nommé "album-art" et non "cover" pour ne pas se confondre avec
// /api/cover, qui génère une pochette IA de mashup — ceci récupère la
// VRAIE pochette d'album/EP existante depuis une base de données musicale.)
// Reçoit le titre brut + la chaîne YouTube (mêmes champs que pour les
// paroles / la pochette IA), en extrait le couple {artist, song} le plus
// probable via bestArtistSong(), puis cherche la vraie pochette d'album/EP
// correspondante. Répond toujours 200 avec { url: null } si rien n'est
// trouvé — ce n'est pas une erreur, juste une absence de résultat, et le
// front doit alors garder la miniature YouTube en repli.
router.get("/", async (req, res) => {
  const { title, channel } = req.query;
  if (!title) return res.json({ url: null });
  const { artist, song } = bestArtistSong(title, channel || "");
  const url = await fetchAlbumArt(artist, song);
  res.json({ url });
});

export default router;
