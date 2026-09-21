import type { Track } from '@shared/types.ts';
import { MemoCache } from './cache.ts';

const API = 'https://api.deezer.com';

/**
 * Deezer allows roughly 50 requests per 5 seconds per IP, and answers a burst past that
 * with `Quota limit exceeded` — in a 200 body, so it surfaces as a failed lookup rather
 * than a status code. Resolving a long playlist or walking a discography goes through
 * this many calls easily, so every request is paced through one bucket.
 *
 * Capacity 40 refilling at 8/s keeps a burst under the limit while staying fast for the
 * single-call paths (a genre chart, one preview URL) that make up most requests.
 */
const RATE = { capacity: 40, refillPerSec: 8 };
let tokens = RATE.capacity;
let lastRefill = Date.now();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(RATE.capacity, tokens + ((now - lastRefill) / 1000) * RATE.refillPerSec);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - tokens) / RATE.refillPerSec) * 1000));
  }
}

/** Deezer has no CORS header on api.deezer.com, so every call here is server-side only. */
async function dz<T>(path: string, attempt = 0): Promise<T> {
  await takeToken();
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`deezer ${path} -> ${res.status}`);
  const body = (await res.json()) as T & { error?: { message: string; code: number } };
  // Deezer signals failure in a 200 body rather than a status code.
  if (body && typeof body === 'object' && 'error' in body && body.error) {
    // The pacer should prevent this, but a second process on the same IP can still trip
    // it. One backoff turns a lost track into a slow one.
    if (/quota/i.test(body.error.message) && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      return dz<T>(path, attempt + 1);
    }
    throw new Error(`deezer ${path} -> ${body.error.message}`);
  }
  return body;
}

interface DzTrack {
  id: number;
  title: string;
  duration: number;
  preview: string;
  readable?: boolean;
  artist: { name: string; picture_medium?: string };
  album?: { title?: string; cover_medium?: string | null };
}

export interface DzGenre {
  id: number;
  name: string;
}

function toTrack(t: DzTrack): Track {
  return {
    id: String(t.id),
    title: t.title,
    artist: t.artist.name,
    album: t.album?.title ?? '',
    artworkUrl: t.album?.cover_medium ?? null,
    durationSec: t.duration,
  };
}

const genreCache = new MemoCache<DzGenre[]>(24 * 60 * 60 * 1000);
const chartCache = new MemoCache<Track[]>(60 * 60 * 1000);

/** The "All" pseudo-genre (id 0) is dropped — it isn't a real category to play. */
export function listGenres(): Promise<DzGenre[]> {
  return genreCache.wrap('genres', async () => {
    const { data } = await dz<{ data: DzGenre[] }>('/genre');
    return data.filter((g) => g.id !== 0).sort((a, b) => a.name.localeCompare(b.name));
  });
}

export function chartTracks(genreId: number, limit = 100): Promise<Track[]> {
  return chartCache.wrap(`chart:${genreId}:${limit}`, async () => {
    const { data } = await dz<{ data: DzTrack[] }>(`/chart/${genreId}/tracks?limit=${limit}`);
    return data.filter((t) => t.readable !== false && t.preview).map(toTrack);
  });
}

/**
 * Fetches a *fresh* preview URL. Cached URLs expire in ~14 minutes, so this is
 * always called at play time rather than at pool-build time.
 */
export async function previewUrl(trackId: string): Promise<string | null> {
  const t = await dz<DzTrack>(`/track/${trackId}`);
  return t.preview || null;
}

export interface DzEntity {
  id: number;
  name: string;
  /** Artist name for albums; undefined for artists. */
  subtitle?: string;
  pictureUrl: string | null;
}

interface DzArtist { id: number; name: string; picture_medium?: string | null; nb_album?: number }
interface DzAlbum {
  id: number;
  title: string;
  cover_medium?: string | null;
  artist?: { name: string };
  tracks?: { data: DzTrack[] };
  /** 'album' | 'ep' | 'single' | 'compilation' on the artist-albums endpoint. */
  record_type?: string;
  release_date?: string;
}

function encode(q: string): string {
  return encodeURIComponent(q.trim());
}

/** One artist by id, for storing a featured entry from Deezer's answer rather than the caller's. */
export async function getArtist(artistId: string): Promise<DzEntity | null> {
  try {
    const a = await dz<DzArtist>(`/artist/${artistId}`);
    return { id: a.id, name: a.name, pictureUrl: a.picture_medium ?? null };
  } catch {
    return null;
  }
}

export async function searchArtists(q: string, limit = 8): Promise<DzEntity[]> {
  const { data } = await dz<{ data: DzArtist[] }>(`/search/artist?q=${encode(q)}&limit=${limit}`);
  return data.map((a) => ({ id: a.id, name: a.name, pictureUrl: a.picture_medium ?? null }));
}

export async function searchAlbums(q: string, limit = 8): Promise<DzEntity[]> {
  const { data } = await dz<{ data: DzAlbum[] }>(`/search/album?q=${encode(q)}&limit=${limit}`);
  return data.map((a) => ({
    id: a.id,
    name: a.title,
    subtitle: a.artist?.name,
    pictureUrl: a.cover_medium ?? null,
  }));
}

