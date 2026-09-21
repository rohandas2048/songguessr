import { useEffect, useState, type ReactNode } from 'react';
import { searchEntities, type Entity } from '../api.ts';

interface Props {
  type: 'artist' | 'album';
  busy: boolean;
  onPick: (id: string) => void;
  /** Curator only: given, each result grows a control for adding it to the Featured tab. */
  onFeature?: (id: string, name: string) => void;
  /** Rendered above the results — the artist depth toggle lives here. */
  children?: ReactNode;
}

export function EntitySearch({ type, busy, onPick, onFeature, children }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entity[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      searchEntities(type, q)
        .then((r) => {
          setResults(r);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'search failed'));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, type]);

  // A pasted Spotify link skips search entirely — the server bridges it to Deezer.
  const pastedLink = /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(artist|album)\//.test(query.trim());

  return (
    <div className="entity-search">
      <input
        type="text"
        value={query}
        disabled={busy}
        autoComplete="off"
        placeholder={`Search for an ${type}, or paste a Spotify ${type} link…`}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && pastedLink) onPick(query.trim());
        }}
      />
      {children}
      {error && <p className="error">{error}</p>}
      {pastedLink && (
        <button type="button" className="primary link-go" disabled={busy} onClick={() => onPick(query.trim())}>
          Use this Spotify link
        </button>
      )}
      <ul className="entity-list">
        {results.map((e) => (
          <li key={e.id}>
            <button type="button" disabled={busy} onClick={() => onPick(String(e.id))}>
              {e.pictureUrl ? <img src={e.pictureUrl} alt="" width={40} height={40} /> : <span className="ph" />}
              <span className="e-name">{e.name}</span>
              {e.subtitle && <span className="e-sub">{e.subtitle}</span>}
            </button>
            {onFeature && (
              <button
                type="button"
                className="link feature-add"
                title={`Add ${e.name} to the Featured tab for everyone`}
                onClick={() => onFeature(String(e.id), e.name)}
              >
                + featured
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
