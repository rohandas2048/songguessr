import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ContextMode, ContextResponse, Track } from '@shared/types.ts';
import { buildContext, fetchConfig, savePreset } from './api.ts';
import { GuessInput } from './components/GuessInput.tsx';
import { Ladder } from './components/Ladder.tsx';
import { Setup } from './components/Setup.tsx';
import { useGame } from './game/useGame.ts';

export function App() {
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [building, setBuilding] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [canSavePreset, setCanSavePreset] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [trimSilence, setTrimSilence] = useState(true);
  const [randomStart, setRandomStart] = useState(false);

  const options = useMemo(() => ({ trimSilence, randomStart }), [trimSilence, randomStart]);
  const { state, nextRound, replay, stop, guess } = useGame(context, options);

  const start = useCallback(async (mode: ContextMode, value: string) => {
    setBuilding(true);
    setSetupError(null);
    try {
      setSaved(null);
      setContext(await buildContext({ mode, value }));
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'could not build that context');
    } finally {
      setBuilding(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig()
      .then((c) => setCanSavePreset(c.presetWrites))
      .catch(() => setCanSavePreset(false));
  }, []);

  // A fresh context immediately deals a round.
  useEffect(() => {
    if (context) void nextRound();
    // nextRound is recreated per context; depending on it here would re-deal on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  // Space replays without stealing typing in the search box.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = e.target instanceof HTMLInputElement;
      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        void replay();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [replay]);

  if (!context) return <Setup onStart={start} busy={building} error={setupError} />;

  const { phase, ladder, rung, attempts, answer, won, busy } = state;
  const seconds = ladder[Math.min(rung, ladder.length - 1)];
  const remaining = ladder.length - attempts.length;

  return (
    <div className="game">
      <header>
        <button type="button" className="link" onClick={() => { stop(); setContext(null); }}>
          ← change mode
        </button>
        <span className="context-label">
          {context.label}
          <span className="pool-size">
            {context.candidates.length} track{context.candidates.length === 1 ? '' : 's'}
          </span>
        </span>
        <label className="toggle">
          <input type="checkbox" checked={trimSilence} onChange={(e) => setTrimSilence(e.target.checked)} />
          trim silence
        </label>
        <label className="toggle" title="Start somewhere in the middle of the clip instead of the beginning">
          <input type="checkbox" checked={randomStart} onChange={(e) => setRandomStart(e.target.checked)} />
          random start
        </label>
        {/* Authoring only: the server disables preset writes in production. */}
        {canSavePreset && (
          <button
            type="button"
            className="link"
            title="Save this pool so anyone can play it without connecting Spotify"
            onClick={() => {
              void savePreset(context.contextId)
                .then((p) => setSaved(`saved as "${p.label}" (${p.trackCount} tracks)`))
                .catch((e: unknown) => setSaved(e instanceof Error ? e.message : 'could not save'));
            }}
          >
            {saved ?? 'save as featured'}
          </button>
        )}
      </header>

      {context.unresolvedCount > 0 && (
        <p className="notice">{context.unresolvedCount} tracks had no playable clip and were left out.</p>
      )}
      {context.truncated && (
        <p className="notice">
          Loaded the first 100 tracks. If this playlist is longer, the rest are not in play.
        </p>
      )}

      {phase === 'loading' && <p className="notice">Loading clip…</p>}
      {state.error && (
        <p className="error">
          {state.error}
          {/* The context lives in server memory, so a restart or redeploy strands it. */}
          {/expired|no longer playable/.test(state.error) && (
            <button type="button" className="link" onClick={() => { stop(); setContext(null); }}>
              start over
            </button>
          )}
        </p>
      )}

      <Ladder ladder={ladder} rung={rung} attempts={attempts} />

      {phase === 'done' && answer ? (
        <div className={`result ${won ? 'won' : 'lost'}`}>
          <h2>{won ? `Got it in ${attempts.length}` : 'Out of tries'}</h2>
          <div className="answer">
            {answer.artworkUrl && <img src={answer.artworkUrl} alt="" width={96} height={96} />}
            <div>
              <strong>{answer.title}</strong>
              <span>{answer.artist}</span>
              <span className="muted">{answer.album}</span>
            </div>
          </div>
          <div className="actions">
            <button type="button" onClick={() => void replay()}>Play full clip</button>
            <button type="button" className="primary" onClick={() => void nextRound()}>Next song</button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="play"
            disabled={phase !== 'playing'}
            onClick={() => void replay()}
          >
            <span className="play-icon">▶</span>
            <span className="play-time">{seconds !== undefined ? `${seconds}s` : '—'}</span>
            <span className="play-hint">space to replay · unlimited</span>
          </button>

          <GuessInput
            candidates={context.candidates}
            disabled={phase !== 'playing' || busy}
            onGuess={(t: Track) => void guess(t)}
            onSkip={() => void guess(null)}
            skipLabel={remaining > 1 ? 'Skip' : 'Give up'}
          />
        </>
      )}
    </div>
  );
}
