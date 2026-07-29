// Vérifie que le serveur Vite (déjà lancé, npm run dev côté frontend)
// transforme correctement les fichiers touchés par la fusion MacheUp/MULTI
// (decks A-E, un seul bouton, retrait de l'écran MULTI séparé).
const BASE = "http://localhost:5173";
const files = [
  "/src/App.jsx",
  "/src/components/TopBar.jsx",
  "/src/components/ComboPanel.jsx",
  "/src/components/Deck.jsx",
  "/src/pages/MashupStudio.jsx",
  "/src/styles.css",
];

const main = async () => {
  let allOk = true;
  for (const f of files) {
    const res = await fetch(BASE + f);
    const status = res.status;
    const text = await res.text();
    const looksLikeError = text.includes("plugin:vite:") || text.includes("Pre-transform error") || text.includes("Internal server error");
    const ok = status === 200 && !looksLikeError;
    console.log(`${ok ? "OK" : "FAIL"} ${f} - HTTP ${status}${ok ? "" : "\n" + text.slice(0, 1500)}`);
    if (!ok) allOk = false;
  }
  console.log(allOk ? "\n>>> TOUT COMPILE OK" : "\n>>> ERREUR(S) DETECTEE(S)");
};

main().catch(e => { console.error("ECHEC SCRIPT:", e.message); process.exit(1); });
