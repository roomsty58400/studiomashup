import React, { useState, useEffect } from "react";
import { fetchAlbumArtUrl } from "../utils/albumArt.js";

// <img> qui affiche la miniature YouTube (fallback) immédiatement, puis la
// remplace en douceur par la vraie pochette d'album/EP si la recherche
// aboutit. Ne jamais rien afficher de vide/cassé en attendant : on part
// toujours du fallback fourni par l'appelant (video.thumb / thumbnail).
export default function AlbumArt({ title, channel, fallback, alt = "", style, className }) {
  const [src, setSrc] = useState(fallback);

  useEffect(() => {
    let cancelled = false;
    setSrc(fallback);
    if (!title) return;
    fetchAlbumArtUrl(title, channel).then(url => {
      if (!cancelled && url) setSrc(url);
    });
    return () => { cancelled = true; };
  }, [title, channel, fallback]);

  return (
    <img
      src={src}
      alt={alt}
      style={style}
      className={className}
      onError={() => setSrc(fallback)}
    />
  );
}
