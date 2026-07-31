import jsmediatags from "jsmediatags/dist/jsmediatags.min.js";

// ─── Lecture de tags ID3/MP4/FLAC en local (bibliothèque MACHEUPDJ) ────────
// Aucune requête réseau, aucun quota — contrairement à la reconnaissance
// audio AudD (MACHEUP), utilisée elle pour un seul fichier à la fois. Ici on
// peut lire des dizaines/centaines de fichiers d'un coup (bibliothèque façon
// VirtualDJ), donc pas question de les faire tous "écouter" par un service
// externe : jsmediatags lit juste les en-têtes de tags déjà présents dans
// chaque fichier, quasi instantané.

export function readAudioTags(file) {
  return new Promise((resolve) => {
    try {
      jsmediatags.read(file, {
        onSuccess: ({ tags }) => {
          let picture = null;
          if (tags.picture) {
            try {
              const { data, format } = tags.picture;
              let binary = "";
              for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
              picture = `data:${format};base64,${btoa(binary)}`;
            } catch { /* pochette illisible, tant pis */ }
          }
          resolve({
            title: tags.title || null,
            artist: tags.artist || null,
            album: tags.album || null,
            picture,
          });
        },
        onError: () => resolve({ title: null, artist: null, album: null, picture: null }),
      });
    } catch {
      resolve({ title: null, artist: null, album: null, picture: null });
    }
  });
}
