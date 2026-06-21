import React, { useState } from "react";

const YEAR = new Date().getFullYear();

const LOGO_CONCEPTS = [
  {
    name: "MacheUp",
    tag: "Fusionnez la musique.",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <defs>
          <linearGradient id="lc-fw1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#cc00ff" />
            <stop offset="100%" stopColor="#7a00ff" />
          </linearGradient>
          <linearGradient id="lc-fw2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#00eaff" />
            <stop offset="100%" stopColor="#00ffd5" />
          </linearGradient>
        </defs>
        <polygon points="4,4 20,20 4,36" fill="url(#lc-fw1)" opacity="0.92" />
        <polygon points="36,4 20,20 36,36" fill="url(#lc-fw2)" opacity="0.92" />
        <polyline points="2,20 8,12 12,28 16,10 20,20 24,10 28,28 32,12 38,20"
          fill="none" stroke="#fff" strokeWidth="1.3" opacity="0.85" />
      </svg>
    ),
  },
  {
    name: "MacheUp Live",
    tag: "Mix en direct.",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <defs>
          <linearGradient id="lc-mb1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#00eaff" />
            <stop offset="100%" stopColor="#cc00ff" />
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="17" fill="none" stroke="url(#lc-mb1)" strokeWidth="3" />
        <path d="M10 14 H24 L20 10 M24 14 L20 18" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M30 26 H16 L20 30 M16 26 L20 22" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    name: "MacheUp Studio",
    tag: "Deux titres, une nouvelle œuvre.",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <circle cx="20" cy="20" r="18" fill="#0a0a0a" stroke="#00eaff" strokeWidth="1.2" opacity="0.95" />
        <circle cx="20" cy="20" r="13" fill="none" stroke="#222" strokeWidth="0.8" />
        <circle cx="20" cy="20" r="9" fill="none" stroke="#222" strokeWidth="0.8" />
        <circle cx="20" cy="20" r="5" fill="#00eaff" opacity="0.9" />
        <circle cx="20" cy="20" r="1.6" fill="#0a0a0a" />
      </svg>
    ),
  },
  {
    name: "MacheUp VideoMix",
    tag: "Le laboratoire du mashup.",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <defs>
          <linearGradient id="lc-tm1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#aaffee" />
            <stop offset="100%" stopColor="#00eaff" />
          </linearGradient>
        </defs>
        <path d="M6 32 V8 L20 22 L34 8 V32" fill="none" stroke="url(#lc-tm1)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    name: "MacheUp Creator",
    tag: "Créez l'impossible.",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <defs>
          <linearGradient id="lc-inf1" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ff5fa0" />
            <stop offset="100%" stopColor="#ffb84d" />
          </linearGradient>
        </defs>
        <path d="M12 20c0-4 4-7 8-3 4-4 8-1 8 3s-4 7-8 3c-4 4-8 1-8-3z" fill="none" stroke="url(#lc-inf1)" strokeWidth="2.4" />
        <circle cx="10" cy="27" r="2" fill="#ffb84d" />
        <circle cx="30" cy="13" r="2" fill="#ff5fa0" />
      </svg>
    ),
  },
  // ── Technologies utilisées (crédits "powered by") ──
  {
    name: "NVIDIA CUDA",
    tag: "Accélération GPU (Demucs, export vidéo).",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <rect x="9" y="9" width="22" height="22" rx="3" fill="#0a0a0a" stroke="#76b900" strokeWidth="1.4" />
        {[0, 1, 2].flatMap(r => [0, 1, 2].map(c => (
          <rect key={`${r}-${c}`} x={13 + c * 6} y={13 + r * 6} width="4" height="4"
            fill="#76b900" opacity={0.5 + (r + c) * 0.08} />
        )))}
        <line x1="14" y1="4" x2="14" y2="9" stroke="#76b900" strokeWidth="1.4" />
        <line x1="20" y1="4" x2="20" y2="9" stroke="#76b900" strokeWidth="1.4" />
        <line x1="26" y1="4" x2="26" y2="9" stroke="#76b900" strokeWidth="1.4" />
        <line x1="14" y1="31" x2="14" y2="36" stroke="#76b900" strokeWidth="1.4" />
        <line x1="20" y1="31" x2="20" y2="36" stroke="#76b900" strokeWidth="1.4" />
        <line x1="26" y1="31" x2="26" y2="36" stroke="#76b900" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    name: "FFmpeg",
    tag: "Moteur d'encodage audio/vidéo.",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <rect x="3" y="3" width="34" height="34" rx="8" fill="#0a0a0a" stroke="#2a2a2a" strokeWidth="1" />
        <polygon points="11,11 11,29 22,20" fill="#00eaff" opacity="0.9" />
        <polygon points="20,11 20,29 31,20" fill="#00eaff" opacity="0.45" />
      </svg>
    ),
  },
  {
    name: "YouTube",
    tag: "Source des clips et de la recherche.",
    svg: (
      <svg viewBox="0 0 40 40" width="30" height="30">
        <rect x="3" y="9" width="34" height="22" rx="7" fill="#ff0000" />
        <polygon points="17,15 17,25 27,20" fill="#fff" />
      </svg>
    ),
  },
];

