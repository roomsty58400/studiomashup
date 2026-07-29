// ── Automatisation RaveDJ en navigateur masqué (juillet 2026, demande explicite) ──
// "automatiser en fenêtre masquée ... pour pas qu'on voit ces manips" —
// reproduit la séquence manuelle déjà validée en conditions réelles plus tôt
// dans cette session (coller lien A, entrée, attendre, coller lien B, entrée,
// attendre, cliquer "CRÉER UN MASHUP") mais via un Chromium headless lancé
// par le BACKEND, jamais affiché à l'écran — pas un onglet minimisé/en
// arrière-plan, un vrai process serveur sans fenêtre du tout, comme ffmpeg ou
// Demucs. Aucune manipulation visible côté utilisateur.
//
// Pourquoi un navigateur du tout : l'app web (React, servie depuis
// localhost:5173) ne peut PAS piloter la page rave.dj affichée dans son
// <iframe> (barrière cross-origin, vérifiée à plusieurs reprises cette
// session — cf. Ext.jsx). Un navigateur piloté séparément (ici, headless côté
// serveur) n'a pas cette restriction : il EST la page, pas un parent qui
// tente d'y accéder depuis l'extérieur.
//
// Limites honnêtes :
//  - RaveDJ est un site tiers non versionné : les sélecteurs ci-dessous
//    (recherche = premier <input> de la page, bouton = texte "CREER UN
//    MASHUP") sont ceux observés en conditions réelles cette session, mais
//    RaveDJ peut changer son balisage sans préavis — si ça arrive, ce module
//    échoue proprement (le job se termine en erreur claire), il ne plante
//    jamais le reste du backend.
//  - Cette automatisation n'a PAS pu être testée de bout en bout par Claude
//    avant livraison (Puppeteer doit être installé via `npm install` — geste
//    que l'utilisateur doit faire lui-même une fois, aucun accès distant
//    possible à sa machine pour l'exécuter à sa place) : à valider en
//    conditions réelles au premier essai.
//  - Génération still côté RaveDJ (pas de notre ressort) : peut prendre
//    plusieurs minutes selon la complexité des morceaux — le polling ici va
//    jusqu'à 15 min avant d'abandonner (repli honnête plutôt qu'une attente
//    infinie silencieuse).

const SEARCH_SELECTOR = "input";
const NAV_TIMEOUT_MS = 60000;
const THUMBNAIL_WAIT_MS = 3000; // même délai que l'automatisation manuelle validée
const GENERATION_POLL_INTERVAL_MS = 5000;
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Détection "ce mix n'est pas réalisable" (demande explicite) ───────────
// RaveDJ refuse parfois de générer un mashup (ex. contenu protégé/bloqué,
// morceau non exploitable, etc.) et l'indique par un message sur sa page —
// sans ce contrôle, l'automatisation attendait bêtement jusqu'au timeout de
// 15 min avant d'abandonner, alors que RaveDJ avait déjà annoncé l'échec
// dès le début. Limite honnête : le TEXTE EXACT que RaveDJ affiche dans ce
// cas n'a pas été observé en conditions réelles cette session (jamais
// rencontré) — ces expressions sont une liste raisonnable de messages
// probables (variantes FR/EN), pas une liste confirmée. Si RaveDJ utilise
// une formulation différente, ce contrôle ne la détectera pas (le job ira
// alors jusqu'au timeout normal, sans régression par rapport à avant).
const FAILURE_TEXT_PATTERNS = [
  /impossible de cr[ée]er (ce |le )?mashup/i,
  /ce mashup n'est pas possible/i,
  /quelque chose s'est mal pass[ée]/i,
  /something went wrong/i,
  /g[ée]n[ée]ration (a )?[ée]chou[ée]/i,
  /generation (has )?failed/i,
  /failed to (create|generate)/i,
  /this (video|content|song) (is|are) (not available|unavailable|blocked)/i,
  /(vid[ée]o|contenu|morceau) (n'est pas disponible|indisponible|bloqu[ée])/i,
  /copyright (claim|strike|block)/i,
];

// Renvoie un court extrait du texte autour du 1er match, pour que l'erreur
// remontée au frontend montre le VRAI message RaveDJ (utile pour juger si
// la détection était pertinente ou un faux positif à affiner plus tard).
const snippetAround = (text, regex) => {
  const m = text.match(regex);
  if (!m || m.index == null) return m ? m[0] : "";
  const start = Math.max(0, m.index - 40);
  return text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, " ").trim();
};

// Best-effort : lit le texte visible de la page et cherche un des messages
// d'échec ci-dessus. Ne lève jamais d'exception elle-même (erreur réseau/page
// fermée ignorée) — un simple `null` en cas de doute, jamais de faux blocage.
const detectFailureMessage = async (page) => {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const pattern = FAILURE_TEXT_PATTERNS.find((p) => p.test(bodyText));
    return pattern ? snippetAround(bodyText, pattern) : null;
  } catch {
    return null;
  }
};

