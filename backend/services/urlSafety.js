// ── Garde-fou anti-SSRF partagé (audit juillet 2026) ────────────────────────
// Contexte : routes/radio.js accepte une URL de flux radio fournie librement
// par le client (GET /api/radio/now-playing?url=..., POST /api/radio/record/
// start) et l'utilise pour (a) une requête HTTP/HTTPS sortante côté serveur,
// (b) un `spawn("ffmpeg", ["-i", url, ...])` qui écrit sur le disque local.
// Contrairement à routes/mediaProxy.js et routes/diag.js (qui restreignent à
// un seul domaine connu, rave.dj), une radio peut légitimement être
// N'IMPORTE QUEL flux Icecast/Shoutcast public sur Internet — une allowlist
// de domaine n'a pas de sens ici.
//
// Le risque concret : ces 2 routes sont des GET/POST "simples" (pas de
// préflight CORS nécessaire) — une page web totalement extérieure, ouverte
// dans le même navigateur pendant que ce backend tourne en localhost:3001,
// peut déclencher ces requêtes à l'insu de l'utilisateur (ex: une balise
// <img src="http://localhost:3001/api/radio/now-playing?url=http://192.168.1.1/admin">).
// Le CORS configuré côté serveur empêche seulement CETTE page de LIRE la
// réponse, pas d'ENVOYER la requête — un SSRF aveugle vers le réseau local
// (scan de ports, interaction avec des services internes) reste possible
// sans ce garde-fou.
//
// Deux niveaux de contrôle, volontairement séparés :
//  1. assertPublicHttpUrl() — bloque les URLs qui pointent LITTÉRALEMENT
//     (par IP ou nom d'hôte évident) vers une adresse privée/loopback/
//     link-local. Synchrone, aucun appel réseau.
//  2. assertResolvesToPublicIp() (audit juillet 2026, 2e passe) — résout
//     RÉELLEMENT le nom d'hôte et rejette si l'IP obtenue est privée/interne
//     ("DNS rebinding" statique : un domaine public dont le A/AAAA pointe
//     vers une IP interne). Cf. commentaire détaillé au-dessus de sa
//     définition pour la limite assumée (protection au moment de la
//     vérification, pas garantie au moment exact de la connexion réelle).
import { lookup as dnsLookup } from "dns/promises";

const ipv4Octets = (host) => {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(n => n >= 0 && n <= 255) ? parts : null;
};

const isPrivateOrReservedIPv4 = (host) => {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 127) return true;               // loopback (127.0.0.0/8)
  if (a === 10) return true;                 // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;   // 192.168.0.0/16
  if (a === 169 && b === 254) return true;   // 169.254.0.0/16 (link-local)
  if (a === 0) return true;                  // 0.0.0.0/8
  return false;
};

const isPrivateOrReservedIPv6 = (host) => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "::") return true;                  // loopback / unspecified
  if (h.startsWith("fe80:")) return true;                       // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;                 // fc00::/7 (ULA)
  if (h.startsWith("::ffff:")) return isPrivateOrReservedIPv4(h.slice(7)); // IPv4-mapped
  return false;
};

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

// Lève une exception explicite si l'URL n'est pas une cible publique
// raisonnable ; ne fait AUCUN appel réseau elle-même (juste une analyse de
// la chaîne d'URL fournie).
export const assertPublicHttpUrl = (rawUrl) => {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("URL invalide.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Protocole non autorisé : ${u.protocol}`);
  }
  const host = u.hostname;
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase()) || host.toLowerCase().endsWith(".local")) {
    throw new Error("Hôte local non autorisé pour cette fonction.");
  }
  if (isPrivateOrReservedIPv4(host) || isPrivateOrReservedIPv6(host)) {
    throw new Error("Adresse IP privée/interne non autorisée pour cette fonction.");
  }
  return u;
};

// ── Durcissement DNS rebinding (audit juillet 2026, 2e passe) ──────────────
// assertPublicHttpUrl() ci-dessus ne regarde que la CHAÎNE de l'URL fournie
// (IP littérale ou nom d'hôte évident) — un nom de domaine public tout à fait
// normal en apparence peut avoir un enregistrement DNS A/AAAA qui pointe vers
// une adresse privée/interne (pas besoin d'un TTL qui change pour ça : un
// simple enregistrement statique malveillant suffit). assertResolvesToPublicIp()
// résout RÉELLEMENT le nom d'hôte et rejette si UNE SEULE des adresses
// obtenues est privée/réservée.
//
// Limite assumée (documentée pour transparence, comme le reste de ce
// fichier) : ceci protège le moment de la VÉRIFICATION, pas nécessairement
// celui de la connexion réelle qui suit juste après — fetch()/spawn ffmpeg
// résolvent le DNS une SECONDE fois, indépendamment de ce contrôle. Un vrai
// rebinding "TOCTOU" (le DNS change PENDANT la toute petite fenêtre entre
// cette vérification et la connexion réelle, TTL très court) resterait
// théoriquement possible. Le fermer complètement exigerait de résoudre l'IP
// UNE fois puis de forcer fetch()/ffmpeg à s'y connecter directement
// (pinning d'adresse tout en gardant le Host d'origine) — hors de portée
// raisonnable pour cette passe (app desktop non exposée à Internet ; ce
// scénario suppose un attaquant qui contrôle déjà le DNS d'un domaine ET
// devine le timing exact d'une requête locale). Ce qui EST fermé ici : le cas
// réaliste et statique — un domaine public dont le A/AAAA pointe simplement,
// tout le temps, vers une adresse privée.
export const assertResolvesToPublicIp = async (rawUrl) => {
  const u = new URL(rawUrl);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // Hôte déjà une IP littérale : assertPublicHttpUrl l'a déjà validée plus
  // haut dans l'appelant, rien de plus à résoudre.
  if (ipv4Octets(host) || host.includes(":")) return;
  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`Résolution DNS impossible pour "${host}" : ${e.message}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new Error(`Aucune adresse résolue pour "${host}".`);
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIPv4(address) || isPrivateOrReservedIPv6(address)) {
      throw new Error(`Hôte "${host}" résout vers une adresse privée/interne (${address}) — refusé.`);
    }
  }
};
