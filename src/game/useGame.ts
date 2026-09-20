import { useCallback, useEffect, useRef, useState } from 'react';
import { LADDER, type ContextResponse, type Track } from '@shared/types.ts';
import { AudioEngine } from '../audio/engine.ts';
import { pickStartOffset } from '../audio/onset.ts';
import { clipUrl, startRound, submitGuess } from '../api.ts';

export type Phase = 'idle' | 'loading' | 'playing' | 'done';

export interface Attempt {
  /** null means the player skipped. */
  track: Track | null;
  correct: boolean;
}

export interface GameState {
  phase: Phase;
  ladder: readonly number[];
  rung: number;
  attempts: Attempt[];
  answer: Track | null;
  won: boolean;
  error: string | null;
  busy: boolean;
}

const EMPTY: GameState = {
  phase: 'idle',
  ladder: [],
  rung: 0,
  attempts: [],
  answer: null,
  won: false,
  error: null,
  busy: false,
};

export interface GameOptions {
  trimSilence: boolean;
  randomStart: boolean;
}

export function useGame(context: ContextResponse | null, options: GameOptions) {
  const [state, setState] = useState<GameState>(EMPTY);
  const engineRef = useRef<AudioEngine | null>(null);
  const tokenRef = useRef<string | null>(null);
  const offsetRef = useRef(0);

  const engine = useCallback((): AudioEngine => {
    engineRef.current ??= new AudioEngine();
    return engineRef.current;
  }, []);

  useEffect(() => () => engineRef.current?.dispose(), []);

  const nextRound = useCallback(async () => {
    if (!context) return;
    setState({ ...EMPTY, phase: 'loading' });
    try {
      const round = await startRound(context.contextId);
      tokenRef.current = round.roundToken;
      await engine().load(clipUrl(round.roundToken));
      // Computed once per round so every rung reveals from the same origin.
      offsetRef.current = pickStartOffset(engine().audioBuffer!, {
        random: options.randomStart,
        trim: options.trimSilence,
        longestRungSec: LADDER[LADDER.length - 1]!,
      });
      setState({ ...EMPTY, phase: 'playing', ladder: round.ladder });
    } catch (err) {
      setState({ ...EMPTY, error: err instanceof Error ? err.message : 'failed to start round' });
    }
  }, [context, engine, options.randomStart, options.trimSilence]);

  /** Replays the currently unlocked window. Free and unlimited — no state changes. */
  const replay = useCallback(async () => {
    const { ladder, rung, phase } = state;
    if (phase === 'loading') return;
    if (phase === 'done') {
      // After the reveal there is nothing left to hide, so play the clip entire.
      try {
        await engine().play(engine().duration, 0);
      } catch (err) {
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'playback failed' }));
      }
      return;
    }
    const seconds = ladder[Math.min(rung, ladder.length - 1)];
    if (seconds === undefined) return;
    try {
      await engine().play(seconds, offsetRef.current);
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'playback failed' }));
    }
  }, [engine, state]);

  const stop = useCallback(() => engine().stop(), [engine]);

  const guess = useCallback(
    async (track: Track | null) => {
      const token = tokenRef.current;
      if (!token || state.phase !== 'playing' || state.busy) return;
      setState((s) => ({ ...s, busy: true }));
      try {
        const result = await submitGuess(token, track?.id ?? null);
        setState((s) => ({
          ...s,
          busy: false,
          rung: result.rung,
          attempts: [...s.attempts, { track, correct: result.correct }],
          phase: result.over ? 'done' : 'playing',
          answer: result.answer ?? null,
          won: result.correct,
        }));
      } catch (err) {
        setState((s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : 'guess failed' }));
      }
    },
    [state.phase, state.busy],
  );

  return { state, nextRound, replay, stop, guess };
}