// ── Navigateur système au lieu du Chromium embarqué (correctif, juillet 2026) ──
// Le téléchargement/extraction du Chromium dédié à Puppeteer a échoué 2 fois
// de suite en conditions réelles sur cette machine (exécutable manquant puis
// zip jamais extrait — probablement un antivirus qui interfère avec
// l'extraction d'un .exe déposé par un process inhabituel). Plutôt que de
// s'acharner sur ce téléchargement, on réutilise Microsoft Edge — installé
// par défaut sur Windows, basé sur Chromium, et piloté par Puppeteer EXACTEMENT
// comme Chrome (même protocole CDP, aucune limite fonctionnelle pour ce qu'on
// fait ici) via l'option `executablePath`. Chrome est aussi tenté en 2e choix
// s'il est déjà installé (pas besoin d'un téléchargement dédié dans ce cas
// non plus). Le Chromium embarqué de Puppeteer reste un DERNIER repli, pour
// ne rien casser si aucun des deux n'est trouvé aux emplacements standards.
const SYSTEM_BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const findSystemBrowser = async () => {
  const { existsSync } = await import("fs");
  return SYSTEM_BROWSER_CANDIDATES.find((p) => existsSync(p)) || null;
};

// Exposé pour routes/diag.js (lecture seule) — permet de confirmer quel
// navigateur système sera utilisé sans avoir à lancer tout le job.
export const _findSystemBrowserDiag = findSystemBrowser;

// Retourne le nombre de vignettes de morceaux actuellement affichées sur la
// page — sert à VÉRIFIER qu'un ajout a réellement pris effet plutôt que de
// se fier à une attente à durée fixe. Sélecteur volontairement large (toute
// <img> dont le src pointe vers une miniature YouTube) car on ne connaît pas
// le nom de classe exact utilisé par RaveDJ.
const countTrackThumbnails = (page) =>
  page.evaluate(() =>
    document.querySelectorAll('img[src*="ytimg"], img[src*="ggpht"]').length
  );

const pasteAndSubmit = async (page, url, expectedCount) => {
  await page.waitForSelector(SEARCH_SELECTOR, { timeout: 30000 });
  await page.click(SEARCH_SELECTOR, { clickCount: 3 }); // sélectionne tout contenu existant
  await page.keyboard.press("Backspace");
  await page.type(SEARCH_SELECTOR, url, { delay: 25 });
  // Petite pause AVANT Enter : RaveDJ semble faire une recherche/résolution
  // à chaque frappe (comme notre propre debounce dans Ext.jsx) — appuyer sur
  // Entrée immédiatement après un typing rapide peut arriver avant que la
  // valeur ne soit pleinement prise en compte par son propre code React.
  await wait(400);
  await page.keyboard.press("Enter");
  // Vérifie que l'ajout a réellement fonctionné en attendant qu'une nouvelle
  // vignette apparaisse (au lieu de juste espérer que 3s suffisent) — si ça
  // ne se produit pas sous 10s, on continue quand même (non-bloquant) mais
  // l'appelant pourra le voir dans les logs.
  const deadline = Date.now() + 10000;
  let ok = false;
  while (Date.now() < deadline) {
    const count = await countTrackThumbnails(page);
    if (count > expectedCount) { ok = true; break; }
    await wait(300);
  }
  return ok;
};

// Cherche le bouton "CRÉER UN MASHUP" avec plusieurs essais (au lieu d'un
// seul coup) — le bouton peut n'apparaître/devenir cliquable qu'un court
// instant après que la 2e vignette se soit affichée (rendu React différé).
const clickCreateMashup = async (page, { retries = 10, delayMs = 500 } = {}) => {
  for (let i = 0; i < retries; i++) {
    const found = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button"))
        .find((b) => /cr[ée]er un mashup/i.test((b.textContent || "").trim()));
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    });
    if (found) return true;
    await wait(delayMs);
  }
  return false;
};

// ── Bannière de consentement cookies (RGPD) ─────────────────────────────
// Root cause du 1er échec en conditions réelles (juillet 2026) : un
// navigateur headless FRAÎCHEMENT lancé n'a aucun cookie enregistré, donc
// RaveDJ affiche systématiquement sa bannière de consentement par-dessus la
// page — elle intercepte les clics/frappes destinés au champ de recherche
// (0 vignette ajoutée malgré "succès" apparent). Le test MANUEL antérieur
// avait réussi car il utilisait un profil Chrome déjà "consenti". On clique
// donc "Accept all" (ou équivalent) avant toute autre interaction.
const dismissCookieConsent = async (page) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, a"))
        .filter((b) => {
          const t = (b.textContent || "").trim().toLowerCase();
          return t === "accept all" || t === "accepter tout" || t === "tout accepter" || t === "j'accepte";
        });
      if (!candidates.length) return false;
      candidates[0].click();
      return true;
    });
    if (clicked) {
      await wait(500); // laisse la bannière disparaître avant de continuer
      return true;
    }
    await wait(300);
  }
  return false; // pas grave si absente (session/profil déjà consenti)
};

