import React, { useRef } from "react";

export default function AudioUploader({ label, onLoaded }) {
  const inputRef = useRef(null);

  const handleChange = (e) => {
    const file = e.target.files[0];
    if (file) onLoaded(file);
  };

  return (
    <div style={{ marginBottom: "12px" }}>
      <label style={{ marginRight: "10px", fontWeight: "bold" }}>{label}</label>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        onChange={handleChange}
        style={{ color: "white" }}
      />
    </div>
  );
}
