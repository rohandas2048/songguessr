const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

export class SpotifyDisabledError extends Error {
  constructor() {
    super('Spotify is not configured — set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
  }
}

export function spotifyConfigured(): boolean {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

let cached: { token: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (!spotifyConfigured()) throw new SpotifyDisabledError();
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SPOTIFY_CLIENT_ID!,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) throw new Error(`spotify token request failed (${res.status})`);

  const body = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh a minute early so an in-flight pool build can't straddle the expiry.
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

async function sp<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`spotify ${path} -> ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
  }
  return (await res.json()) as T;
}

export type SpotifyRefType = 'playlist' | 'artist' | 'album' | 'track';

export interface SpotifyRef {
  type: SpotifyRefType;
  id: string;
}

const REF_TYPES = new Set<string>(['playlist', 'artist', 'album', 'track']);

/** Accepts an open.spotify.com URL, a spotify: URI, or a bare 22-char id (with `type`). */
export function parseSpotifyRef(input: string, assume?: SpotifyRefType): SpotifyRef | null {
  const text = input.trim();

  const uri = /^spotify:(playlist|artist|album|track):([A-Za-z0-9]+)$/.exec(text);
  if (uri) return { type: uri[1] as SpotifyRefType, id: uri[2]! };

  const url = /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|artist|album|track)\/([A-Za-z0-9]+)/.exec(text);
  if (url) return { type: url[1] as SpotifyRefType, id: url[2]! };

  if (assume && REF_TYPES.has(assume) && /^[A-Za-z0-9]{22}$/.test(text)) return { type: assume, id: text };
  return null;
}

interface RawTrack {
  name: string;
  album: { name: string; images: { url: string }[] };
}

/**
 * Per-track artwork for the reveal screen. The embed payload has none, and this
 * endpoint is one of the few Spotify still serves to a new app.
 */
export async function getTrackDetail(id: string): Promise<{ album: string; artworkUrl: string | null } | null> {
  try {
    const t = await sp<RawTrack>(`/tracks/${id}`);
    return { album: t.album?.name ?? '', artworkUrl: t.album?.images?.[0]?.url ?? null };
  } catch {
    return null;
  }
}

/** Only the name is needed — the catalog itself comes from Deezer. */
export async function getArtistName(id: string): Promise<string> {
  return (await sp<{ name: string }>(`/artists/${id}`)).name;
}

export async function getAlbumName(id: string): Promise<{ name: string; artist: string }> {
  const a = await sp<{ name: string; artists: { name: string }[] }>(`/albums/${id}`);
  return { name: a.name, artist: a.artists[0]?.name ?? '' };
}

export interface UserPlaylistTrack {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  isrc: string | null;
  durationSec: number;
}

/** `/items` and `/tracks` return the same track object under different keys. */
interface PlaylistEntry {
  item?: RawPlaylistTrack | null;
  track?: RawPlaylistTrack | boolean | null;
}

interface RawPlaylistTrack {
  id: string | null;
  name: string;
  duration_ms: number;
  is_local?: boolean;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
  external_ids?: { isrc?: string };
}

/**
 * Full playlist tracklist using a logged-in user's token, with no 100-track ceiling.
 *
 * This is the only route past the embed page's cap. It is unavailable with an app-only
 * token, where `/playlists/{id}/tracks` returns 403 at every limit.
 */
export async function getPlaylistTracksAsUser(
  id: string,
  accessToken: string,
): Promise<{ name: string; tracks: UserPlaylistTrack[] }> {
  const call = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`spotify ${path} -> ${res.status}`);
    return (await res.json()) as T;
  };

  const meta = await call<{ name: string }>(`/playlists/${id}?fields=name`);
  const tracks: UserPlaylistTrack[] = [];
  // The two paths nest the track under different keys, so the field mask differs too.
  const mask = 'id,name,duration_ms,is_local,artists(name),album(name,images),external_ids';
  let limit = 50;
  let offset = 0;
  // The documented `/tracks` path now answers 403 for this app while `/items` serves the
  // same payload. Kept as a fallback in case that flips back.
  let segment = 'items';

  for (;;) {
    let page: { items: PlaylistEntry[]; next: string | null };
    const fields = `items(${segment === 'items' ? 'item' : 'track'}(${mask})),next`;
    try {
      page = await call(
        `/playlists/${id}/${segment}?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(fields)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (segment === 'items' && /40[34]/.test(message)) {
        segment = 'tracks';
        continue;
      }
      // Some apps are capped at 10 per page even though the docs allow 50.
      if (limit > 10 && /400|Invalid limit/.test(message)) {
        limit = 10;
        continue;
      }
      throw err;
    }

