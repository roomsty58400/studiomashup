import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Footer from "../components/Footer.jsx";
import {
  saveLibraryHandle, loadLibraryHandle, scanLibraryRecursive,
  getCachedAnalysis, setCachedAnalysis,
} from "../utils/libraryDb.js";
import { parseM3U, parseTxt } from "../utils/playlistParse.js";
import { findBestMatch, normalize, candidateFromEntry } from "../utils/textMatch.js";
import { buildAnimationPlaylist } from "../utils/djPacing.js";
import { exportM3U, exportTXT } from "../utils/playlistExport.js";
import { DJ_PLAYLIST_PRESETS } from "../data/djPlaylistPresets.js";

const API = "http://localhost:3001";

// ── DJPLAYLIST (30/07) — créateur de playlist thématique ───────────────────
// 1. Scanne la bibliothèque locale (même dossier persistant que MACHEUPDJ).
// 2. Compare des playlists "de référence" (importées M3U/TXT/PDF, ou
//    suggestions de départ) à cette bibliothèque → trouvé / manquant.
// 3. Génère une playlist ordonnée façon "profil d'animation de soirée"
//    (accueil → dîner → montée → pic → clôture, cf. utils/djPacing.js) à
//    partir des morceaux trouvés ET analysés (BPM/énergie).
// 4. Exporte en M3U (chemins relatifs au dossier bibliothèque) et en TXT
//    numéroté.
// Cf. diagnostic notes du 30/07 : limite honnête assumée — File System
// Access API ne donne jamais de chemin ABSOLU réel (sécurité navigateur),
// d'où l'export M3U en chemins relatifs (déposer le .m3u8 à la racine du
// dossier bibliothèque pour que VirtualDJ/Winamp/Serato le résolvent).

