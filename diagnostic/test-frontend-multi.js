// Vérifie que le serveur Vite (déjà lancé, npm run dev côté frontend)
// transforme correctement les nouveaux fichiers de l'écran "MULTI" — sans
// navigateur : vite sert chaque module source à la demande et renvoie une
// erreur HTTP + la stack de compilation en cas de souci de syntaxe/import,
// ce qui suffit à confirmer que rien ne casse le build sans avoir besoin de
// cliquer dans un navigateur (extension Chrome non connectée dans cette
// session, cf. contexte).
const BASE = "http://localhost:5173";
const files = [
  "/src/App.jsx",
  "/src/components/TopBar.jsx",
  "/src/components/Deck.jsx",
  "/src/components/MashupProgressModal.jsx",
  "/src/pages/MashupMultiStudio.jsx",
];

const main = async () => {
  let allOk = true;
  for (const f of files) {
    const res = await fetch(BASE + f);
    const status = res.status;
    const text = await res.text();
    const looksLikeError = text.includes("plugin:vite:") || text.includes("Pre-transform error") || text.includes("Internal server error");
    const ok = status === 200 && !looksLikeError;
    console.log(`${ok ? "✅" : "❌"} ${f} — HTTP ${status}${ok ? "" : "\n" + text.slice(0, 1500)}`);
    if (!ok) allOk = false;
  }
  console.log(allOk ? "\n>>> TOUT COMPILE OK" : "\n>>> ERREUR(S) DÉTECTÉE(S)");
};

main().catch(e => { console.error("❌ ÉCHEC SCRIPT :", e.message); process.exit(1); });
