import dotenv from "dotenv";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { bestArtistSong } from "../utils/videoTitle.js";

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const COVERS_DIR = join(__dirname, "../data/outputs/covers");

const NEON_STYLE = "neon lights, glowing neon signs, dark black background, vibrant electric cyan and magenta colors, futuristic glow, cyberpunk aesthetic, high contrast neon art";

const escXml = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

function cleanArtist(name) {
  return (name||"")
    .replace(/VEVO$/i,"").replace(/\s*-?\s*Official(\s+Channel)?$/i,"")
    .replace(/\s*Official\s*(Music|Video|Channel)?$/i,"").replace(/\s*Topic$/i,"").trim();
}

function buildOverlay(w, h, artistA, artistB, mashupTitle) {
  const pad = Math.floor(w * 0.06);
  const maxW = w - pad * 2;
  const titleChars = mashupTitle.length;
  const artistText = cleanArtist(artistA) + " x " + cleanArtist(artistB);
  const artistChars = artistText.length;
  const baseTitleSize  = Math.max(20, Math.floor(w / 13));
  const baseArtistSize = Math.max(14, Math.floor(w / 19));
  const titleSize  = Math.max(14, Math.min(baseTitleSize,  Math.floor(maxW / (titleChars  * 0.58))));
  const artistSize = Math.max(12, Math.min(baseArtistSize, Math.floor(maxW / (artistChars * 0.56))));
  const titleY  = Math.floor(h * 0.82);
  const artistY = Math.floor(h * 0.93);
  const gradY   = Math.floor(h * 0.50);
  const gradH   = h - gradY;
  const cx = Math.floor(w / 2);
  const titleLen  = titleChars  * 0.58 * titleSize  > maxW ? 'textLength="'+maxW+'" lengthAdjust="spacingAndGlyphs"' : "";
  const artistLen = artistChars * 0.56 * artistSize > maxW ? 'textLength="'+maxW+'" lengthAdjust="spacingAndGlyphs"' : "";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'
    + '<defs>'
    + '<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="#000" stop-opacity="0"/>'
    + '<stop offset="100%" stop-color="#000" stop-opacity="0.88"/>'
    + '</linearGradient>'
    + '<filter id="gc"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
    + '<filter id="gw"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
    + '</defs>'
    + '<rect x="0" y="'+gradY+'" width="'+w+'" height="'+gradH+'" fill="url(#fade)"/>'
    + '<text x="'+cx+'" y="'+titleY+'" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-size="'+titleSize+'" font-weight="900" fill="white" filter="url(#gw)" '+titleLen+'>'+escXml(mashupTitle)+'</text>'
    + '<text x="'+cx+'" y="'+artistY+'" text-anchor="middle" font-family="Arial,sans-serif" font-size="'+artistSize+'" font-weight="bold" fill="#00eaff" filter="url(#gc)" '+artistLen+'>'+escXml(artistText)+'</text>'
    + '</svg>';
  return Buffer.from(svg);
}

async function listModels(apiKey) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key="+apiKey, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  return (data.models||[]).map(m => m.name.replace("models/",""));
}

async function buildPrompt(apiKey, titleA, artistA, titleB, artistB) {
  const models = await listModels(apiKey);
  const m = models.filter(m => !m.includes("image")&&!m.includes("embed")&&!m.includes("vision")).find(m => m.includes("flash")||m.includes("pro"));
  if (!m) return "neon cyberpunk mashup of "+artistA+" and "+artistB+", abstract art";
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+m+":generateContent?key="+apiKey, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ contents:[{parts:[{text:'Write a SHORT image prompt (max 40 words) for a neon cyberpunk album cover mashup of "'+titleA+'" by '+artistA+' and "'+titleB+'" by '+artistB+'. No text, no people. Output ONLY the prompt.'}]}], generationConfig:{maxOutputTokens:120,temperature:0.9} }),
    signal: AbortSignal.timeout(12000)
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "neon abstract mashup of "+artistA+" and "+artistB;
}

async function genImagen(apiKey, prompt, format) {
  const ar = format==="16:9"?"16:9":format==="9:16"?"9:16":"1:1";
  for (const model of ["imagen-3.0-generate-001","imagen-3.0-fast-generate-001"]) {
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":predict?key="+apiKey, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({instances:[{prompt}],parameters:{sampleCount:1,aspectRatio:ar}}),
        signal: AbortSignal.timeout(35000)
      });
      const data = await res.json();
      if (data.error) { console.warn("[Imagen]",model,":",data.error.message); continue; }
      const b64 = data.predictions?.[0]?.bytesBase64Encoded;
      if (b64) { console.log("[Imagen] ok:",model); return Buffer.from(b64,"base64"); }
    } catch(e) { console.warn("[Imagen]",model,":",e.message); }
  }
  throw new Error("Imagen indisponible");
}

