import React, { useState, useEffect, useRef, useCallback } from "react";
import { readAudioTags } from "../utils/audioTags.js";
import { saveLibraryHandle, loadLibraryHandle, getCachedAnalysis, setCachedAnalysis } from "../utils/libraryDb.js";
import { fetchAlbumArtUrl } from "../utils/albumArt.js";

const API = "http://localhost:3001";

// ── Bibliothèque de morceaux façon VirtualDJ (30/07) ────────────────────────
// Arbre de dossiers persistant (File System Access API — Chrome/Edge, cf.
// showDirectoryPicker) à gauche, liste du dossier sélectionné à droite
// (pochette/titre/artiste/BPM/clé), boutons →A/→B pour charger un morceau
// dans un deck. Les tags (titre/artiste/pochette embarquée) sont lus en
// local (jsmediatags, aucune requête réseau) ; le BPM/clé n'est calculé
// QU'À LA DEMANDE (bouton 🧬 par ligne) — lancer Demucs sur un dossier de
// centaines de fichiers au simple fait de l'ouvrir serait bien trop lourd.

const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"]);
const isAudioFile = (name) => AUDIO_EXT.has(name.slice(name.lastIndexOf(".")).toLowerCase());

// ── Nœud d'arbre de dossiers — récursif, chargement paresseux (une entrée
// n'énumère son propre contenu qu'à son premier dépli, comme VirtualDJ). ───
function FolderNode({ handle, name, path, depth, selectedPath, onSelectFolder }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [children, setChildren] = useState(null); // null = pas encore chargé
  const [loading, setLoading] = useState(false);

  const loadChildren = useCallback(async () => {
    if (children !== null) return;
    setLoading(true);
    const subfolders = [];
    try {
      for await (const [childName, childHandle] of handle.entries()) {
        if (childHandle.kind === "directory") subfolders.push({ name: childName, handle: childHandle });
      }
    } catch { /* dossier illisible (permission retirée entre-temps, etc.) */ }
    subfolders.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    setChildren(subfolders);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  useEffect(() => { if (depth === 0) loadChildren(); }, [depth, loadChildren]);

  const toggle = async (e) => {
    e.stopPropagation();
    if (!expanded) await loadChildren();
    setExpanded(v => !v);
  };

  const isSelected = selectedPath === path;

  return (
    <div>
      <div
        onClick={() => onSelectFolder(handle, path, name)}
        style={{
          display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", paddingLeft: 8 + depth * 14,
          cursor: "pointer", borderRadius: 4, fontSize: 12.5,
          background: isSelected ? "rgba(0,234,255,0.15)" : "transparent",
          color: isSelected ? "var(--cyan)" : "var(--muted2)", fontWeight: isSelected ? 700 : 500,
        }}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
      >
        <span onClick={toggle}
          style={{ width: 14, textAlign: "center", flexShrink: 0, color: "#666", userSelect: "none" }}>
          {loading ? "…" : expanded ? "▾" : "▸"}
        </span>
        <span style={{ flexShrink: 0 }}>📁</span>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      </div>
      {expanded && children && children.map(c => (
        <FolderNode key={c.name} handle={c.handle} name={c.name} path={`${path}/${c.name}`}
          depth={depth + 1} selectedPath={selectedPath} onSelectFolder={onSelectFolder} />
      ))}
    </div>
  );
}

// ── Vignette d'une ligne : pochette embarquée dans le fichier (instantané)
// sinon recherche iTunes à partir du titre/artiste des tags (même service
// que le reste de l'app, cf. utils/albumArt.js) — jamais d'appel réseau
// supplémentaire si le fichier a déjà sa pochette embarquée. ────────────────
function TrackThumb({ track }) {
  const [url, setUrl] = useState(track.tags?.picture || null);
  useEffect(() => {
    let cancelled = false;
    if (track.tags?.picture) { setUrl(track.tags.picture); return; }
    if (!track.tags?.title) return;
    fetchAlbumArtUrl(track.tags.title, track.tags.artist).then(u => { if (!cancelled && u) setUrl(u); });
    return () => { cancelled = true; };
  }, [track.tags?.picture, track.tags?.title, track.tags?.artist]);

  if (!url) return <div style={{ width: 30, height: 30, borderRadius: 4, background: "#181818", flexShrink: 0 }} />;
  return <img src={url} alt="" style={{ width: 30, height: 30, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />;
}

export default function MacheupDjLibrary({ onLoadToDeck, onClose }) {
  const [rootHandle, setRootHandle] = useState(null);
  const [permission, setPermission] = useState(null); // null|"granted"|"prompt"|"denied"|"unsupported"
  const [selectedFolder, setSelectedFolder] = useState(null); // { handle, path, name }
  const [tracks, setTracks] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [search, setSearch] = useState("");
  const scanTokenRef = useRef(0);

  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;

  // Retrouve le dossier mémorisé au montage, et vérifie la permission — la
  // re-demander automatiquement est impossible (ça exige un geste
  // utilisateur), d'où le bouton "Autoriser l'accès" plus bas si besoin.
  useEffect(() => {
    if (!supported) { setPermission("unsupported"); return; }
    (async () => {
      const handle = await loadLibraryHandle().catch(() => null);
      if (!handle) { setPermission("prompt"); return; }
      setRootHandle(handle);
      try {
        const perm = await handle.queryPermission({ mode: "read" });
        setPermission(perm);
      } catch { setPermission("prompt"); }
    })();
  }, [supported]);

  const pickFolder = async () => {
    try {
      const handle = await window.showDirectoryPicker();
      await saveLibraryHandle(handle);
      setRootHandle(handle);
      setPermission("granted");
      setSelectedFolder(null);
      setTracks([]);
    } catch { /* utilisateur a annulé la sélection */ }
  };

  const requestAccess = async () => {
    if (!rootHandle) return;
    try {
      const perm = await rootHandle.requestPermission({ mode: "read" });
      setPermission(perm);
    } catch { /* refusé */ }
  };

  // ── Sélection d'un dossier : liste ses fichiers audio puis lit leurs tags
  // par petits paquets (concurrence limitée — ni tout d'un coup sur un
  // dossier de centaines de fichiers, ni un par un). scanTokenRef ignore les
  // résultats d'un scan devenu obsolète si l'utilisateur change de dossier
  // avant la fin.
  const selectFolder = async (handle, path, name) => {
    const token = ++scanTokenRef.current;
    setSelectedFolder({ handle, path, name });
    setTracks([]);
    setLoadingFiles(true);
    const found = [];
    try {
      for await (const [childName, childHandle] of handle.entries()) {
        if (childHandle.kind === "file" && isAudioFile(childName)) {
          found.push({ name: childName, handle: childHandle, relPath: `${path}/${childName}` });
        }
      }
    } catch { /* dossier illisible */ }
    found.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    if (scanTokenRef.current !== token) return;
    setTracks(found.map(f => ({ ...f, tags: null, analysis: null, analyzing: false, analyzeError: null })));
    setLoadingFiles(false);

    const CHUNK = 8;
    for (let i = 0; i < found.length; i += CHUNK) {
      if (scanTokenRef.current !== token) return;
      const chunk = found.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async (f) => {
        const file = await f.handle.getFile();
        const tags = await readAudioTags(file);
        const cached = await getCachedAnalysis(f.relPath, file).catch(() => null);
        return { relPath: f.relPath, tags, analysis: cached };
      }));
      if (scanTokenRef.current !== token) return;
      setTracks(prev => prev.map(t => {
        const r = results.find(res => res.relPath === t.relPath);
        return r ? { ...t, tags: r.tags, analysis: r.analysis } : t;
      }));
    }
  };

  // ── Analyse BPM/clé à la demande — réutilise POST /api/analyze/upload
  // (même endpoint que MACHEUP pour un mp3 uploadé). Prépare AUSSI les
  // stems 4 pistes en même temps (le endpoint ne sait faire que ça pour
  // l'instant) — pas du gâchis : charger ce morceau plus tard dans un deck
  // (ici ou dans MACHEUP) retombera instantanément sur ce même cache serveur.
  const analyzeTrack = async (track) => {
    setTracks(prev => prev.map(t => t.relPath === track.relPath ? { ...t, analyzing: true, analyzeError: null } : t));
    try {
      const file = await track.handle.getFile();
      const fd = new FormData();
      fd.append("audio", file, track.name);
      fd.append("title", track.tags?.title || track.name);
      fd.append("stemMode", "4");
      const res = await fetch(`${API}/api/analyze/upload`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Échec du lancement");

      const applyResult = async (result) => {
        await setCachedAnalysis(track.relPath, file, result).catch(() => {});
        setTracks(prev => prev.map(t => t.relPath === track.relPath ? { ...t, analysis: result, analyzing: false } : t));
      };

      if (data.cached && data.track) { await applyResult(data.track); return; }

      const poll = async () => {
        const r = await fetch(`${API}/api/analyze/${data.jobId}/status`);
        const d = await r.json();
        if (d.status === "running") { setTimeout(poll, 2000); return; }
        if (d.status === "error") {
          setTracks(prev => prev.map(t => t.relPath === track.relPath ? { ...t, analyzing: false, analyzeError: d.message } : t));
          return;
        }
        if (d.status === "done") await applyResult(d.track);
      };
      poll();
    } catch (e) {
      setTracks(prev => prev.map(t => t.relPath === track.relPath ? { ...t, analyzing: false, analyzeError: e.message } : t));
    }
  };

  const loadToDeck = async (track, side) => {
    const file = await track.handle.getFile();
    onLoadToDeck?.(file, side);
  };

  const filteredTracks = search.trim()
    ? tracks.filter(t => {
        const q = search.toLowerCase();
        return t.name.toLowerCase().includes(q)
          || t.tags?.title?.toLowerCase().includes(q)
          || t.tags?.artist?.toLowerCase().includes(q);
      })
    : tracks;

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14,
      marginBottom: 16, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 12, fontWeight: 900, letterSpacing: 2, color: "var(--muted2)" }}>
          📁 BIBLIOTHÈQUE
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {rootHandle && (
            <button type="button" onClick={pickFolder} title="Changer de dossier"
              style={{ fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 6,
                border: "1px solid var(--border)", background: "rgba(255,255,255,0.03)", color: "var(--muted2)", cursor: "pointer" }}>
              🔁 Changer
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose}
              style={{ fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 6,
                border: "1px solid var(--border)", background: "rgba(255,255,255,0.03)", color: "var(--muted2)", cursor: "pointer" }}>
              ✕ Fermer
            </button>
          )}
        </div>
      </div>

      {!supported && (
        <div style={{ padding: 16, fontSize: 12.5, color: "#ff8080" }}>
          ⚠ Ton navigateur ne permet pas de mémoriser l'accès à un dossier (File System Access API absente).
          Utilise Chrome ou Edge pour la bibliothèque.
        </div>
      )}

      {supported && !rootHandle && (
        <div style={{ padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 12.5, color: "var(--muted2)", marginBottom: 10 }}>
            Choisis le dossier de musique à parcourir — mémorisé pour les prochaines fois.
          </div>
          <button type="button" onClick={pickFolder}
            style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid var(--cyan)",
              background: "rgba(0,234,255,0.1)", color: "var(--cyan)", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
            📁 Choisir un dossier
          </button>
        </div>
      )}

      {supported && rootHandle && permission !== "granted" && (
        <div style={{ padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 12.5, color: "var(--yellow)", marginBottom: 10 }}>
            🔓 Le navigateur redemande une confirmation d'accès à ce dossier à chaque nouvelle session.
          </div>
          <button type="button" onClick={requestAccess}
            style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid var(--yellow)",
              background: "rgba(255,204,0,0.1)", color: "var(--yellow)", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
            🔓 Autoriser l'accès
          </button>
        </div>
      )}

      {supported && rootHandle && permission === "granted" && (
        <div style={{ display: "flex", height: 360 }}>
          <div style={{ width: 220, borderRight: "1px solid var(--border)", overflowY: "auto", padding: "8px 0", flexShrink: 0 }}>
            <FolderNode handle={rootHandle} name={rootHandle.name || "Bibliothèque"} path="" depth={0}
              selectedPath={selectedFolder?.path ?? null} onSelectFolder={(h, p, n) => selectFolder(h, p, n)} />
          </div>

          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, alignItems: "center" }}>
              <input type="text" placeholder="🔍 Filtrer ce dossier (titre, artiste)…" value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "5px 9px", fontSize: 12, color: "white" }} />
              <div style={{ fontSize: 10.5, color: "var(--muted2)", whiteSpace: "nowrap" }}>
                {selectedFolder ? `${filteredTracks.length} morceau${filteredTracks.length > 1 ? "x" : ""}` : "Choisis un dossier"}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto" }}>
              {!selectedFolder && (
                <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--muted2)" }}>
                  ← Clique un dossier pour voir ses morceaux
                </div>
              )}
              {selectedFolder && loadingFiles && (
                <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--muted2)" }}>Lecture du dossier…</div>
              )}
              {selectedFolder && !loadingFiles && filteredTracks.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--muted2)" }}>Aucun fichier audio ici.</div>
              )}
              {filteredTracks.map(track => (
                <div key={track.relPath}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px",
                    borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <TrackThumb track={track} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "white", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {track.tags?.title || track.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {track.tags?.artist || "—"}
                    </div>
                  </div>
                  <div style={{ width: 60, textAlign: "center", fontSize: 11, color: "var(--muted2)", flexShrink: 0 }}>
                    {track.analysis ? (
                      <span style={{ color: "var(--cyan)", fontWeight: 700 }}>{track.analysis.bpm ?? "?"}</span>
                    ) : track.analyzing ? "⏳" : track.analyzeError ? (
                      <span style={{ color: "#ff8080" }} title={track.analyzeError}>⚠</span>
                    ) : "—"}
                  </div>
                  <div style={{ width: 36, textAlign: "center", fontSize: 11, color: "var(--muted2)", flexShrink: 0 }}>
                    {track.analysis?.camelot || "—"}
                  </div>
                  {!track.analysis && (
                    <button type="button" disabled={track.analyzing} onClick={() => analyzeTrack(track)}
                      title="Analyser BPM/clé (et préparer les stems)"
                      style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "3px 6px", borderRadius: 5,
                        border: "1px solid var(--border)", background: "rgba(255,255,255,0.03)",
                        color: track.analyzing ? "#444" : "var(--muted2)", cursor: track.analyzing ? "default" : "pointer" }}>
                      🧬
                    </button>
                  )}
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <button type="button" onClick={() => loadToDeck(track, "A")}
                      title="Charger dans le Deck A"
                      style={{ fontSize: 10, fontWeight: 800, padding: "4px 8px", borderRadius: 5,
                        border: "1px solid #00eaff55", background: "rgba(0,234,255,0.08)", color: "#00eaff", cursor: "pointer" }}>
                      →A
                    </button>
                    <button type="button" onClick={() => loadToDeck(track, "B")}
                      title="Charger dans le Deck B"
                      style={{ fontSize: 10, fontWeight: 800, padding: "4px 8px", borderRadius: 5,
                        border: "1px solid #cc00ff55", background: "rgba(204,0,255,0.08)", color: "#cc00ff", cursor: "pointer" }}>
                      →B
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