// Diagnostic best-effort appelé UNIQUEMENT en cas d'échec — capture l'état
// réel de la page (nb de vignettes, texte de tous les boutons visibles) pour
// pouvoir comprendre la cause depuis les logs serveur plutôt que deviner.
const captureFailureDiagnostics = async (page) => {
  try {
    return await page.evaluate(() => ({
      thumbCount: document.querySelectorAll('img[src*="ytimg"], img[src*="ggpht"]').length,
      buttons: Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean),
      url: location.href,
    }));
  } catch (e) {
    return { error: `diagnostic impossible : ${e.message}` };
  }
};

// Lance la séquence complète pour 2 URLs YouTube. `onProgress(patch)` est
// appelé à chaque étape pour la barre de progression côté frontend (même
// convention que updateJobStep dans routes/mashup.js — {step, label}).
export async function runRavedjAutomation({ urlA, urlB, onProgress = () => {} }) {
  let browser;
  // Import dynamique plutôt qu'un "import puppeteer from ..." en tête de
  // fichier : ce module est chargé par server.js AU DÉMARRAGE (via
  // routes/ravedjAuto.js) — un import statique d'un paquet pas encore
  // installé (npm install requis, geste que l'utilisateur doit faire
  // lui-même) ferait planter TOUT le backend au lancement, bien avant que ce
  // bouton ne soit jamais cliqué. Ici, l'échec reste local à CET appel.
  let puppeteer;
  try {
    ({ default: puppeteer } = await import("puppeteer"));
  } catch (e) {
    throw new Error(
      `Puppeteer n'est pas installé côté backend — lance "npm install" dans le dossier backend puis réessaie. (${e.message})`
    );
  }
  try {
    const systemBrowser = await findSystemBrowser();
    onProgress({
      step: 1,
      label: systemBrowser
        ? `Lancement du navigateur masqué (${systemBrowser.includes("Edge") ? "Edge" : "Chrome"} système)...`
        : "Lancement du navigateur masqué (Chromium Puppeteer)...",
    });
    browser = await puppeteer.launch({
      headless: "new", // AUCUNE fenêtre — c'est tout le sens de la demande
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      ...(systemBrowser ? { executablePath: systemBrowser } : {}),
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // ── Anti-détection "navigateur automatisé" ──────────────────────────
    // Le test MANUEL (vrai onglet Chrome piloté à la main) a réussi du
    // premier coup ; le même scénario en Puppeteer headless échoue à l'étape
    // du bouton. Différence probable : Puppeteer headless expose
    // `navigator.webdriver = true` et un user-agent contenant "HeadlessChrome"
    // — des signaux qu'un site peut utiliser pour servir une page dégradée ou
    // bloquer une interaction (comportement anti-bot fréquent, indépendant de
    // notre code). On neutralise les deux signaux les plus courants.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0"
    );

    onProgress({ step: 2, label: "Ouverture de RaveDJ..." });
    await page.goto("https://rave.dj/mix", { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    await dismissCookieConsent(page);

    onProgress({ step: 3, label: "Ajout du morceau A..." });
    const okA = await pasteAndSubmit(page, urlA, 0);
    await wait(THUMBNAIL_WAIT_MS); // laisse la vignette YouTube s'afficher

    onProgress({ step: 4, label: "Ajout du morceau B..." });
    const countAfterA = await countTrackThumbnails(page);
    const okB = await pasteAndSubmit(page, urlB, countAfterA);
    await wait(THUMBNAIL_WAIT_MS);

    onProgress({ step: 5, label: "Validation (CRÉER UN MASHUP)..." });
    const clicked = await clickCreateMashup(page);
    if (!clicked) {
      const diag = await captureFailureDiagnostics(page);
      console.warn("[ravedjAutomation] Bouton introuvable — diagnostic:", {
        okA, okB, ...diag,
      });
      let shotPath = null;
      try {
        const { join } = await import("path");
        const { fileURLToPath } = await import("url");
        const { dirname } = await import("path");
        const __dirname = dirname(fileURLToPath(import.meta.url));
        shotPath = join(__dirname, "..", "data", "outputs", `ravedj-auto-fail-${Date.now()}.png`);
        await page.screenshot({ path: shotPath, fullPage: true });
      } catch (e) {
        shotPath = `(capture d'écran impossible : ${e.message})`;
      }
      throw new Error(
        `Bouton "CRÉER UN MASHUP" introuvable — vignettes détectées : ${diag.thumbCount ?? "?"} (ajout A ${okA ? "OK" : "ÉCHEC"}, ajout B ${okB ? "OK" : "ÉCHEC"}). Boutons visibles : [${(diag.buttons || []).join(" | ")}]. Capture : ${shotPath}`
      );
    }
    // Le clic déclenche une navigation vers l'URL courte du mashup
    // (rave.dj/<id>) — attente best-effort, non bloquante si ça timeout (on
    // vérifiera quand même la présence d'une vidéo ensuite).
    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
    } catch {
      // Pas grave — certaines versions de RaveDJ changent l'URL sans "vraie"
      // navigation (history.pushState) que waitForNavigation ne détecte pas.
    }

    // Vérifie tout de suite si RaveDJ a refusé le mashup dès la validation
    // (avant même d'entamer le polling de génération) — inutile d'attendre
    // si le message d'échec est déjà là.
    const immediateFailure = await detectFailureMessage(page);
    if (immediateFailure) {
      throw new Error(`RaveDJ indique que ce mix n'est pas réalisable : "${immediateFailure}"`);
    }

    onProgress({ step: 6, label: "Génération en cours sur RaveDJ (peut prendre plusieurs minutes)..." });
    const mashupUrl = page.url();
    let mediaUrl = null;
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // BUG CORRIGÉ (conditions réelles, juillet 2026) : `document.querySelector("video")`
      // renvoyait TOUJOURS le 1er <video> du DOM — une vidéo d'ambiance
      // décorative de fond (CDN "hilljam.com", fichier "Backgroundblur-*.mp4"),
      // présente dès le chargement de la page, AVANT même toute génération.
      // Résultat : le job se terminait en ~20-30s avec ce fichier, jamais le
      // vrai rendu — reproduit et confirmé en conditions réelles. Le rendu
      // RÉEL du mashup a été observé une fois (test manuel validé) sur le CDN
      // propre de RaveDJ (assets*.rave.dj) : on donne donc la priorité à toute
      // vidéo dont l'hôte contient "rave.dj"/"wemesh", et on exclut
      // explicitement le fond décoratif connu, plutôt que de prendre le 1er
      // <video> trouvé au hasard.
      mediaUrl = await page.evaluate(() => {
        const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
        const vids = Array.from(document.querySelectorAll("video"))
          .map((v) => ({ src: v.currentSrc, duration: v.duration }))
          .filter((v) => v.src);
        const isDecorativeBackground = (src) => /hilljam\.com$/i.test(hostOf(src));
        const raveHosted = vids.find((v) => /(^|\.)rave\.dj$|wemesh/i.test(hostOf(v.src)));
        if (raveHosted) return raveHosted.src;
        const nonBackground = vids.find((v) => !isDecorativeBackground(v.src));
        return nonBackground ? nonBackground.src : null;
      });
      if (mediaUrl) break;

      // ── Arrêt anticipé si RaveDJ signale que le mix n'est pas réalisable ──
      // (demande explicite) : sans ça, on attendait bêtement le timeout
      // complet (15 min) même quand RaveDJ avait déjà annoncé l'échec.
      const failureMsg = await detectFailureMessage(page);
      if (failureMsg) {
        throw new Error(`RaveDJ indique que ce mix n'est pas réalisable : "${failureMsg}" — génération arrêtée.`);
      }

      // ── Pourcentage d'avancement (demande explicite) ──────────────────
      // Best-effort : on ne fabrique JAMAIS un faux pourcentage — on essaie
      // de lire un VRAI nombre "NN%" affiché quelque part sur la page RaveDJ
      // pendant la génération. Si rien de tel n'est trouvé (RaveDJ n'affiche
      // peut-être aucune progression chiffrée), `percent` reste `null` et le
      // frontend retombe sur le seul chronomètre (temps écoulé), honnête
      // plutôt qu'une barre de progression inventée.
      const percent = await page.evaluate(() => {
        const text = document.body.innerText || "";
        const m = text.match(/\b(\d{1,3})\s?%/);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        return n >= 0 && n <= 100 ? n : null;
      }).catch(() => null);
      onProgress({
        step: 6,
        label: "Génération en cours sur RaveDJ (peut prendre plusieurs minutes)...",
        percent,
      });
      await wait(GENERATION_POLL_INTERVAL_MS);
    }
    if (!mediaUrl) {
      throw new Error(`Délai dépassé (15 min) sans obtenir le rendu final. Le mashup est peut-être toujours en cours sur RaveDJ : ${mashupUrl}`);
    }

    onProgress({ step: 7, label: "Rendu obtenu." });
    return { mashupUrl, mediaUrl };
  } finally {
    if (browser) await browser.close();
  }
}
