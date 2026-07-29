// Test rapide et isolé : confirme que le watermark a bien disparu des
// exports vidéo, sans repasser par tout le pipeline de mashup (audio,
// alignement, etc.) — juste buildSilentVideoMontage sur une courte durée
// (8s) avec 2 vidéos déjà en cache, puis extraction d'une frame en PNG
// pour inspection visuelle.
import { buildSilentVideoMontage } from "../services/ffmpeg.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const videoA = join(__dirname, "..", "cache/video/ublchJYzhao_1080p.mp4");
const videoB = join(__dirname, "..", "cache/video/YQM7DKi11ho_1080p.mp4");
const silentOutput = join(__dirname, "..", "tmp/test-watermark-silent.mp4");
const framePng = join(__dirname, "..", "tmp/test-watermark-frame.png");

const main = async () => {
  console.log(">>> buildSilentVideoMontage (8s, 2 sources, sans musicSync)...");
  const t0 = Date.now();
  await buildSilentVideoMontage(videoA, videoB, 8, 0.4, silentOutput);
  console.log(`>>> montage terminé en ${((Date.now() - t0) / 1000).toFixed(1)}s : ${silentOutput}`);

  // Frame au milieu (4s) pour voir clairement le coin bas-droit.
  await execFileAsync("ffmpeg", ["-y", "-ss", "4", "-i", silentOutput, "-frames:v", "1", framePng]);
  console.log(`>>> frame extraite : ${framePng}`);
};

main().catch((e) => {
  console.error("❌ ÉCHEC :", e.message);
  process.exit(1);
});
