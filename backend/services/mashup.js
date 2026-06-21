import express from "express";
import { downloadAudio } from "../services/ytdlp.js";
import { extractAudio, exportMP3, exportMP4_916 } from "../services/ffmpeg.js";
import { mixTracks } from "../services/mashupEngine.js";
import fs from "fs";

const router = express.Router();

router.post("/", async (req, res) => {
  const { videoA, videoB, mode, format, title } = req.body;

  try {
    const tmpA = `tmp/a-${Date.now()}.mp4`;
    const tmpB = `tmp/b-${Date.now()}.mp4`;
    const wavA = `tmp/a-${Date.now()}.wav`;
    const wavB = `tmp/b-${Date.now()}.wav`;
    const mixed = `tmp/mixed-${Date.now()}.wav`;
    const final = `tmp/final-${Date.now()}.${format}`;

    await downloadAudio(videoA, tmpA);
    await downloadAudio(videoB, tmpB);

    await extractAudio(tmpA, wavA);
    await extractAudio(tmpB, wavB);

    await mixTracks(wavA, wavB, mode, mixed);

    if (format === "mp3") await exportMP3(mixed, final);
    else await exportMP4_916(mixed, final);

    res.json({ file: final });
  } catch (err) {
    console.error("MASHUP ERROR:", err);
    res.status(500).json({ error: "Mashup failed" });
  }
});

export default router;
