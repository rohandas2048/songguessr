import { Router } from 'express';
import type { ContextRequest, ContextResponse, Track } from '@shared/types.ts';
import type { ClipSource } from '../clips.ts';
import { BadInputError } from '../errors.ts';
import {
  albumTracks,
  artistTopTracks,
  chartTracks,
  listGenres,
  searchAlbums,
  searchArtists,
} from '../deezer.ts';
import { userToken } from '../auth.ts';
import { resolveEmbedTracks, resolveMergedPlaylist } from '../resolve.ts';
import {
  getAlbumName,
  getArtistName,
  getPlaylistTracksAsUser,
  parseSpotifyRef,
  spotifyConfigured,
} from '../spotify.ts';
import { fetchPlaylistEmbed } from '../spotifyEmbed.ts';
import { listPresets, loadPreset, presetWritesAllowed, savePreset } from '../presets.ts';
import { sameOriginOnly } from '../security.ts';
import { getContext, putContext } from '../store.ts';

export const contextRouter = Router();

/** Deezer-sourced tracks are keyed by their own id, so the clip map is a direct mapping. */
function deezerClips(tracks: Track[]): Map<string, ClipSource> {
  return new Map(tracks.map((t) => [t.id, { provider: 'deezer', deezerId: t.id } as ClipSource]));
}

contextRouter.get('/genres', async (_req, res, next) => {
  try {
    res.json(await listGenres());
  } catch (err) {
    next(err);
  }
});

contextRouter.get('/config', (_req, res) => {
  res.json({ spotify: spotifyConfigured(), presetWrites: presetWritesAllowed() });
});

/** Saved playlists, playable by anyone — no Spotify connection needed. */
contextRouter.get('/presets', async (_req, res, next) => {
  try {
    res.json(await listPresets());
  } catch (err) {
    next(err);
  }
});

/**
 * Snapshots a context the caller has already built, so it can be replayed by everyone.
 * An authoring step: disabled in production, since it writes to disk.
 */
contextRouter.post('/presets', sameOriginOnly, async (req, res, next) => {
  if (!presetWritesAllowed()) {
    res.status(403).json({ error: 'saving playlists is disabled on this server' });
    return;
  }
  const { contextId, label } = req.body as { contextId?: string; label?: string };
  const ctx = contextId ? getContext(contextId, req.session.id) : undefined;
  if (!ctx) {
    res.status(404).json({ error: 'unknown context — load a playlist first' });
    return;
  }
  try {
    res.json(await savePreset(label?.trim() || ctx.label, ctx.tracks, ctx.clips, ctx.spotifyIds));
  } catch (err) {
    next(err);
  }
});

contextRouter.get('/search', async (req, res, next) => {
  const q = String(req.query.q ?? '');
  const type = String(req.query.type ?? '');
  if (!q.trim()) {
    res.json([]);
    return;
  }
  try {
    if (type === 'artist') res.json(await searchArtists(q));
    else if (type === 'album') res.json(await searchAlbums(q));
    else res.status(400).json({ error: 'type must be artist or album' });
  } catch (err) {
    next(err);
  }
});

/**
 * Resolves a Deezer entity id from either a Deezer id (from our own search UI)
 * or a pasted Spotify link, whose name we look up on Spotify and match on Deezer.
 */
async function deezerIdFor(value: string, kind: 'artist' | 'album'): Promise<string> {
  if (/^\d+$/.test(value)) return value;

  const ref = parseSpotifyRef(value);
  if (!ref || ref.type !== kind) {
    throw new BadInputError(`expected a Deezer ${kind} id or a Spotify ${kind} link`);
  }

  const query =
    kind === 'artist'
      ? await getArtistName(ref.id)
      : await (async () => {
          const a = await getAlbumName(ref.id);
          return `${a.artist} ${a.name}`;
        })();

  const hits = kind === 'artist' ? await searchArtists(query, 1) : await searchAlbums(query, 1);
  const hit = hits[0];
  if (!hit) throw new BadInputError(`"${query}" was not found on Deezer, so there is no audio for it`);
  return String(hit.id);
}

contextRouter.post('/context', async (req, res, next) => {
  const { mode, value } = req.body as ContextRequest;
  try {
    let label: string;
    let tracks: Track[];
    let clips: Map<string, ClipSource>;
    let unresolvedCount = 0;
    let spotifyIds = new Map<string, string>();
    let truncated = false;

    if (mode === 'genre') {
      const genreId = Number(value);
      const genre = (await listGenres()).find((g) => g.id === genreId);
      if (!genre) {
        res.status(404).json({ error: `unknown genre id ${value}` });
        return;
      }
      label = genre.name;
      tracks = await chartTracks(genreId);
      clips = deezerClips(tracks);
    } else if (mode === 'preset') {
      const preset = await loadPreset(value);
      label = preset.label;
      tracks = preset.tracks;
      clips = preset.clips;
      spotifyIds = preset.spotifyIds;
    } else if (mode === 'artist') {
      const result = await artistTopTracks(await deezerIdFor(value, 'artist'));
      label = result.name;
      tracks = result.tracks;
      clips = deezerClips(tracks);
    } else if (mode === 'album') {
      const result = await albumTracks(await deezerIdFor(value, 'album'));
      label = result.artist ? `${result.name} — ${result.artist}` : result.name;
      tracks = result.tracks;
      clips = deezerClips(tracks);
    } else if (mode === 'playlist') {
      const ref = parseSpotifyRef(value, 'playlist');
      if (!ref || ref.type !== 'playlist') {
        res.status(400).json({ error: 'that does not look like a Spotify playlist link' });
        return;
      }
      // The embed page is the source of truth for *whether we may read this playlist at
      // all*: it serves public playlists only. Public-only is the deliberate boundary, so
      // a playlist that fails here is refused rather than retried with a user token.
      const playlist = await fetchPlaylistEmbed(ref.id).catch(() => null);
      if (!playlist) {
        throw new BadInputError(
          'that playlist is not public — only public playlists can be used. Check the link, ' +
            'or set the playlist to public in Spotify.',
        );
      }

      // A connected token lifts the embed's 100-track cap. It carries no scopes, so it
      // reaches public playlists only, which is the same boundary enforced above.
      const token = spotifyConfigured() ? await userToken(req.session) : null;
      const full = token ? await getPlaylistTracksAsUser(ref.id, token).catch(() => null) : null;

      const pool = full
        ? await resolveMergedPlaylist(full.tracks, playlist.tracks, playlist.coverUrl)
        : await resolveEmbedTracks(playlist.tracks, playlist.coverUrl);

      label = full?.name ?? playlist.name;
      tracks = pool.tracks;
      clips = pool.clips;
      spotifyIds = pool.spotifyIds;
      unresolvedCount = pool.unresolvedCount;
      // The embed payload carries no total, so an exact-100 result is indistinguishable
      // from its page cap. Only the user-token route can rule that out.
      truncated = !full && playlist.tracks.length === 100;
    } else {
      res.status(400).json({ error: `unknown mode "${mode}"` });
      return;
    }

    if (tracks.length < 4) {
      res.status(422).json({ error: `only ${tracks.length} playable tracks — need at least 4 for a game` });
      return;
    }

    const ctx = putContext(req.session.id, label, tracks, clips, unresolvedCount, spotifyIds);
    const body: ContextResponse = {
      contextId: ctx.id,
      label: ctx.label,
      candidates: ctx.tracks,
      unresolvedCount: ctx.unresolvedCount,
      truncated,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
