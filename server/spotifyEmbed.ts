import { BadInputError } from './errors.ts';

const EMBED = 'https://open.spotify.com/embed/playlist';
/** Spotify serves the embed payload only to something that looks like a browser. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export interface EmbedTrack {
  spotifyId: string;
  title: string;
  artist: string;
  durationSec: number;
  /** Spotify's own 30s preview. Present on every track observed so far. */
  previewUrl: string | null;
}

export interface EmbedPlaylist {
  name: string;
  coverUrl: string | null;
  tracks: EmbedTrack[];
}

interface RawEntry {
  uri?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
  audioPreview?: { url?: string };
}

interface RawEntity {
  name?: string;
  trackList?: RawEntry[];
  coverArt?: { sources?: { url: string; width?: number }[] };
}

/**
 * Reads the tracklist out of the public embed page.
 *
 * This is not an official API. It exists because Spotify's Web API returns 403 for
 * `/playlists/{id}/tracks` on any app created after the 2024-11-27 changes, and omits
 * `tracks` from the playlist object entirely — there is no sanctioned way for a new app
 * to read a playlist. The payload is a Next.js `__NEXT_DATA__` blob and may change
 * without notice.
 */
export async function fetchPlaylistEmbed(id: string): Promise<EmbedPlaylist> {
  const res = await fetch(`${EMBED}/${id}`, { headers: { 'User-Agent': UA } });
  if (res.status === 404) throw new BadInputError('no such playlist, or it is not public');
  if (!res.ok) throw new Error(`spotify embed -> ${res.status}`);

  const html = await res.text();
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) {
    throw new Error('could not read the embed payload — Spotify may have changed its page format');
  }

  let entity: RawEntity;
  try {
    const data = JSON.parse(match[1]!) as {
      props?: { pageProps?: { state?: { data?: { entity?: RawEntity } } } };
    };
    entity = data.props?.pageProps?.state?.data?.entity ?? {};
  } catch {
    throw new Error('embed payload was not valid JSON');
  }

  const tracks: EmbedTrack[] = [];
  for (const entry of entity.trackList ?? []) {
    const spotifyId = entry.uri?.split(':').pop();
    if (!spotifyId || !entry.title) continue;
    tracks.push({
      spotifyId,
      title: entry.title,
      artist: entry.subtitle ?? '',
      durationSec: Math.round((entry.duration ?? 0) / 1000),
      previewUrl: entry.audioPreview?.url ?? null,
    });
  }

  if (tracks.length === 0) throw new BadInputError('that playlist has no readable tracks');

  const sources = entity.coverArt?.sources ?? [];
  const cover = sources.reduce<{ url: string; width?: number } | null>(
    (best, s) => (!best || (s.width ?? 0) > (best.width ?? 0) ? s : best),
    null,
  );

  return { name: entity.name ?? 'Playlist', coverUrl: cover?.url ?? null, tracks };
}
