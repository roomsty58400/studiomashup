import React, { useEffect, useRef } from "react";

export default function AudioPlayer({ file, title }) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (file && audioRef.current) {
      const url = URL.createObjectURL(file);
      audioRef.current.src = url;
      return () => URL.revokeObjectURL(url);
    }
  }, [file]);

  if (!file) return (
    <div style={{ marginBottom: "10px", color: "#888" }}>
      {title} — aucune piste chargée
    </div>
  );

  return (
    <div style={{ marginBottom: "10px" }}>
      <span style={{ marginRight: "10px" }}>{title}</span>
      <audio ref={audioRef} controls style={{ verticalAlign: "middle" }} />
    </div>
  );
}
