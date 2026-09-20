import type { Track } from '@shared/types.ts';
import type { ClipSource } from './clips.ts';
import { MemoCache } from './cache.ts';
import { searchTracks, trackByIsrc } from './deezer.ts';
import type { UserPlaylistTrack } from './spotify.ts';
import type { EmbedTrack } from './spotifyEmbed.ts';

const CONCURRENCY = 6;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Drop parenthetical qualifiers: "(Remastered 2011)", "- Live" and friends.
    .replace(/[([（].*?[)\]）]/g, ' ')
    .replace(/\s-\s.*$/, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Guards the fuzzy tiers: a search hit only counts if title and artist both look right. */
function plausible(want: { title: string; artist: string }, got: { title: string; artist: string }): boolean {
  const wt = normalize(want.title);
  const gt = normalize(got.title);
  if (!wt || !gt) return false;
  if (!(wt === gt || wt.includes(gt) || gt.includes(wt))) return false;

  const wa = new Set(normalize(want.artist).split(' ').filter(Boolean));
  const ga = normalize(got.artist).split(' ').filter(Boolean);
  return ga.some((word) => wa.has(word));
}

/**
 * Alternate cuts a text search surfaces ahead of the studio original. Penalised
 * unless the wanted title asks for one.
 */
const VARIANT = /\b(live|remix|karaoke|cover|tribute|instrumental|acoustic|demo|reprise|edit|mix|remaster(?:ed)?)\b/i;

/** Picks the studio original out of a text-search result set. */
function pickBest<T extends { title: string; artist: string }>(
  want: { title: string; artist: string },
  candidates: T[],
): T | null {
  const wantsVariant = VARIANT.test(want.title);
  const wantTitle = normalize(want.title);

  const ranked = candidates
    .filter((c) => plausible(want, c))
    .map((c) => {
      let score = c.title.length;
      if (!wantsVariant && VARIANT.test(c.title)) score += 1000;
      if (normalize(c.title) !== wantTitle) score += 100;
      return { c, score };
    })
    .sort((a, b) => a.score - b.score);

  return ranked[0]?.c ?? null;
}

interface ItunesResult {
  trackName: string;
  artistName: string;
  previewUrl?: string;
}

/** Last resort. Apple previews are AAC, which decodeAudioData handles alongside MP3. */
async function itunesPreview(title: string, artist: string): Promise<ClipSource | null> {
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=15`);
    if (!res.ok) return null;
    const body = (await res.json()) as { results: ItunesResult[] };
    const hit = pickBest(
      { title, artist },
      body.results
        .filter((r) => r.previewUrl)
        .map((r) => ({ title: r.trackName, artist: r.artistName, previewUrl: r.previewUrl! })),
    );
    return hit ? { provider: 'direct', url: hit.previewUrl, mime: 'audio/mp4' } : null;
  } catch {
    return null;
  }
}

const resolveCache = new MemoCache<ClipSource | null>(7 * 24 * 60 * 60 * 1000);

export interface Resolvable {
  title: string;
  artist: string;
  isrc?: string | null;
}

/** ISRC (exact) -> Deezer text search -> iTunes. Null means unplayable. */
async function resolveOne(track: Resolvable): Promise<ClipSource | null> {
  const key = track.isrc ?? `${normalize(track.title)}|${normalize(track.artist)}`;
  return resolveCache.wrap(key, async () => {
    if (track.isrc) {
      const exact = await trackByIsrc(track.isrc);
      if (exact) return { provider: 'deezer', deezerId: exact.id };
    }
    const fuzzy = pickBest(track, await searchTracks(track.title, track.artist));
    if (fuzzy) return { provider: 'deezer', deezerId: fuzzy.id };
    return itunesPreview(track.title, track.artist);
  });
}

/** Runs `worker` over `items` with a bounded number in flight. */
async function pooled<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!);
    }
  });
  await Promise.all(runners);
  return out;
}

export interface ResolvedPool {
  tracks: Track[];
  clips: Map<string, ClipSource>;
  /** Track id -> Spotify track id, for hydrating artwork at reveal time. */
  spotifyIds: Map<string, string>;
  unresolvedCount: number;
}

/**
 * Builds a playable pool from an embed tracklist.
 *
 * Spotify's embed ships a preview URL for essentially every track, so the common path
 * needs no matching at all — the audio is the exact track the playlist names. Only the
 * rare track without one falls through to the Deezer/iTunes tiers, where matching is
 * unreliable for non-Latin titles (measured 47% on Chinese-language tracks).
 */
export async function resolveEmbedTracks(entries: EmbedTrack[], coverUrl: string | null): Promise<ResolvedPool> {
  const seen = new Set<string>();
  const unique = entries.filter((t) => {
    if (seen.has(t.spotifyId)) return false;
    seen.add(t.spotifyId);
    return true;
  });

  const needsFallback = unique.filter((t) => !t.previewUrl);
  const fallbacks = new Map<string, ClipSource | null>();
  if (needsFallback.length > 0) {
    const resolved = await pooled(needsFallback, CONCURRENCY, (t) => resolveOne(t));
    needsFallback.forEach((t, i) => fallbacks.set(t.spotifyId, resolved[i]!));
  }

  const tracks: Track[] = [];
  const clips = new Map<string, ClipSource>();
  const spotifyIds = new Map<string, string>();
  let unresolvedCount = 0;

  for (const entry of unique) {
    const source: ClipSource | null = entry.previewUrl
      ? { provider: 'direct', url: entry.previewUrl, mime: 'audio/mpeg' }
      : (fallbacks.get(entry.spotifyId) ?? null);

    if (!source) {
      unresolvedCount++;
      continue;
    }

    // Ids are opaque and context-scoped, so nothing about the answer leaks to the client.
    const id = `t${tracks.length}`;
    tracks.push({
      id,
      title: entry.title,
      artist: entry.artist,
      album: '',
      // Per-track art isn't in the embed payload; hydrated at reveal, playlist cover until then.
      artworkUrl: coverUrl,
      durationSec: entry.durationSec,
    });
    clips.set(id, source);
    spotifyIds.set(id, entry.spotifyId);
  }

  return { tracks, clips, spotifyIds, unresolvedCount };
}

/**
 * Full playlist pool, combining both routes past Spotify's restrictions.
 *
 * The user token supplies the complete tracklist with album metadata and ISRCs — the
 * embed page caps at 100. The embed supplies Spotify's own preview URLs, which are the
 * exact recording and beat any cross-service match. So: order and metadata from the
 * user token, audio from the embed where it reaches, ISRC-joined Deezer beyond that.
 */
export async function resolveMergedPlaylist(
  userTracks: UserPlaylistTrack[],
  embedTracks: EmbedTrack[],
  coverUrl: string | null,
): Promise<ResolvedPool> {
  const previews = new Map<string, string>();
  for (const t of embedTracks) if (t.previewUrl) previews.set(t.spotifyId, t.previewUrl);

  const seen = new Set<string>();
  const unique = userTracks.filter((t) => {
    if (seen.has(t.spotifyId)) return false;
    seen.add(t.spotifyId);
    return true;
  });

  const needsFallback = unique.filter((t) => !previews.has(t.spotifyId));
  const fallbacks = new Map<string, ClipSource | null>();
  if (needsFallback.length > 0) {
    const resolved = await pooled(needsFallback, CONCURRENCY, (t) => resolveOne(t));
    needsFallback.forEach((t, i) => fallbacks.set(t.spotifyId, resolved[i]!));
  }

  const tracks: Track[] = [];
  const clips = new Map<string, ClipSource>();
  const spotifyIds = new Map<string, string>();
  let unresolvedCount = 0;

  for (const entry of unique) {
    const preview = previews.get(entry.spotifyId);
    const source: ClipSource | null = preview
      ? { provider: 'direct', url: preview, mime: 'audio/mpeg' }
      : (fallbacks.get(entry.spotifyId) ?? null);

    if (!source) {
      unresolvedCount++;
      continue;
    }

    const id = `t${tracks.length}`;
    tracks.push({
      id,
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      artworkUrl: entry.artworkUrl ?? coverUrl,
      durationSec: entry.durationSec,
    });
    clips.set(id, source);
    spotifyIds.set(id, entry.spotifyId);
  }

  return { tracks, clips, spotifyIds, unresolvedCount };
}
