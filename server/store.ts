import { randomUUID } from 'node:crypto';
import { LADDER, type Track } from '@shared/types.ts';
import type { ClipSource } from './clips.ts';

export interface GameContext {
  id: string;
  /**
   * The session that built it. A context can hold the tracklist of a private playlist,
   * so it is readable only by its creator — the unguessable id is not the only guard.
   */
  ownerSessionId: string;
  label: string;
  tracks: Track[];
  unresolvedCount: number;
  /** Track id -> where to fetch its audio. Keyed by Track.id. */
  clips: Map<string, ClipSource>;
  /** Track id -> Spotify track id, where one is known. Used to hydrate artwork at reveal. */
  spotifyIds: Map<string, string>;
  /** Ids served recently, so a short session doesn't repeat itself. */
  recent: string[];
  createdAt: number;
}

export interface Round {
  token: string;
  ownerSessionId: string;
  contextId: string;
  answer: Track;
  rung: number;
  over: boolean;
  createdAt: number;
}

/**
 * Both maps are bounded. Without this a long-running public instance climbs until it
 * dies: every context pins hundreds of track objects, and nothing ever referenced them
 * again once the player left.
 */
const CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
const ROUND_TTL_MS = 60 * 60 * 1000;
const MAX_CONTEXTS = 500;
const MAX_ROUNDS = 5_000;

const contexts = new Map<string, GameContext>();
const rounds = new Map<string, Round>();

/** Insertion order is age order, so the oldest keys are simply the first ones. */
function evict<T extends { createdAt: number }>(map: Map<string, T>, ttl: number, max: number): void {
  const cutoff = Date.now() - ttl;
  for (const [k, v] of map) {
    if (v.createdAt >= cutoff) break;
    map.delete(k);
  }
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Test seam: drops all contexts and rounds. */
export function resetStore(): void {
  contexts.clear();
  rounds.clear();
}

export function storeSize(): { contexts: number; rounds: number } {
  return { contexts: contexts.size, rounds: rounds.size };
}

export function putContext(
  ownerSessionId: string,
  label: string,
  tracks: Track[],
  clips: Map<string, ClipSource>,
  unresolvedCount: number,
  spotifyIds: Map<string, string> = new Map(),
): GameContext {
  const ctx: GameContext = {
    id: randomUUID(),
    ownerSessionId,
    label,
    tracks,
    clips,
    spotifyIds,
    unresolvedCount,
    recent: [],
    createdAt: Date.now(),
  };
  evict(contexts, CONTEXT_TTL_MS, MAX_CONTEXTS - 1);
  contexts.set(ctx.id, ctx);
  return ctx;
}

/** Scoped lookup: another session's context reads as absent, not forbidden. */
export function getContext(id: string, sessionId: string): GameContext | undefined {
  const ctx = contexts.get(id);
  if (!ctx || ctx.ownerSessionId !== sessionId) return undefined;
  return ctx;
}

/** Picks a track the context hasn't served lately, keeping the exclusion window under half the pool. */
export function pickTrack(ctx: GameContext): Track {
  const window = Math.min(ctx.recent.length, Math.floor(ctx.tracks.length / 2));
  const blocked = new Set(ctx.recent.slice(-window));
  const eligible = ctx.tracks.filter((t) => !blocked.has(t.id));
  const pool = eligible.length > 0 ? eligible : ctx.tracks;
  const track = pool[Math.floor(Math.random() * pool.length)]!;
  ctx.recent.push(track.id);
  return track;
}

export function startRound(ctx: GameContext): Round {
  const round: Round = {
    token: randomUUID(),
    ownerSessionId: ctx.ownerSessionId,
    contextId: ctx.id,
    answer: pickTrack(ctx),
    rung: 0,
    over: false,
    createdAt: Date.now(),
  };
  evict(rounds, ROUND_TTL_MS, MAX_ROUNDS - 1);
  rounds.set(round.token, round);
  return round;
}

export function getRound(token: string, sessionId: string): Round | undefined {
  const round = rounds.get(token);
  if (!round || round.ownerSessionId !== sessionId) return undefined;
  return round;
}

/** Advances after a wrong guess or skip. Returns true when the ladder is exhausted. */
export function advance(round: Round): boolean {
  round.rung += 1;
  if (round.rung >= LADDER.length) round.over = true;
  return round.over;
}