    for (const entry of page.items) {
      // `/items` nests under `item`; on that path `track` is a boolean flag, not the object.
      const t = entry.item ?? (typeof entry.track === 'object' ? entry.track : null);
      // Local files and podcast episodes come through as unplayable entries.
      if (!t || t.is_local || !t.id) continue;
      tracks.push({
        spotifyId: t.id,
        title: t.name,
        artist: t.artists.map((a) => a.name).join(', '),
        album: t.album?.name ?? '',
        artworkUrl: t.album?.images?.[0]?.url ?? null,
        isrc: t.external_ids?.isrc ?? null,
        durationSec: Math.round(t.duration_ms / 1000),
      });
    }

    if (!page.next || page.items.length === 0) break;
    offset += limit;
  }

  return { name: meta.name, tracks };
}

export interface PlaylistSummary {
  id: string;
  name: string;
  owner: string;
  trackCount: number;
  imageUrl: string | null;
}

/**
 * The connected user's *public* playlists, newest page first.
 *
 * `/me/playlists` requires `playlist-read-private`, which this app deliberately does not
 * request, so it falls back to `/users/{id}/playlists` — the same listing minus anything
 * private. Public-only is the boundary the rest of the app enforces anyway.
 */
export async function listMyPlaylists(accessToken: string): Promise<PlaylistSummary[]> {
  interface RawPlaylist {
    id: string;
    name: string;
    owner?: { display_name?: string };
    // Documented as `tracks`, but this endpoint currently returns the count under `items`.
    tracks?: { total?: number };
    items?: { total?: number };
    images?: { url: string }[] | null;
  }

  const call = async (path: string) => {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`spotify ${path} -> ${res.status}`);
    return (await res.json()) as { items: (RawPlaylist | null)[]; next: string | null };
  };

  const collect = async (base: string): Promise<PlaylistSummary[]> => {
    const out: PlaylistSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await call(`${base}?limit=50&offset=${offset}`);
      for (const p of page.items) {
        // Spotify occasionally returns null entries for playlists that have been deleted.
        if (!p?.id) continue;
        out.push({
          id: p.id,
          name: p.name,
          owner: p.owner?.display_name ?? '',
          trackCount: p.items?.total ?? p.tracks?.total ?? 0,
          imageUrl: p.images?.[0]?.url ?? null,
        });
      }
      if (!page.next || page.items.length === 0) break;
      offset += 50;
    }
    return out;
  };

  try {
    // Lists private playlists too, so it needs `playlist-read-private`. This app grants no
    // scopes, so it is expected to 403 — kept first in case a deployment chooses otherwise.
    const mine = await collect('/me/playlists');
    console.log(`[playlists] /me/playlists returned ${mine.length}`);
    return mine;
  } catch (err) {
    console.log(`[playlists] /me/playlists unavailable: ${err instanceof Error ? err.message : err}`);
    // Public playlists of the connected user, which is all this app can play anyway.
    const me = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!me.ok) throw new Error(`spotify /me -> ${me.status}`);
    const { id } = (await me.json()) as { id: string };
    const pub = await collect(`/users/${encodeURIComponent(id)}/playlists`);
    console.log(`[playlists] /users/${id}/playlists returned ${pub.length}`);
    return pub;
  }
}
