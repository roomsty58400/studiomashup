import React, { useState } from "react";
import TopBar from "./components/TopBar.jsx";
import MashupStudio from "./pages/MashupStudio.jsx";
import ClipEditor from "./pages/ClipEditor.jsx";

export default function App() {
  const [view, setView] = useState("studio"); // "studio" | "clip"

  return (
    <>
      <TopBar activeView={view} onChangeView={setView} />
      {view === "studio" ? <MashupStudio /> : <ClipEditor />}
    </>
  );
}