/** Deezer's /artist/{id}/top is the replacement for Spotify's 403-ing top-tracks. */
export async function artistTopTracks(artistId: string, limit = 100): Promise<{ name: string; tracks: Track[] }> {
  const [artist, top] = await Promise.all([
    dz<DzArtist>(`/artist/${artistId}`),
    dz<{ data: DzTrack[] }>(`/artist/${artistId}/top?limit=${limit}`),
  ]);
  return { name: artist.name, tracks: top.data.filter((t) => t.preview).map(toTrack) };
}

/**
 * The artist's whole catalogue, not just their top 100.
 *
 * Deezer's /artist/{id}/top caps at 100, which is the cap the Artist tab used to live
 * with. Walking the discography instead lifts it — and needs no Spotify connection,
 * since Deezer is already the audio source. A Spotify token would not help here: it
 * carries no scopes, and Spotify's artist endpoints do not expose playable audio.
 *
 * Bounded on purpose. A prolific artist has hundreds of releases once compilations and
 * singles are counted, and each album costs one request against a rate-limited API.
 */
/** Titles that announce a non-studio recording. Deezer has no flag for it. */
function isLive(title: string): boolean {
  return /\b(live|en vivo|en direct|unplugged|concert|acoustic session)\b/i.test(title);
}

/**
 * Folds the variations of one song onto a single key.
 *
 * "Creep", "Creep (Acoustic)", "Creep - Remastered 2009" and "Creep (Live at Glastonbury)"
 * are one guessable song. Keeping them apart fills the dropdown with answers the player
 * cannot tell from each other and makes the same track come up four times as often.
 */
function songKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    // Everything from a bracket or a dash-suffix onward: the qualifier, not the song.
    .replace(/[([].*$/, '')
    .replace(/\s-\s.*$/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export async function artistCatalog(
  artistId: string,
  { maxAlbums = 60, maxTracks = 500 } = {},
): Promise<{ name: string; tracks: Track[] }> {
  const [artist, albums] = await Promise.all([
    dz<DzArtist>(`/artist/${artistId}`),
    dz<{ data: DzAlbum[] }>(`/artist/${artistId}/albums?limit=${maxAlbums}`),
  ]);

  const out: Track[] = [];
  const seen = new Set<string>();

  // Studio albums first, then EPs and singles, compilations last, and anything that
  // announces itself as live after its studio equivalent. Order matters because the
  // first version of a song to arrive is the one kept: a player asked to name a track
  // from a tenth of a second should hear the recording they know.
  const rank = (a: DzAlbum): number => {
    const type = { album: 0, ep: 1, single: 2, compilation: 3 }[a.record_type ?? 'album'] ?? 3;
    return type * 2 + (isLive(a.title) ? 1 : 0);
  };
  const ordered = [...albums.data].sort((a, b) => rank(a) - rank(b));

  // Batched only to stop building a 60-deep promise array; the pacer in dz() is what
  // actually keeps this inside Deezer's rate limit.
  const BATCH = 8;
  for (let i = 0; i < ordered.length && out.length < maxTracks; i += BATCH) {
    const batch = ordered.slice(i, i + BATCH);
    const loaded = await Promise.all(
      batch.map((a) => albumTracks(String(a.id)).catch(() => null)),
    );
    for (const album of loaded) {
      if (!album) continue;
      for (const t of album.tracks) {
        // Compilations and features carry other people's songs; keep this artist's.
        if (t.artist !== artist.name) continue;
        const k = songKey(t.title);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(t);
        if (out.length >= maxTracks) break;
      }
    }
  }

  // A catalogue walk can still come up short — an artist with one unreadable album, say.
  // The caller decides whether that is enough; here we only report what was found.
  return { name: artist.name, tracks: out };
}

export async function albumTracks(albumId: string): Promise<{ name: string; artist: string; tracks: Track[] }> {
  const album = await dz<DzAlbum>(`/album/${albumId}`);
  const tracks = (album.tracks?.data ?? [])
    .filter((t) => t.preview)
    // Album tracklists omit the album object on each track; graft it on for the UI.
    .map((t) => ({ ...toTrack(t), album: album.title, artworkUrl: album.cover_medium ?? null }));
  return { name: album.title, artist: album.artist?.name ?? '', tracks };
}

/** Exact join from a Spotify track to Deezer. Returns null when Deezer has no such ISRC. */
export async function trackByIsrc(isrc: string): Promise<Track | null> {
  try {
    const t = await dz<DzTrack>(`/track/isrc:${encodeURIComponent(isrc)}`);
    return t.preview ? toTrack(t) : null;
  } catch {
    return null;
  }
}

/**
 * Fuzzy fallback when an ISRC misses. Plain text only: Deezer's public endpoint
 * returns 0 results for the documented `artist:"x" track:"y"` syntax.
 *
 * Returns candidates in Deezer's own order, which favours live and remix cuts —
 * the caller is responsible for ranking and for sanity-checking the match.
 */
export async function searchTracks(title: string, artist: string, limit = 25): Promise<Track[]> {
  try {
    const { data } = await dz<{ data: DzTrack[] }>(`/search?q=${encode(`${artist} ${title}`)}&limit=${limit}`);
    return data.filter((t) => t.preview).map(toTrack);
  } catch {
    return [];
  }
}