function LogoMarquee() {
  const items = [...LOGO_CONCEPTS, ...LOGO_CONCEPTS];
  return (
    <div className="logo-marquee-wrap">
      <div className="logo-marquee-track">
        {items.map((c, i) => (
          <div className="logo-marquee-item" key={i}>
            {c.svg}
            <div>
              <span className="logo-marquee-name">{c.name}</span>
              <span className="logo-marquee-tag">{c.tag}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SECTIONS = {
  mentions: {
    title: "Mentions légales",
    icon: "⚖",
    content: () => (
      <>
        <h3>Éditeur du site</h3>
        <p>MacheUp Studio est un outil de création musicale à usage personnel.<br/>
        Éditeur : Sylvain — syltiti@gmail.com</p>

        <h3>Hébergement</h3>
        <p>Le site est hébergé localement sur l'infrastructure de l'utilisateur.<br/>
        En cas de déploiement public, l'hébergeur devra être mentionné conformément à l'article 6 de la loi LCEN du 21 juin 2004.</p>

        <h3>Directeur de publication</h3>
        <p>Sylvain — syltiti@gmail.com</p>

        <h3>Propriété intellectuelle</h3>
        <p>Le code source, l'interface et les éléments graphiques de MacheUp Studio sont la propriété de leur auteur. Toute reproduction, même partielle, est interdite sans autorisation préalable.</p>

        <h3>Contenus tiers</h3>
        <p>Les vidéos intégrées proviennent de YouTube (Google LLC). MacheUp Studio n'héberge aucun contenu tiers protégé. L'utilisation des APIs YouTube est soumise aux <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">Conditions d'utilisation de YouTube</a> et aux <a href="https://developers.google.com/youtube/terms/api-services-terms-of-service" target="_blank" rel="noopener noreferrer">Conditions des services API YouTube</a>.</p>

        <h3>Reconnaissance audio (ID piste)</h3>
        <p>La fonction d'identification audio utilise l'API <a href="https://audd.io" target="_blank" rel="noopener noreferrer">AudD Music Recognition API</a>. Un court extrait audio (800 Ko max) est transmis à leurs serveurs pour identification. AudD est soumis à ses propres <a href="https://audd.io/terms/" target="_blank" rel="noopener noreferrer">conditions d'utilisation</a> et <a href="https://audd.io/privacy/" target="_blank" rel="noopener noreferrer">politique de confidentialité</a>. MacheUp Studio ne conserve aucun extrait envoyé à AudD.</p>

        <h3>Liens vers services de streaming</h3>
        <p>Après identification d'une piste, des liens vers <a href="https://www.spotify.com" target="_blank" rel="noopener noreferrer">Spotify</a>, <a href="https://www.deezer.com" target="_blank" rel="noopener noreferrer">Deezer</a> et <a href="https://www.youtube.com" target="_blank" rel="noopener noreferrer">YouTube</a> sont proposés à titre indicatif. Ces plateformes sont indépendantes de MacheUp Studio et régies par leurs propres conditions. Le simple affichage de ces liens ne constitue pas un partenariat commercial.</p>

        <h3>Limitation de responsabilité</h3>
        <p>MacheUp Studio est fourni « en l'état ». L'éditeur ne saurait être tenu responsable des dommages directs ou indirects liés à l'utilisation de l'outil, notamment en cas d'utilisation non conforme à sa destination personnelle et non commerciale.</p>
      </>
    ),
  },
  rgpd: {
    title: "Politique de confidentialité & RGPD",
    icon: "🛡",
    content: () => (
      <>
        <h3>Responsable du traitement</h3>
        <p>Sylvain — syltiti@gmail.com</p>

        <h3>Données collectées</h3>
        <p>MacheUp Studio ne collecte aucune donnée personnelle à des fins commerciales. Les données traitées localement sont :</p>
        <ul>
          <li>Les recherches YouTube effectuées via l'API Google (requêtes transmises à l'API, non stockées)</li>
          <li>Les fichiers audio chargés localement (traitement en mémoire, aucun transfert vers des serveurs tiers)</li>
          <li>Les fichiers générés (macheups, pochettes) stockés temporairement sur votre machine</li>
        </ul>

        <h3>Cookies et stockage local</h3>
        <p>Le site peut utiliser le stockage local du navigateur (localStorage) pour conserver vos préférences de session. Aucun cookie de traçage ou publicitaire n'est déposé.</p>

        <h3>API tierces et données transmises</h3>
        <p>L'application interagit avec les services suivants, soumis à leurs propres politiques de confidentialité :</p>
        <ul>
          <li><strong>Google YouTube API</strong> — Vos recherches de titres sont transmises à l'API Google. <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Politique de confidentialité Google</a></li>
          <li><strong>Google Gemini API</strong> — Titres d'artistes et noms de macheups sont envoyés pour générer des pochettes.</li>
          <li><strong>Pollinations.ai</strong> — Fallback de génération d'images. <a href="https://pollinations.ai/privacy" target="_blank" rel="noopener noreferrer">Politique Pollinations.ai</a></li>
          <li><strong>AudD Music Recognition API</strong> — Un extrait audio (≤ 800 Ko) est envoyé pour identifier une piste (fonction « ⬡ ID »). AudD peut retourner des métadonnées Spotify et Apple Music. <a href="https://audd.io/privacy/" target="_blank" rel="noopener noreferrer">Politique AudD</a></li>
          <li><strong>Spotify, Deezer, YouTube</strong> — Des liens de recherche sont générés côté client après identification d'une piste. Aucune donnée n'est transmise à ces plateformes sans action volontaire de l'utilisateur (clic sur le lien). Chaque plateforme est soumise à ses propres conditions : <a href="https://www.spotify.com/legal/privacy-policy/" target="_blank" rel="noopener noreferrer">Spotify</a>, <a href="https://www.deezer.com/legal/personal-datas" target="_blank" rel="noopener noreferrer">Deezer</a>, <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">YouTube/Google</a>.</li>
        </ul>

        <h3>Données audio transmises à AudD</h3>
        <p>Lors de l'utilisation du bouton « ⬡ ID » (reconnaissance audio) : les 800 premiers Ko du fichier audio chargé sont envoyés au service AudD. Cette transmission est temporaire, effectuée uniquement sur action explicite de l'utilisateur, et les extraits sont supprimés côté serveur immédiatement après traitement. Aucune donnée identificatrice n'est jointe à cette requête.</p>

        <h3>Durée de conservation</h3>
        <p>Les fichiers générés sont conservés uniquement le temps de la session et supprimés au redémarrage du serveur local. Aucune donnée n'est transmise à des tiers à des fins marketing.</p>

        <h3>Vos droits (RGPD, Règlement UE 2016/679)</h3>
        <p>Conformément au RGPD, vous disposez des droits suivants :</p>
        <ul>
          <li>Droit d'accès (art. 15)</li>
          <li>Droit de rectification (art. 16)</li>
          <li>Droit à l'effacement (art. 17)</li>
          <li>Droit à la portabilité (art. 20)</li>
          <li>Droit d'opposition (art. 21)</li>
        </ul>
        <p>Pour exercer ces droits : <a href="mailto:syltiti@gmail.com">syltiti@gmail.com</a><br/>
        Vous pouvez également introduire une réclamation auprès de la <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer">CNIL</a>.</p>
      </>
    ),
  },
  cgu: {
    title: "Conditions générales d'utilisation",
    icon: "📋",
    content: () => (
      <>
        <h3>Objet</h3>
        <p>MacheUp Studio est un outil de création musicale à usage <strong>strictement personnel et non commercial</strong>. Il permet de créer des macheups à partir de contenus YouTube pour un usage privé.</p>

        <h3>Droits d'auteur et propriété intellectuelle</h3>
        <p>Les contenus audio et vidéo utilisés via YouTube restent la propriété exclusive de leurs ayants droit respectifs. La création de macheups à partir de ces contenus est soumise au droit d'auteur.</p>
        <p>En France, la loi du 3 juillet 1985 et le Code de la Propriété Intellectuelle (CPI) encadrent la création d'œuvres dérivées. L'exception pour usage privé (art. L.122-5 CPI) ne couvre pas la diffusion ou distribution publique.</p>

        <h3>Usage autorisé</h3>
        <ul>
          <li>Usage personnel et privé uniquement</li>
          <li>Les macheups créés ne doivent pas être distribués publiquement sans l'accord des ayants droit</li>
          <li>Toute exploitation commerciale est interdite</li>
        </ul>

        <h3>Usage interdit</h3>
        <ul>
          <li>Distribution publique ou commerciale des macheups sans autorisation</li>
          <li>Contournement des mesures de protection technique (DRM)</li>
          <li>Utilisation de contenus sans droits acquis</li>
          <li>Revente ou exploitation commerciale de l'outil</li>
        </ul>

        <h3>Conditions YouTube</h3>
        <p>L'utilisation de MacheUp Studio implique le respect des <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">Conditions d'utilisation de YouTube</a>. Le téléchargement de vidéos YouTube est soumis à ces conditions ; l'utilisateur en est seul responsable.</p>

        <h3>Reconnaissance audio — fonction « ⬡ ID »</h3>
        <p>La fonction d'identification audio est fournie par <a href="https://audd.io" target="_blank" rel="noopener noreferrer">AudD</a>. Elle fonctionne uniquement sur des fichiers audio chargés localement. Un court extrait est transmis à AudD pour identification. L'utilisateur reconnaît que cette fonction est soumise aux <a href="https://audd.io/terms/" target="_blank" rel="noopener noreferrer">CGU d'AudD</a>. MacheUp Studio ne garantit pas l'exactitude des résultats retournés.</p>

        <h3>Liens vers Spotify, Deezer et YouTube</h3>
        <p>Après identification d'un titre, des liens vers Spotify, Deezer et YouTube sont proposés pour faciliter l'écoute. Ces liens redirigent vers des plateformes tiers soumises à leurs propres conditions d'utilisation. L'utilisateur s'engage à respecter les conditions de ces plateformes lors de leur utilisation. Ces liens constituent de simples redirections et ne constituent pas un partenariat commercial entre MacheUp Studio et ces services.</p>
        <ul>
          <li><a href="https://www.spotify.com/legal/end-user-agreement/" target="_blank" rel="noopener noreferrer">CGU Spotify</a></li>
          <li><a href="https://www.deezer.com/legal/cgus" target="_blank" rel="noopener noreferrer">CGU Deezer</a></li>
          <li><a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">CGU YouTube</a></li>
        </ul>

        <h3>Responsabilité de l'utilisateur</h3>
        <p>L'utilisateur est seul responsable de l'usage qu'il fait de MacheUp Studio et des contenus qu'il traite. L'éditeur de l'outil décline toute responsabilité en cas d'usage contraire aux présentes CGU ou à la législation applicable.</p>

        <h3>Modification des CGU</h3>
        <p>L'éditeur se réserve le droit de modifier les présentes CGU à tout moment. Les modifications prennent effet dès leur publication.</p>
      </>
    ),
  },
  cookies: {
    title: "Politique cookies",
    icon: "🍪",
    content: () => (
      <>
        <h3>Qu'est-ce qu'un cookie ?</h3>
        <p>Un cookie est un petit fichier texte déposé sur votre terminal lors de la visite d'un site web, conformément à l'article 5.3 de la Directive européenne 2002/58/CE et à la recommandation CNIL du 17 septembre 2020.</p>

        <h3>Cookies utilisés par MacheUp Studio</h3>
        <table>
          <thead>
            <tr><th>Nom</th><th>Type</th><th>Finalité</th><th>Durée</th></tr>
          </thead>
          <tbody>
            <tr><td>localStorage (session)</td><td>Fonctionnel</td><td>Préférences de l'interface, état de la session</td><td>Session</td></tr>
            <tr><td>YouTube (iframe)</td><td>Tiers — Google</td><td>Lecture des vidéos YouTube intégrées dans les decks</td><td>Selon politique Google</td></tr>
            <tr><td>AudD (requête API)</td><td>Tiers — AudD</td><td>Transmission d'un extrait audio pour identification (bouton ⬡ ID) — pas de cookie déposé, requête HTTP uniquement</td><td>Non applicable</td></tr>
            <tr><td>Spotify (lien externe)</td><td>Tiers — Spotify</td><td>Déposé uniquement si l'utilisateur clique sur le lien Spotify après identification d'un titre</td><td>Selon politique Spotify</td></tr>
            <tr><td>Deezer (lien externe)</td><td>Tiers — Deezer</td><td>Déposé uniquement si l'utilisateur clique sur le lien Deezer après identification d'un titre</td><td>Selon politique Deezer</td></tr>
            <tr><td>YouTube Search (lien externe)</td><td>Tiers — Google</td><td>Déposé uniquement si l'utilisateur clique sur le lien YouTube après identification d'un titre</td><td>Selon politique Google</td></tr>
          </tbody>
        </table>

        <h3>Cookies YouTube / Google</h3>
        <p>L'intégration du lecteur YouTube dépose des cookies Google lors de la lecture de vidéos. Ces cookies sont soumis à la <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">politique de confidentialité Google</a>. Vous pouvez les gérer via les paramètres de votre navigateur.</p>

        <h3>Cookies Spotify, Deezer, YouTube Search</h3>
        <p>Les liens vers Spotify, Deezer et YouTube (recherche) n'envoient aucune donnée tant que l'utilisateur ne clique pas dessus. En cliquant, vous êtes redirigé vers ces plateformes qui peuvent déposer leurs propres cookies selon leurs politiques respectives :</p>
        <ul>
          <li><a href="https://www.spotify.com/legal/cookies-policy/" target="_blank" rel="noopener noreferrer">Politique cookies Spotify</a></li>
          <li><a href="https://www.deezer.com/legal/cookies" target="_blank" rel="noopener noreferrer">Politique cookies Deezer</a></li>
          <li><a href="https://policies.google.com/technologies/cookies" target="_blank" rel="noopener noreferrer">Politique cookies Google/YouTube</a></li>
        </ul>

        <h3>Cookies de traçage et publicitaires</h3>
        <p>MacheUp Studio ne dépose <strong>aucun cookie de traçage, de profilage ou publicitaire</strong>.</p>

        <h3>Gestion des cookies</h3>
        <p>Vous pouvez paramétrer, bloquer ou supprimer les cookies depuis les préférences de votre navigateur :</p>
        <ul>
          <li><a href="https://support.google.com/chrome/answer/95647" target="_blank" rel="noopener noreferrer">Chrome</a></li>
          <li><a href="https://support.mozilla.org/fr/kb/activer-desactiver-cookies" target="_blank" rel="noopener noreferrer">Firefox</a></li>
          <li><a href="https://support.apple.com/fr-fr/guide/safari/sfri11471/mac" target="_blank" rel="noopener noreferrer">Safari</a></li>
          <li><a href="https://support.microsoft.com/fr-fr/microsoft-edge/supprimer-les-cookies-dans-microsoft-edge-63947406-40ac-c3b8-57b9-2a946a29ae09" target="_blank" rel="noopener noreferrer">Edge</a></li>
        </ul>
      </>
    ),
  },
};

function LegalModal({ section, onClose }) {
  const s = SECTIONS[section];
  if (!s) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2000,
      background: "rgba(0,0,0,0.92)", backdropFilter: "blur(12px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#0c0c0c", border: "1px solid #222", borderRadius: 16,
        width: 740, maxWidth: "96vw", maxHeight: "88vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 0 0 1px rgba(0,234,255,0.08), 0 24px 80px rgba(0,0,0,0.9)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "18px 24px", borderBottom: "1px solid #1a1a1a",
          flexShrink: 0,
        }}>
          <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 14, fontWeight: 900,
            letterSpacing: 3, color: "#00eaff" }}>
            {s.icon} {s.title.toUpperCase()}
          </div>
          <button onClick={onClose} style={{
            background: "transparent", border: "1px solid #333", color: "#666",
            borderRadius: 6, width: 30, height: 30, cursor: "pointer", fontSize: 17,
          }}
          onMouseEnter={e => e.currentTarget.style.color = "white"}
          onMouseLeave={e => e.currentTarget.style.color = "#666"}
          >✕</button>
        </div>

        {/* Contenu scrollable */}
        <div style={{
          overflowY: "auto", padding: "24px 28px", flex: 1,
          fontSize: 14, lineHeight: 1.8, color: "#999",
        }}
        /* Styles inline pour le contenu légal */
        className="legal-content">
          {s.content()}
        </div>

        <div style={{
          padding: "12px 24px", borderTop: "1px solid #1a1a1a",
          fontSize: 11, color: "#333", letterSpacing: 1, flexShrink: 0,
        }}>
          Dernière mise à jour : {YEAR} · MacheUp Studio
        </div>
      </div>
      <style>{`
        .legal-content h3 { color: #00eaff; font-size: 13px; font-weight: 800; letter-spacing: 2px;
          text-transform: uppercase; margin: 20px 0 8px; font-family: Orbitron, sans-serif; }
        .legal-content h3:first-child { margin-top: 0; }
        .legal-content p { margin: 0 0 10px; color: #888; }
        .legal-content ul { margin: 0 0 10px; padding-left: 18px; color: #888; }
        .legal-content li { margin-bottom: 4px; }
        .legal-content a { color: #00eaff; text-decoration: none; border-bottom: 1px solid rgba(0,234,255,0.3); }
        .legal-content a:hover { border-bottom-color: #00eaff; }
        .legal-content strong { color: #ccc; }
        .legal-content table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; font-size: 13px; }
        .legal-content th { text-align: left; color: #555; font-weight: 700; letter-spacing: 1px;
          border-bottom: 1px solid #1e1e1e; padding: 6px 10px 8px; font-size: 11px; text-transform: uppercase; }
        .legal-content td { padding: 8px 10px; border-bottom: 1px solid #141414; color: #777; vertical-align: top; }
        .legal-content tr:last-child td { border-bottom: none; }
      `}</style>
    </div>
  );
}

