// ─── Export d'une playlist générée (DJPLAYLIST) ────────────────────────────
// 2 formats, tous deux lisibles par VirtualDJ / Winamp / Serato DJ :
//
// - M3U : chemins RELATIFS au dossier bibliothèque choisi (File System
//   Access API ne donne jamais accès au chemin absolu réel sur le disque,
//   par sécurité navigateur — c'est une limite du web, pas un raccourci pris
//   ici). Pour que le logiciel DJ retrouve les morceaux, placer le fichier
//   .m3u exporté directement À LA RACINE de ce même dossier bibliothèque.
// - TXT : liste numérotée titre/artiste/durée, pour impression ou partage,
//   aucune contrainte d'emplacement.

function downloadTextFile(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const fmtDuration = (sec) => {
  if (!sec || !isFinite(sec)) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

export function exportM3U(tracks, filename = "playlist.m3u8") {
  const lines = ["#EXTM3U"];
  for (const t of tracks) {
    const label = t.artist ? `${t.artist} - ${t.title}` : t.title;
    lines.push(`#EXTINF:${Math.round(t.duration || 0)},${label}`);
    // Chemin relatif tel que scanné (cf. scanLibraryRecursive) — utilise
    // déjà "/" comme séparateur, compatible M3U multi-plateforme.
    lines.push(t.relPath);
  }
  downloadTextFile(filename, lines.join("\n") + "\n", "audio/x-mpegurl;charset=utf-8");
}

export function exportTXT(tracks, filename = "playlist.txt") {
  const lines = tracks.map((t, i) => {
    const num = String(i + 1).padStart(2, "0");
    const artist = t.artist || "?";
    const dur = fmtDuration(t.duration);
    return `${num}. ${t.title} — ${artist}${dur ? ` (${dur})` : ""}`;
  });
  downloadTextFile(filename, lines.join("\n") + "\n");
}
