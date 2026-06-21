import { useState } from "react";

export default function DeckSearch({ onSelectVideo }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    const res = await fetch(
      `http://localhost:3001/api/youtube/search?q=${encodeURIComponent(query)}`
    );
    const data = await res.json();
    setResults(data);
    setLoading(false);
  };

  return (
    <div className="deck-search">
      <div className="deck-search-row">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Artiste / chanson"
        />
        <button onClick={search}>Rechercher</button>
      </div>

      {loading && <div>Recherche…</div>}

      <div className="deck-results">
        {results.map(v => (
          <button
            key={v.videoId}
            className="deck-result-item"
            onClick={() => onSelectVideo(v)}
          >
            <img src={v.thumbnail} alt={v.title} />
            <div className="title">{v.title}</div>
            <div className="channel">{v.channel}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