async function genFlash(apiKey, prompt) {
  for (const model of ["gemini-2.0-flash-preview-image-generation","gemini-2.0-flash-exp-image-generation"]) {
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+apiKey, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({contents:[{parts:[{text:"Generate an image: "+prompt}]}],generationConfig:{responseModalities:["IMAGE","TEXT"]}}),
        signal: AbortSignal.timeout(35000)
      });
      const data = await res.json();
      if (data.error) { console.warn("[Flash]",model,":",data.error.message); continue; }
      const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith("image/"));
      if (part) { console.log("[Flash] ok:",model); return Buffer.from(part.inlineData.data,"base64"); }
    } catch(e) { console.warn("[Flash]",model,":",e.message); }
  }
  throw new Error("Gemini Flash indisponible");
}

export async function generateCover({ titleA, artistA, titleB, artistB, mashupTitle, format="1:1" }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY manquante dans backend/.env");

  // titleA/artistA arrivent du frontend comme (titre vidéo YouTube, nom de
  // chaîne) — ex: ("Stromae - Papaoutai (Official Video)", "StromaeVEVO").
  // Le nom de chaîne n'est pas toujours le nom de l'artiste (VEVO, chaîne de
  // compil/fan...), donc on extrait le VRAI couple artiste/chanson depuis le
  // titre lui-même (même parseur que routes/lyrics.js) pour le prompt IA et
  // le texte affiché sur la pochette, plutôt que d'utiliser le profil YouTube.
  const bestA = bestArtistSong(titleA, artistA);
  const bestB = bestArtistSong(titleB, artistB);
  titleA = bestA.song || titleA;
  artistA = bestA.artist || artistA;
  titleB = bestB.song || titleB;
  artistB = bestB.artist || artistB;

  const dims = {"1:1":[1024,1024],"16:9":[1024,576],"9:16":[576,1024]};
  const [w, h] = dims[format] || [1024,1024];

  const base = await buildPrompt(apiKey, titleA, artistA, titleB, artistB);
  const fullPrompt = base + ", " + NEON_STYLE + ", album cover art, no text, no watermark";
  console.log("[CoverAI] prompt:", fullPrompt);

  // Imagen et Gemini Flash (génération d'image) échouent systématiquement
  // avec ce compte/cette version d'API ("model not found" — confirmé sur de
  // nombreuses générations en log, pas une erreur transitoire) : les tenter
  // à chaque pochette ne fait que perdre du temps avant la bascule vers
  // Pollinations, qui lui fonctionne. On va donc directement sur Pollinations
  // pour des pochettes plus rapides ("réactif"). genImagen/genFlash restent
  // disponibles si l'accès à ces modèles est un jour activé sur ce compte.
  const genPollinations = async () => {
    const url = "https://image.pollinations.ai/prompt/"+encodeURIComponent(fullPrompt)+"?width="+w+"&height="+h+"&nologo=true&model=flux&seed="+Math.floor(Math.random()*999999);
    const r = await fetch(url, { signal: AbortSignal.timeout(40000) });
    return Buffer.from(await r.arrayBuffer());
  };
  let imgBuf;
  try { imgBuf = await genPollinations(); }
  catch(e0) {
    console.warn("[CoverAI] Pollinations failed:", e0.message, "-> repli Imagen/Flash");
    try { imgBuf = await genImagen(apiKey, fullPrompt, format); }
    catch(e1) {
      console.warn("[CoverAI] Imagen failed:", e1.message);
      imgBuf = await genFlash(apiKey, fullPrompt);
    }
  }

  const overlay = buildOverlay(w, h, artistA, artistB, mashupTitle || artistA + " x " + artistB);
  const final = await sharp(imgBuf).resize(w, h, {fit:"cover"}).composite([{input:overlay,top:0,left:0}]).png().toBuffer();

  await mkdir(COVERS_DIR, {recursive:true});
  const filename = "cover-" + Date.now() + ".png";
  await writeFile(join(COVERS_DIR, filename), final);

  return { url: "/outputs/covers/" + filename, prompt: fullPrompt };
}