const fmtDuration = (sec) => {
  if (!sec || !isFinite(sec)) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
const fmtMinutes = (sec) => `${Math.round((sec || 0) / 60)} min`;

let batchCounter = 0;

export default function DjPlaylist({ onSendToMacheupDJ }) {
  // ── Bibliothèque locale ──
  const [rootHandle, setRootHandle] = useState(null);
  const [permission, setPermission] = useState(null); // null|"granted"|"prompt"|"denied"|"unsupported"
  const [libraryEntries, setLibraryEntries] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanStats, setScanStats] = useState(null);
  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;

  // ── Playlists de référence importées/ajoutées (regroupées par lot) ──
  const [batches, setBatches] = useState([]); // [{ id, theme, style, tracks:[{title,artist,duration}] }]
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [pendingTheme, setPendingTheme] = useState("");
  const [pendingStyle, setPendingStyle] = useState("");

  // ── Génération ──
  const [genTheme, setGenTheme] = useState("");
  const [genStyles, setGenStyles] = useState([]); // sous-styles cochés
  const [genMinutes, setGenMinutes] = useState(120);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(null); // { done, total }
  const [genResult, setGenResult] = useState(null); // { phases, tracks }
  const [genError, setGenError] = useState(null);
  const [genPoolInfo, setGenPoolInfo] = useState(null); // { direct, expanded }
  const cancelGenRef = useRef(false);

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
      setLibraryEntries([]);
    } catch { /* annulé */ }
  };

  const requestAccess = async () => {
    if (!rootHandle) return;
    try { setPermission(await rootHandle.requestPermission({ mode: "read" })); } catch { /* refusé */ }
  };

  const scanLibrary = async () => {
    if (!rootHandle) return;
    setScanning(true); setScanProgress(0); setScanStats(null);
    try {
      const { entries, stats } = await scanLibraryRecursive(rootHandle, (n) => setScanProgress(n));
      setLibraryEntries(entries);
      setScanStats(stats);
    } finally {
      setScanning(false);
    }
  };

  // ── Import M3U / TXT / PDF ──
  const addBatch = (theme, style, tracks) => {
    if (!theme.trim() || !style.trim() || tracks.length === 0) return;
    batchCounter++;
    setBatches(prev => [...prev, { id: batchCounter, theme: theme.trim(), style: style.trim(), tracks }]);
  };

  const handleImportFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // permet de réimporter le même fichier ensuite
    if (files.length === 0) return;
    if (!pendingTheme.trim() || !pendingStyle.trim()) {
      setImportError("Indique un thème et un style avant d'importer (ex : Mariage / Bohème).");
      return;
    }
    setImporting(true); setImportError(null);
    try {
      let allTracks = [];
      for (const file of files) {
        const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
        let text;
        if (ext === ".pdf") {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch(`${API}/api/pdf-text`, { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Échec de lecture du PDF");
          text = data.text;
        } else {
          text = await file.text();
        }
        const tracks = (ext === ".m3u" || ext === ".m3u8") ? parseM3U(text) : parseTxt(text);
        allTracks = allTracks.concat(tracks);
      }
      if (allTracks.length === 0) throw new Error("Aucun titre reconnu dans ce(s) fichier(s).");
      addBatch(pendingTheme, pendingStyle, allTracks);
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const addPreset = (preset) => addBatch(preset.theme, preset.style, preset.tracks);

  const removeBatch = (id) => setBatches(prev => prev.filter(b => b.id !== id));

  // ── Comparaison (recalculée SEULEMENT quand batches ou libraryEntries
  // changent, jamais à chaque render) ──
  // Bug corrigé (31/07, retour utilisateur "ça bug" en génération) : sans
  // useMemo, ce calcul (comparaison floue de CHAQUE piste de référence
  // contre TOUTE la bibliothèque scannée) se relançait à CHAQUE re-render —
  // y compris à chaque tick de progression pendant la génération
  // (setGenProgress toutes les quelques secondes). Sur une grosse
  // bibliothèque (des milliers de fichiers, cf. retour utilisateur sur le
  // nombre de morceaux scannés), ce recalcul synchrone pouvait prendre
  // plusieurs secondes et geler complètement l'onglet à chaque tick.
  //
  // 2e bug corrigé (31/07, retour utilisateur "lag qd on retire un lot") :
  // le useMemo ci-dessus dépend de `batches` en entier — retirer UN lot
  // change la référence du tableau `batches`, ce qui relançait le matching
  // flou pour TOUS les lots restants, pas seulement celui retiré (chaque
  // piste comparée à toute la bibliothèque = coûteux). On mémorise donc
  // aussi les résultats déjà calculés par piste (matchCacheRef), invalidés
  // uniquement quand la bibliothèque elle-même change (nouveau scan) — pas
  // quand on ajoute/retire un lot de référence.
  const matchCacheRef = useRef({ library: null, map: new Map() });
  const comparedBatches = useMemo(() => {
    if (matchCacheRef.current.library !== libraryEntries) {
      matchCacheRef.current = { library: libraryEntries, map: new Map() };
    }
    const cache = matchCacheRef.current.map;
    return batches.map(b => ({
      ...b,
      results: b.tracks.map((t, idx) => {
        const cacheKey = `${b.id}:${idx}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        const match = libraryEntries.length ? findBestMatch(t, libraryEntries) : null;
        const result = { ...t, found: !!match, matchEntry: match?.entry || null, score: match?.score || 0 };
        cache.set(cacheKey, result);
        return result;
      }),
    }));
  }, [batches, libraryEntries]);

  const themes = [...new Set(batches.map(b => b.theme))];
  const stylesForGenTheme = [...new Set(batches.filter(b => b.theme === genTheme).map(b => b.style))];

  const toggleGenStyle = (style) => {
    setGenStyles(prev => prev.includes(style) ? prev.filter(s => s !== style) : [...prev, style]);
  };

  // ── Génération : analyse à la demande (séquentielle — jamais 2 Demucs en
  // parallèle, cf. même contrainte que MACHEUP/MACHEUPDJ) puis pacing. ──────
  const runGeneration = async () => {
    if (!genTheme || genStyles.length === 0) return;
    cancelGenRef.current = false;
    setGenerating(true); setGenError(null); setGenResult(null); setGenPoolInfo(null);

    try {
      const matched = comparedBatches
        .filter(b => b.theme === genTheme && genStyles.includes(b.style))
        .flatMap(b => b.results.filter(r => r.found).map(r => ({ ...r, style: b.style })));

      // Dédoublonne (le même fichier local peut matcher 2 pistes de
      // référence différentes issues de 2 imports) — garde la 1ère occurrence.
      const seen = new Set();
      const uniqueMatched = matched.filter(m => {
        const key = m.matchEntry.relPath;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (uniqueMatched.length === 0) {
        setGenError("Aucun morceau trouvé localement pour ce thème/style — importe/complète ta bibliothèque, ou choisis un autre style.");
        return;
      }

      // ── Élargissement du pool à TOUTE la bibliothèque scannée (31/07,
      // retour utilisateur : "il ne prend pas en compte l'entièreté de ma
      // bibliothèque") ──────────────────────────────────────────────────
      // Jusqu'ici, la génération ne piochait QUE parmi les morceaux qui
      // matchent EXACTEMENT une piste des playlists de référence importées
      // (souvent une poignée de titres) — le reste de la bibliothèque
      // scannée (potentiellement des milliers de morceaux) n'était jamais
      // utilisé, même s'il contenait clairement des morceaux du même style.
      // On étend donc le pool : tout morceau de la bibliothèque dont
      // l'artiste correspond (flou) à un artiste déjà repéré dans les
      // références pour CE thème/style est aussi inclus comme candidat.
      const anchorArtistsByStyle = new Map(); // style -> Set(artiste normalisé)
      for (const m of uniqueMatched) {
        const artist = m.matchEntry?.tags?.artist || m.artist;
        const norm = normalize(artist);
        if (!norm) continue;
        if (!anchorArtistsByStyle.has(m.style)) anchorArtistsByStyle.set(m.style, new Set());
        anchorArtistsByStyle.get(m.style).add(norm);
      }

      const seenPaths = new Set(uniqueMatched.map(m => m.matchEntry.relPath));
      const directCount = uniqueMatched.length;
      let expandedCount = 0;
      // Plafond de l'expansion : chaque candidat ajouté déclenche ensuite une
      // analyse BPM/énergie complète côté serveur (séparation Demucs incluse,
      // coûteuse) — sans limite, une bibliothèque avec quelques artistes très
      // fournis pourrait ajouter des centaines de candidats et rendre la
      // génération interminable. On plafonne large par rapport au nombre de
      // morceaux réellement nécessaires pour remplir la durée ciblée (~200s/
      // morceau en moyenne, x3 de marge pour laisser le pacing par phase
      // choisir parmi plusieurs candidats plutôt qu'un seul par créneau).
      const neededEstimate = Math.max(15, Math.ceil((genMinutes * 60) / 200));
      const maxExpanded = neededEstimate * 3;
      let expansionCapped = false;
      if (anchorArtistsByStyle.size > 0 && libraryEntries.length > 0) {
        for (const entry of libraryEntries) {
          if (expandedCount >= maxExpanded) { expansionCapped = true; break; }
          if (seenPaths.has(entry.relPath)) continue;
          const candidate = candidateFromEntry(entry);
          const normArtist = normalize(candidate.artist);
          if (!normArtist) continue;
          for (const [style, artistSet] of anchorArtistsByStyle) {
            if (artistSet.has(normArtist)) {
              uniqueMatched.push({
                title: candidate.title, artist: candidate.artist,
                matchEntry: entry, style, found: true, score: 1,
              });
              seenPaths.add(entry.relPath);
              expandedCount++;
              break;
            }
          }
        }
      }
      setGenPoolInfo({ direct: directCount, expanded: expandedCount, capped: expansionCapped });

      setGenProgress({ done: 0, total: uniqueMatched.length });
      const candidates = [];
      for (let i = 0; i < uniqueMatched.length; i++) {
        if (cancelGenRef.current) break;
        const m = uniqueMatched[i];
        const entry = m.matchEntry;
        try {
          const file = await entry.handle.getFile();
          let analysis = await getCachedAnalysis(entry.relPath, file).catch(() => null);
          if (!analysis) {
            const fd = new FormData();
            fd.append("audio", file, entry.name);
            fd.append("title", entry.tags?.title || entry.name);
            fd.append("stemMode", "4");
            const res = await fetch(`${API}/api/analyze/upload`, { method: "POST", body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Échec du lancement");
            if (data.cached && data.track) {
              analysis = data.track;
            } else {
              // Vérifie l'annulation à CHAQUE tick de polling (pas seulement
              // entre 2 morceaux) — sinon "Annuler" pendant l'analyse d'un
              // gros morceau reste sans effet visible pendant plusieurs
              // minutes (retour utilisateur "ça bug", cause n°3 identifiée).
              analysis = await new Promise((resolve, reject) => {
                const poll = async () => {
                  if (cancelGenRef.current) { resolve(null); return; }
                  const r = await fetch(`${API}/api/analyze/${data.jobId}/status`);
                  const d = await r.json();
                  if (cancelGenRef.current) { resolve(null); return; }
                  if (d.status === "running") { setTimeout(poll, 2000); return; }
                  if (d.status === "error") { reject(new Error(d.message || "Analyse échouée")); return; }
                  resolve(d.track);
                };
                poll();
              });
              if (cancelGenRef.current || !analysis) break;
            }
            await setCachedAnalysis(entry.relPath, file, analysis).catch(() => {});
          }
          candidates.push({
            relPath: entry.relPath,
            handle: entry.handle, // conservé pour permettre l'envoi vers MACHEUPDJ (lecture directe du fichier)
            title: entry.tags?.title || m.title,
            artist: entry.tags?.artist || m.artist,
            duration: analysis.duration,
            energy_rms: analysis.energy_rms,
            bpm: analysis.bpm,
            style: m.style,
          });
        } catch (err) {
          console.warn(`[DJPLAYLIST] analyse ignorée pour ${entry.relPath} :`, err.message);
        }
        setGenProgress({ done: i + 1, total: uniqueMatched.length });
      }

      if (cancelGenRef.current) {
        setGenError("Génération annulée.");
        return;
      }

      if (candidates.length === 0) {
        setGenError("Aucun morceau n'a pu être analysé (BPM/énergie) — réessaie, ou vérifie que le serveur tourne bien.");
        return;
      }

      const result = buildAnimationPlaylist(candidates, genMinutes * 60);
      setGenResult(result);
    } catch (err) {
      // Bug corrigé (31/07, retour utilisateur "ça bug") : ce try n'avait
      // pas de catch — toute exception échappant aux try/catch internes
      // (ex: erreur réseau, bug dans buildAnimationPlaylist) devenait un
      // rejet non géré ; le finally remettait bien le bouton "Générer" en
      // état normal, mais sans jamais expliquer à l'utilisateur ce qui
      // s'était passé — d'où l'impression de "bug" silencieux.
      console.error("[DJPLAYLIST] génération échouée :", err);
      setGenError(err.message || "Erreur inattendue pendant la génération. Réessaie, ou vérifie que le serveur tourne bien.");
    } finally {
      setGenerating(false);
      setGenProgress(null);
    }
  };

  const totalGenDuration = genResult ? genResult.tracks.reduce((s, t) => s + (t.duration || 0), 0) : 0;

  return (
    <div className="app" style={{ paddingBottom: 0 }}>
      <div style={{ padding: "28px 16px 40px", flex: 1, minHeight: 0, overflowY: "auto", maxWidth: 980, margin: "0 auto", width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 22, fontWeight: 900, letterSpacing: 3,
            background: "linear-gradient(90deg, var(--cyan), #fff 50%, var(--magenta))",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
            🗂 DJPLAYLIST
          </div>
        </div>

        {/* ── 1. Bibliothèque locale ── */}
        <Section title="① BIBLIOTHÈQUE LOCALE">
          {!supported && (
            <div style={{ fontSize: 12.5, color: "#ff8080" }}>
              ⚠ File System Access API absente de ce navigateur — utilise Chrome ou Edge.
            </div>
          )}
          {supported && !rootHandle && (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 12.5, color: "var(--muted2)" }}>Choisis ton dossier de musique (le même que celui utilisé dans MACHEUPDJ si déjà configuré).</div>
              <BtnPrimary onClick={pickFolder}>📁 Choisir un dossier</BtnPrimary>
            </div>
          )}
          {supported && rootHandle && permission !== "granted" && (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 12.5, color: "var(--yellow)" }}>🔓 Confirmation d'accès nécessaire à chaque nouvelle session.</div>
              <BtnPrimary onClick={requestAccess} color="var(--yellow)">🔓 Autoriser l'accès</BtnPrimary>
            </div>
          )}
          {supported && rootHandle && permission === "granted" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontSize: 12.5, color: "var(--muted2)" }}>
                  📁 {rootHandle.name} — {libraryEntries.length > 0 ? `${libraryEntries.length} morceau${libraryEntries.length > 1 ? "x" : ""} scanné${libraryEntries.length > 1 ? "s" : ""}` : "pas encore scanné"}
                </div>
                <BtnPrimary onClick={scanLibrary} disabled={scanning}>
                  {scanning ? `⏳ Scan… ${scanProgress}` : "🔄 (Re)scanner la bibliothèque"}
                </BtnPrimary>
                <BtnGhost onClick={pickFolder}>🔁 Changer de dossier</BtnGhost>
              </div>
              {scanStats && (
                <div style={{ fontSize: 10.5, color: "#555", marginTop: 6 }}>
                  {scanStats.totalFiles} fichiers vus · {scanStats.audioFound} morceaux audio
                  {scanStats.nonAudioSkipped > 0 && ` · ${scanStats.nonAudioSkipped} non-audio ignorés (images, .nfo, playlists…)`}
                  {scanStats.unreadable > 0 && ` · ${scanStats.unreadable} illisibles (ex : fichiers cloud pas téléchargés localement)`}
                  {scanStats.foldersUnreadable > 0 && ` · ${scanStats.foldersUnreadable} dossier(s) inaccessible(s)`}
                  {" — si le compte ne correspond toujours pas à ce que montre l'Explorateur Windows, dis-moi le nombre exact affiché ici, ça aide à trouver quel format manque."}
                </div>
              )}
            </>
          )}
        </Section>

        {/* ── 2. Import / suggestions ── */}
        <Section title="② PLAYLISTS DE RÉFÉRENCE">
          <div style={{ fontSize: 11.5, color: "var(--muted2)", marginBottom: 10 }}>
            Importe une setlist existante (M3U/M3U8/TXT/PDF) ou pars d'une suggestion — chaque lot est rangé sous un thème + style.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <input type="text" placeholder="Thème (ex: Mariage)" value={pendingTheme} onChange={e => setPendingTheme(e.target.value)}
              style={inputStyle} />
            <input type="text" placeholder="Style (ex: Bohème)" value={pendingStyle} onChange={e => setPendingStyle(e.target.value)}
              style={inputStyle} />
            <label style={{ ...btnPrimaryStyle("var(--cyan)"), cursor: "pointer" }}>
              {importing ? "⏳ Import…" : "⬆ Importer M3U/TXT/PDF"}
              <input type="file" accept=".m3u,.m3u8,.txt,.pdf" multiple onChange={handleImportFiles}
                disabled={importing} style={{ display: "none" }} />
            </label>
          </div>
          {importError && <div style={{ fontSize: 11.5, color: "#ff8080", marginBottom: 10 }}>⚠ {importError}</div>}

          <div style={{ fontSize: 10.5, color: "#666", marginBottom: 10, lineHeight: 1.5 }}>
            ℹ Chaque titre de la playlist importée/suggérée est comparé (par titre + artiste, tolérant aux petites différences d'orthographe) à ta bibliothèque scannée ①.
            <span style={{ color: "#5fd98a" }}> ✅ trouvé</span> = un fichier correspondant assez proche a été identifié (survole le titre pour voir lequel) ·
            <span style={{ color: "#ff8080" }}> ❌ pas trouvé</span> = rien d'assez ressemblant dans ta bibliothèque, ou pas encore scannée.
          </div>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 6 }}>Ou pars d'une suggestion (titres emblématiques, pas une playlist officielle) :</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {DJ_PLAYLIST_PRESETS.map((p, i) => (
              <BtnGhost key={i} onClick={() => addPreset(p)}>+ {p.theme} / {p.style}</BtnGhost>
            ))}
          </div>

          {batches.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted2)", textAlign: "center", padding: 10 }}>Aucune playlist de référence pour l'instant.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {comparedBatches.map(b => {
                const foundCount = b.results.filter(r => r.found).length;
                return (
                  <div key={b.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "white" }}>
                        {b.theme} <span style={{ color: "var(--cyan)" }}>/ {b.style}</span>
                        <span style={{ color: "var(--muted2)", fontWeight: 400, marginLeft: 8 }}>
                          {foundCount}/{b.results.length} trouvé{foundCount > 1 ? "s" : ""} dans ta bibliothèque
                          {libraryEntries.length === 0 ? " (scanne ta bibliothèque ci-dessus pour comparer)" : ""}
                        </span>
                      </div>
                      <button onClick={() => removeBatch(b.id)} title="Retirer ce lot"
                        style={{ background: "transparent", border: "none", color: "#666", cursor: "pointer", fontSize: 13 }}>✕</button>
                    </div>
                    <div style={{ maxHeight: 160, overflowY: "auto" }}>
                      {b.results.map((r, i) => (
                        <div key={i}
                          title={r.found
                            ? `Correspond à : ${r.matchEntry?.relPath || "?"} (${Math.round((r.score || 0) * 100)}% de correspondance)`
                            : "Aucun fichier assez ressemblant dans ta bibliothèque scannée"}
                          style={{ display: "flex", gap: 8, fontSize: 11.5, padding: "2px 0",
                          color: r.found ? "var(--muted2)" : "#ff8080" }}>
                          <span>{r.found ? "✅" : "❌"}</span>
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.artist ? `${r.artist} — ` : ""}{r.title}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ── 3. Génération ── */}
        <Section title="③ GÉNÉRER LA PLAYLIST">
          {themes.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted2)" }}>Ajoute d'abord au moins une playlist de référence ci-dessus.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <select value={genTheme} onChange={e => { setGenTheme(e.target.value); setGenStyles([]); }} style={inputStyle}>
                  <option value="" style={optionStyle}>— Choisir un thème —</option>
                  {themes.map(t => <option key={t} value={t} style={optionStyle}>{t}</option>)}
                </select>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {stylesForGenTheme.map(s => (
                    <label key={s} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5,
                      color: genStyles.includes(s) ? "var(--cyan)" : "var(--muted2)", cursor: "pointer" }}>
                      <input type="checkbox" checked={genStyles.includes(s)} onChange={() => toggleGenStyle(s)} />
                      {s}
                    </label>
                  ))}
                </div>
                <label style={{ fontSize: 11.5, color: "var(--muted2)", display: "flex", alignItems: "center", gap: 6 }}>
                  Durée cible
                  <input type="number" min="15" max="600" step="15" value={genMinutes}
                    onChange={e => setGenMinutes(Number(e.target.value))} style={{ ...inputStyle, width: 70 }} />
                  min
                </label>
                <BtnPrimary onClick={runGeneration} disabled={generating || !genTheme || genStyles.length === 0}>
                  {generating ? "⏳ Génération…" : "🎛 Générer"}
                </BtnPrimary>
              </div>

              {generating && genProgress && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 11.5, color: "var(--yellow)" }}>
                    ⏳ Analyse BPM/énergie des morceaux ({genProgress.done}/{genProgress.total}) — première fois seulement pour chaque morceau, peut prendre du temps.
                  </div>
                  <BtnGhost onClick={() => { cancelGenRef.current = true; }}>✕ Annuler</BtnGhost>
                </div>
              )}
              {genError && <div style={{ fontSize: 11.5, color: "#ff8080", marginBottom: 10 }}>⚠ {genError}</div>}

              {genResult && genResult.tracks.length > 0 && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: "var(--muted2)" }}>
                      {genResult.tracks.length} morceaux · {fmtMinutes(totalGenDuration)} au total
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <BtnGhost onClick={() => exportM3U(genResult.tracks, `${genTheme}-${genStyles.join("+")}.m3u8`)}>⬇ M3U</BtnGhost>
                      <BtnGhost onClick={() => exportTXT(genResult.tracks, `${genTheme}-${genStyles.join("+")}.txt`)}>⬇ TXT</BtnGhost>
                      {onSendToMacheupDJ && (
                        <BtnPrimary color="var(--magenta)" onClick={() => onSendToMacheupDJ({
                          theme: genTheme, styles: genStyles, tracks: genResult.tracks,
                        })}>
                          🎧 Envoyer vers MACHEUPDJ
                        </BtnPrimary>
                      )}
                    </div>
                  </div>
                  {genPoolInfo && (
                    <div style={{ fontSize: 10.5, color: "#666", marginBottom: 6 }}>
                      ℹ Pool de départ : {genPoolInfo.direct} morceau{genPoolInfo.direct > 1 ? "x" : ""} trouvé{genPoolInfo.direct > 1 ? "s" : ""} directement dans tes playlists de référence
                      {genPoolInfo.expanded > 0
                        ? ` + ${genPoolInfo.expanded} autre${genPoolInfo.expanded > 1 ? "s" : ""} du même artiste retrouvé${genPoolInfo.expanded > 1 ? "s" : ""} ailleurs dans ta bibliothèque${genPoolInfo.capped ? " (plafonné pour garder un temps de génération raisonnable)" : ""}.`
                        : " (aucun morceau supplémentaire du même artiste trouvé ailleurs dans ta bibliothèque)."}
                    </div>
                  )}
                  <div style={{ fontSize: 10.5, color: "#555", marginBottom: 10 }}>
                    ℹ Export M3U en chemins relatifs à ton dossier bibliothèque (limite du navigateur : pas d'accès au chemin absolu réel) —
                    place le fichier .m3u8 exporté directement dans ce dossier pour que VirtualDJ/Winamp/Serato retrouvent les morceaux.
                  </div>
                  {genResult.phases.map(phase => (
                    <div key={phase.key} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--cyan)", letterSpacing: 1, marginBottom: 4 }}>
                        {phase.label.toUpperCase()} — {phase.tracks.length} titres · {fmtMinutes(phase.duration)}
                      </div>
                      {phase.tracks.map((t, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, fontSize: 11.5, color: "var(--muted2)", padding: "2px 0 2px 10px" }}>
                          <span style={{ width: 60, flexShrink: 0, color: "#555" }}>{t.bpm ? `${Math.round(t.bpm)} BPM` : ""}</span>
                          <span style={{ flex: 1 }}>{t.artist ? `${t.artist} — ` : ""}{t.title}</span>
                          <span style={{ color: "#555" }}>{fmtDuration(t.duration)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Section>
      </div>
      <Footer />
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
      <div style={{ fontFamily: "Orbitron,sans-serif", fontSize: 12, fontWeight: 900, letterSpacing: 2, color: "var(--muted2)", marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// Fond OPAQUE obligatoire (pas rgba quasi-transparent) : sur un <select>,
// un fond translucide laisse le navigateur afficher son propre habillage
// par défaut derrière/autour du contrôle (souvent clair) — texte blanc sur
// ce fond clair devenait illisible, et ce 2e habillage donnait l'impression
// d'un cadre dédoublé. Même règle appliquée aux <input>/<select> par
// cohérence. Cf. .radio-select dans styles.css pour le même principe déjà
// utilisé ailleurs dans l'app.
const inputStyle = {
  background: "#111318", border: "1px solid var(--border)", borderRadius: 6,
  padding: "6px 10px", fontSize: 12, color: "white",
};
// Un <select> a besoin d'un style explicite sur SES <option> en plus du
// style du <select> lui-même — sans ça, la liste déroulée retombe sur le
// thème clair par défaut du navigateur/OS, indépendamment du style du
// contrôle fermé.
const optionStyle = { background: "#111318", color: "white" };

const btnPrimaryStyle = (color = "var(--cyan)") => ({
  fontSize: 11.5, fontWeight: 800, padding: "6px 14px", borderRadius: 7,
  border: `1px solid ${color}`, background: `${color}1a`, color, letterSpacing: 0.5,
});

function BtnPrimary({ children, onClick, disabled, color }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ ...btnPrimaryStyle(color), cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}

function BtnGhost({ children, onClick }) {
  return (
    <button type="button" onClick={onClick}
      style={{ fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 7,
        border: "1px solid var(--border)", background: "rgba(255,255,255,0.03)", color: "var(--muted2)", cursor: "pointer" }}>
      {children}
    </button>
  );
}
