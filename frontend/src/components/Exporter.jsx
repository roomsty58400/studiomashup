import React, { useState } from "react";

export default function Exporter({ trackA, trackB, mix }) {
  const [status, setStatus] = useState("");

  const handleExport = async () => {
    if (!trackA || !trackB) {
      setStatus("⚠️ Veuillez charger les deux pistes avant d'exporter.");
      return;
    }

    setStatus("⏳ Mixage en cours...");

    try {
      const audioCtx = new AudioContext();

      const [bufA, bufB] = await Promise.all([
        trackA.arrayBuffer().then((ab) => audioCtx.decodeAudioData(ab)),
        trackB.arrayBuffer().then((ab) => audioCtx.decodeAudioData(ab)),
      ]);

      const length = Math.max(bufA.length, bufB.length);
      const output = audioCtx.createBuffer(2, length, audioCtx.sampleRate);

      for (let ch = 0; ch < 2; ch++) {
        const out = output.getChannelData(ch);
        const a = bufA.getChannelData(Math.min(ch, bufA.numberOfChannels - 1));
        const b = bufB.getChannelData(Math.min(ch, bufB.numberOfChannels - 1));
        for (let i = 0; i < length; i++) {
          out[i] = (a[i] || 0) * (1 - mix) + (b[i] || 0) * mix;
        }
      }

      // Encode to WAV
      const wav = bufferToWav(output);
      const blob = new Blob([wav], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mashup.wav";
      a.click();
      URL.revokeObjectURL(url);

      setStatus("✅ Export réussi !");
    } catch (err) {
      setStatus("❌ Erreur lors du mixage : " + err.message);
    }
  };

  return (
    <div>
      <button
        onClick={handleExport}
        style={{
          padding: "10px 24px",
          fontSize: "16px",
          background: "#6c63ff",
          color: "white",
          border: "none",
          borderRadius: "8px",
          cursor: "pointer",
        }}
      >
        Exporter le mashup
      </button>
      {status && <p style={{ marginTop: "10px", color: "#ccc" }}>{status}</p>}
    </div>
  );
}

function bufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numChannels * 2;
  const ab = new ArrayBuffer(44 + length);
  const view = new DataView(ab);

  const write = (offset, str) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return ab;
}
