// ─── Parseur de playlists importées (M3U/M3U8/TXT) ─────────────────────────
// Convertit un texte de playlist "de référence" (venant d'un autre logiciel
// DJ, d'une setlist trouvée en ligne, etc.) en une liste normalisée
// [{ title, artist, duration }] — duration en secondes, null si inconnue.
// Le texte d'un PDF est extrait côté serveur (routes/pdfText.js) puis passé
// tel quel à parseTxt() ci-dessous : même heuristique, une seule fois écrite.

// "Artiste - Titre" (convention la plus courante dans les tags/exports DJ) —
// si aucun séparateur reconnu n'est trouvé, tout part dans "title" et
// "artist" reste null (mieux vaut ne rien deviner que deviner faux).
function splitArtistTitle(label) {
  const m = label.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: null, title: label.trim() };
}

// M3U/M3U8 standard : #EXTINF:<durée>,<Artiste> - <Titre>\n<chemin ou URL>
// Certains exports mettent juste le titre après la virgule, sans "Artiste -"
// — géré via splitArtistTitle (artist reste null si pas de tiret détecté).
export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const tracks = [];
  let pending = null; // { duration, label } en attente de la ligne suivante (chemin)

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const m = line.match(/^#EXTINF:(-?\d+(?:\.\d+)?)\s*,(.*)$/);
      if (m) {
        const duration = Number(m[1]) > 0 ? Number(m[1]) : null;
        pending = { duration, label: m[2].trim() };
      }
      continue;
    }
    if (line.startsWith("#")) continue; // autre commentaire M3U, ignoré

    if (pending) {
      const { artist, title } = splitArtistTitle(pending.label);
      tracks.push({ title, artist, duration: pending.duration });
      pending = null;
    } else {
      // Pas de #EXTINF avant cette ligne de chemin : dérive du nom de fichier.
      const base = line.split(/[/\\]/).pop().replace(/\.[a-z0-9]+$/i, "");
      const { artist, title } = splitArtistTitle(base);
      tracks.push({ title, artist, duration: null });
    }
  }
  return tracks;
}

// TXT libre — pas de format fixé (chaque DJ/logiciel exporte différemment).
// Heuristique ligne par ligne : numérotation + durée entre parenthèses
// retirées si présentes, puis "Artiste - Titre" si un tiret est détecté,
// sinon toute la ligne devient le titre (artiste inconnu). Volontairement
// prudent plutôt que "magique" : le résultat est TOUJOURS présenté à
// l'utilisateur pour relecture/correction avant usage (cf. DjPlaylist.jsx),
// mieux vaut une liste imparfaite mais visible qu'un parseur qui invente.
export function parseTxt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const tracks = [];
  for (let line of lines) {
    // Bruit de séparateur de page laissé par l'extraction PDF (routes/pdfText.js,
    // moteur pdf.js) — ex: "-- 1 of 3 --" — jamais un vrai titre de morceau.
    if (/^--\s*\d+\s*of\s*\d+\s*--$/i.test(line)) continue;
    line = line.replace(/^\s*\d{1,3}[.)\-]\s*/, ""); // "12.", "12)", "12 -" en tête
    if (!line) continue;

    let duration = null;
    const durMatch = line.match(/\((\d{1,2}):(\d{2})\)\s*$/);
    if (durMatch) {
      duration = Number(durMatch[1]) * 60 + Number(durMatch[2]);
      line = line.slice(0, durMatch.index).trim();
    }
    if (!line) continue;

    const { artist, title } = splitArtistTitle(line);
    tracks.push({ title, artist, duration });
  }
  return tracks;
}
