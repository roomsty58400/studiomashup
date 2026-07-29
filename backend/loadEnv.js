// ── Chargement de backend/.env AVANT tout le reste (audit perf juillet 2026) ──
// Bug pré-existant découvert en vérifiant que DEMUCS_MODEL/DEMUCS_PYTHON/
// DEREVERB_PYTHON/DEMUCS_WORKER (tous documentés comme "configurables via
// backend/.env" dans les commentaires de services/demucs.js et dereverb.js)
// fonctionnaient réellement : en ESM, TOUS les imports d'un module sont
// évalués (leur code de plus haut niveau s'exécute) AVANT le corps propre du
// module qui les importe. Comme server.js appelait `dotenv.config()` dans son
// PROPRE corps (après ses imports), ce chargement intervenait en réalité
// APRÈS que services/demucs.js (importé transitivement via routes/mashup.js)
// ait déjà évalué `const DEMUCS_MODEL = process.env.DEMUCS_MODEL || "..."` —
// à ce moment-là, .env n'était pas encore chargé, donc process.env.DEMUCS_MODEL
// valait toujours `undefined`, et TOUTE valeur mise dans backend/.env pour ces
// variables était silencieusement ignorée, sans le moindre message d'erreur.
// Solution : isoler `dotenv.config()` dans SON PROPRE module, importé en tout
// premier dans server.js (avant les routes) — un import s'évalue entièrement
// avant que l'import suivant ne commence, donc ce fichier garantit que .env
// est chargé avant que quoi que ce soit d'autre ne lise process.env.
import dotenv from "dotenv";
dotenv.config();