export default function Footer() {
  const [openSection, setOpenSection] = useState(null);

  const toggle = (key) => setOpenSection(prev => prev === key ? null : key);

  return (
    <>
      <footer style={{
        borderTop: "1px solid #141414",
        background: "#080808",
        padding: "20px 24px",
        marginTop: 8,
      }}>
        {/* Logo / Brand */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 15, fontWeight: 900,
            letterSpacing: 3, color: "#cc00ff" }}>MACHEUP<span style={{ color: "#00eaff" }}> STUDIO</span></div>
          <div style={{ fontSize: 11, color: "#333", letterSpacing: 1 }}>© {YEAR}</div>
        </div>

        {/* Bandeau logos défilants */}
        <LogoMarquee />

        {/* Disclaimer droits d'auteur */}
        <div style={{
          fontSize: 11, color: "#2a2a2a", lineHeight: 1.7, letterSpacing: 0.5,
          borderTop: "1px solid #111", paddingTop: 14,
          maxWidth: "100%",
        }}>
          <span style={{ color: "#333" }}>⚠ Avertissement légal · </span>
          MacheUp Studio est un outil de création à usage <strong style={{ color: "#3a3a3a" }}>strictement personnel et non commercial</strong>.
          Les contenus audio et vidéo utilisés via YouTube restent la propriété de leurs ayants droit.
          La création de macheups est soumise au droit d'auteur (Code de la Propriété Intellectuelle, art. L.122-5).
          Toute distribution ou exploitation commerciale sans accord des ayants droit est interdite.
          L'usage de l'API YouTube est soumis aux{" "}
          <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer"
            style={{ color: "#444", textDecoration: "none", borderBottom: "1px solid #2a2a2a" }}>
            Conditions d'utilisation YouTube
          </a>.{" "}
          La reconnaissance audio utilise <a href="https://audd.io/terms/" target="_blank" rel="noopener noreferrer"
            style={{ color: "#444", textDecoration: "none", borderBottom: "1px solid #2a2a2a" }}>AudD API</a> (extrait audio ≤ 800 Ko).
          Les liens Spotify, Deezer et YouTube sont fournis à titre indicatif et ne constituent pas un partenariat commercial.
        </div>

        {/* Badges conformité + Liens légaux sur la même ligne */}
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14,
          alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {[
              { label: "RGPD Conforme", color: "#00eaff" },
              { label: "Pas de publicité", color: "#cc00ff" },
              { label: "Données locales uniquement", color: "#00eaff" },
              { label: "Usage personnel", color: "#cc00ff" },
            ].map((b, i) => (
              <div key={i} style={{
                padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                letterSpacing: 1.5, textTransform: "uppercase",
                border: `1px solid ${b.color}22`,
                color: b.color + "55",
              }}>{b.label}</div>
            ))}
          </div>

          <nav style={{
            display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
            justifyContent: "flex-end",
          }}>
            {Object.entries(SECTIONS).map(([key, s]) => (
              <button key={key} onClick={() => toggle(key)} style={{
                background: "transparent", border: "none", cursor: "pointer",
                padding: "5px 10px", fontSize: 12, color: "#444",
                letterSpacing: 1, transition: "color 0.15s", borderRadius: 4,
              }}
              onMouseEnter={e => e.currentTarget.style.color = "#00eaff"}
              onMouseLeave={e => e.currentTarget.style.color = "#444"}
              >
                {s.icon} {s.title}
              </button>
            ))}
            <span style={{ color: "#1e1e1e", fontSize: 12, margin: "0 4px" }}>|</span>
            <a href="mailto:syltiti@gmail.com" style={{
              color: "#333", fontSize: 12, letterSpacing: 1, textDecoration: "none",
              padding: "5px 10px", borderRadius: 4, transition: "color 0.15s",
            }}
            onMouseEnter={e => e.currentTarget.style.color = "#cc00ff"}
            onMouseLeave={e => e.currentTarget.style.color = "#333"}
            >✉ Contact</a>
          </nav>
        </div>
      </footer>

      {openSection && (
        <LegalModal section={openSection} onClose={() => setOpenSection(null)} />
      )}
    </>
  );
}
