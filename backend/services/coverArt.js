// ─── Récupération de pochette d'album/EP (base de données internationale) ──
// Retour utilisateur (31/07) : remplacer la miniature YouTube (souvent une
// capture d'écran de clip, pas la vraie pochette) par la véritable pochette
// d'album/EP du morceau quand elle existe, via une base de données musicale.
//
// Source choisie à l'origine : iTunes Search API (Apple) — gratuite, sans
// clé, sans inscription, couverture internationale très large (labels
// majors ET indés), et taillable jusqu'à 600x600 en changeant simplement
// l'URL retournée. Pas besoin d'OAuth ni de quota à gérer contrairement à
// Spotify/Discogs.
//
// ⛔ DÉSACTIVÉ (02/08) : l'appel à l'API iTunes provoquait un flood de
// requêtes (une par titre affiché) et se faisait bannir par Apple (403/429).
// À la demande de l'utilisateur, tout contact réseau vers itunes.apple.com
// est coupé ici — on retourne systématiquement null (pas de pochette), sans
// jamais appeler fetch(). Le reste du pipeline (route, front) continue de
// fonctionner à l'identique et retombe sur la miniature YouTube en repli.
// Pour réactiver : restaurer le corps de fonction précédent (voir historique
// git) et remettre un vrai throttle/backoff avant de ré-appeler iTunes.
export const fetchAlbumArt = async (_artist, _song) => {
  return null;
};
