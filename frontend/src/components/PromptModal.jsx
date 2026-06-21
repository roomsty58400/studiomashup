import React, { useState, useMemo } from "react";
import ModalBase from "./ModalBase";
import { copyToClipboard } from "../utils/clipboard";
import Toast from "./Toast";

export default function PromptModal({ data, onClose }) {
  const [toast, setToast] = useState({ visible: false, message: "" });

  const prompt = useMemo(() => {
    const base = data?.summary || data?.video?.title || "Description du mashup";
    return `Style: mashup, énergique, moderne
Ambiance: soirée, danse, public enthousiaste
Description: ${base}
Vocal: mix voix principale + choeurs, dynamique
Structure: intro courte, drop puissant, break, final explosif`;
  }, [data]);

  const handleCopy = async () => {
    const res = await copyToClipboard(prompt);
    setToast({ visible: true, message: res.ok ? "Prompt copié" : "Impossible de copier" });
    setTimeout(() => setToast({ visible: false, message: "" }), 1500);
  };

  const headerActions = (
    <button onClick={handleCopy} className="btn-small">Copier</button>
  );

  return (
    <>
      <ModalBase title={`Prompt Suno – ${data.video.title}`} onClose={onClose} headerActions={headerActions}>
        <pre className="prompt-pre">{prompt}</pre>
      </ModalBase>
      <Toast message={toast.message} visible={toast.visible} />
    </>
  );
}
