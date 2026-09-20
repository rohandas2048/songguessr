import type { Track } from '@shared/types.ts';
import { MemoCache } from './cache.ts';

const API = 'https://api.deezer.com';

/** Deezer has no CORS header on api.deezer.com, so every call here is server-side only. */
async function dz<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`deezer ${path} -> ${res.status}`);
  const body = (await res.json()) as T & { error?: { message: string; code: number } };
  // Deezer signals failure in a 200 body rather than a status code.
  if (body && typeof body === 'object' && 'error' in body && body.error) {
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
}

function encode(q: string): string {
  return encodeURIComponent(q.trim());
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
