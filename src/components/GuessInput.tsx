import { useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '@shared/types.ts';
import { searchTracks } from '../game/search.ts';

interface Props {
  candidates: Track[];
  disabled: boolean;
  onGuess: (track: Track) => void;
  onSkip: () => void;
  skipLabel: string;
}

export function GuessInput({ candidates, disabled, onGuess, onSkip, skipLabel }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchTracks(candidates, query), [candidates, query]);

  useEffect(() => setActive(0), [query]);

  function choose(track: Track) {
    setQuery('');
    onGuess(track);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  }

  return (
    <div className="guess">
      <div className="guess-field">
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          placeholder="Search for a song…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {results.length > 0 && (
          <ul className="results">
            {results.map((track, i) => (
              <li key={track.id}>
                <button
                  type="button"
                  className={i === active ? 'active' : ''}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(track)}
                >
                  <span className="r-title">{track.title}</span>
                  <span className="r-artist">{track.artist}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="skip" disabled={disabled} onClick={onSkip}>
        {skipLabel}
      </button>
    </div>
  );
}
