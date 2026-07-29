import express from "express";
import { generateCover } from "../services/coverAI.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const { titleA, artistA, titleB, artistB, mashupTitle, format } = req.body;
  try {
    const cover = await generateCover({ titleA, artistA, titleB, artistB, mashupTitle, format });
    res.json(cover);
  } catch (err) {
    console.error("[cover]", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
