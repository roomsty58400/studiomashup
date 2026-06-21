import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// Le lanceur (start.ps1) ouvre la page avec un paramètre anti-cache
// (ex: ?_=1782026052181) pour forcer un chargement frais au démarrage.
// Une fois la page chargée, on nettoie l'URL pour qu'elle affiche juste
// http://localhost:5173/ — sans recharger la page (history.replaceState).
if (window.location.search) {
  window.history.replaceState({}, document.title, window.location.pathname);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
