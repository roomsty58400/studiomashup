import React from "react";

export default function ModalBase({ isOpen, onClose, title, headerActions, children }) {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          padding: "20px",
          borderRadius: "12px",
          maxWidth: "800px",
          width: "90%",
          boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {headerActions}
            <button onClick={onClose} aria-label="Fermer">✕</button>
          </div>
        </div>

        <div>{children}</div>
      </div>
    </div>
  );
}
