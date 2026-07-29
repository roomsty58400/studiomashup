import express from "express";

const router = express.Router();

// ⚠ NON UTILISÉ actuellement par le frontend (cf. Ext.jsx, section "Tentative
// de masquage des zones promo") : testé en conditions réelles, l'app RaveDJ
// ne rend rien à l'écran une fois servie hors de son propre domaine (bundle
// JS exécuté mais DOM vide — probablement des appels internes bloqués par
// CORS). Laissé ici documenté au cas où l'approche serait reprise (ex. si
// RaveDJ change son architecture), pas branché sur l'iframe pour l'instant.

// ── Proxy d'émulation RaveDJ (juillet 2026) ───────────────────────────────
// Demande explicite : la fenêtre d'émulation RaveDJ (page Ext.) affichait
// rave.dj brut dans un <iframe>. L'utilisateur a annoté 2 captures d'écran
// (zones rayées en rouge) pour demander de masquer les zones purement
// promotionnelles qui ne servent à rien dans ce cas d'usage (comparer un
// mashup "maison" à celui de RaveDJ sur les MÊMES 2 morceaux) : les carrousels
// "TRENDING MASHUPS", "TRENDING MIXES", "TRENDING DJs", "GAGNANTS DES DEFIS",
// et les 2 grandes cartes de mode ("Mashup deux chansons ensemble" /
// "Mixe plusieures chansons en un set de DJ"). "TOUT DERNIERS MASHUPS" et la
// recherche elle-même ne sont PAS concernés — laissés intacts.
//
// Contrainte technique vérifiée en conditions réelles avant d'écrire ce
// fichier (cf. Ext.jsx pour l'historique complet) : un <iframe> cross-origin
// est opaque en JS — impossible de lire/modifier son DOM depuis le parent.
// Un simple overlay positionné en pixels par-dessus l'iframe ne peut donc PAS
// fonctionner correctement (il se désaligne dès que l'utilisateur scrolle
// DANS l'iframe, puisque cette position de scroll interne est elle-même
// invisible depuis notre page — toujours la même barrière cross-origin).
//
// Seule option qui fonctionne réellement : SERVIR nous-mêmes une copie de la
// page rave.dj (récupérée ici, côté serveur, par un simple fetch — pas de
// contournement d'authentification ni de CAPTCHA, c'est la page publique
// telle quelle) en y injectant un petit script qui masque les sections
// visées PAR LEUR TEXTE (retrouvé en inspectant le DOM réel de rave.dj :
// classes `.features-category` / `.features-category-title` pour les
// carrousels, `.hint-container` pour les 2 cartes de mode). Comme rave.dj est
// une application React à routage interne (navigation "CRÉER" → /mix sans
// rechargement complet), le script utilise un MutationObserver permanent
// plutôt qu'un masquage ponctuel au chargement, pour continuer à fonctionner
// après une navigation interne à l'iframe.
//
// Limites honnêtes : ce proxy dépend des noms de classes ACTUELS de rave.dj.
// Si RaveDJ change son balisage, le masquage cessera silencieusement de
// fonctionner (la page restera utilisable, juste plus filtrée) — pas de
// vérification automatique de cette dérive possible sans re-tester à la main.
// Aucune requête (recherche, résultats, connexion) n'est interceptée ou
// modifiée : seul le document HTML initial passe par nous, tout le reste
// (API, assets, vidéos) continue de parler directement à rave.dj/YouTube
// depuis le navigateur de l'utilisateur, exactement comme un accès direct.

const RAVE_ORIGIN = "https://rave.dj";

// Titres de carrousels à masquer (minuscule, sans accents pour comparaison
// tolérante) — vus en conditions réelles sur la page rave.dj/ en français.
// "tout derniers mashups", "mes mashups", "mes mixes" restent volontairement
// EN DEHORS de cette liste (l'utilisateur ne les a pas rayés).
const HIDDEN_CATEGORY_TITLES = [
  "trending mashups",
  "trending mixes",
  "trending djs",
  "gagnants des defis",
  "gagnants des défis",
];

// Script injecté dans la page proxyée — masque les zones non désirées, en
// continu (MutationObserver), sans jamais toucher au reste du DOM/JS de la
// page (recherche, lecteur, connexion RaveDJ...).
const HIDER_SCRIPT = `
<script>
(function () {
  var HIDDEN_TITLES = ${JSON.stringify(HIDDEN_CATEGORY_TITLES)};
  function norm(s) {
    return (s || "").trim().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
  }
  function sweep() {
    try {
      // Les 2 cartes de mode ("Mashup deux chansons" / "Mixe plusieurs chansons").
      document.querySelectorAll(".hint-container").forEach(function (el) {
        el.style.setProperty("display", "none", "important");
      });
      // Carrousels promo par titre (structure vérifiée : .features-category
      // contient un .features-category-title portant le libellé).
      document.querySelectorAll(".features-category-title").forEach(function (t) {
        if (HIDDEN_TITLES.indexOf(norm(t.textContent)) === -1) return;
        var cat = t.closest(".features-category");
        if (cat) cat.style.setProperty("display", "none", "important");
      });
    } catch (e) { /* silencieux — ne jamais casser la page RaveDJ elle-même */ }
  }
  sweep();
  var mo = new MutationObserver(function () { sweep(); });
  function start() {
    if (!document.body) { setTimeout(start, 50); return; }
    mo.observe(document.body, { childList: true, subtree: true });
    sweep();
  }
  start();
})();
</script>
`;

router.get("/ravedj", async (req, res) => {
  try {
    const upstream = await fetch(`${RAVE_ORIGIN}/`, {
      headers: {
        "user-agent":
          req.get("user-agent") ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!upstream.ok) {
      res.status(502).type("html").send(
        `<html><body style="background:#111;color:#f66;font-family:sans-serif;padding:20px">
           Impossible de charger rave.dj (HTTP ${upstream.status}). Réessaie via "↗ Nouvel onglet".
         </body></html>`
      );
      return;
    }
    let html = await upstream.text();

    // <base> pour que toutes les URLs relatives (JS/CSS/images du bundle
    // RaveDJ) continuent de pointer vers rave.dj et non vers notre backend.
    if (!/<base\s/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => `${m}\n<base href="${RAVE_ORIGIN}/">`);
    }
    // Retire toute CSP posée via <meta> dans le HTML lui-même — sinon elle
    // bloquerait notre <script> injecté (pas de nonce/hash correspondant).
    html = html.replace(
      /<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi,
      ""
    );
    // Injecte le script de masquage juste avant la fermeture de </body>.
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${HIDER_SCRIPT}</body>`);
    } else {
      html += HIDER_SCRIPT;
    }

    // Ne PAS transmettre d'éventuels en-têtes CSP/X-Frame-Options de RaveDJ —
    // c'est nous qui servons cette copie, à notre propre en-tête (permissif,
    // usage interne local uniquement).
    res.set("content-type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (e) {
    res.status(502).type("html").send(
      `<html><body style="background:#111;color:#f66;font-family:sans-serif;padding:20px">
         Erreur de connexion à rave.dj : ${String(e.message || e).replace(/[<>]/g, "")}
       </body></html>`
    );
  }
});

export default router;
