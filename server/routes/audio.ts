import { Router } from 'express';
import { getCachedAudio, putCachedAudio } from '../cache.ts';
import { previewUrl } from '../deezer.ts';
import { isAllowedAudioUrl } from '../security.ts';
import { getContext, getRound } from '../store.ts';

export const audioRouter = Router();

/**
 * Serves the clip for a round by opaque token, so the answer's track id never
 * appears in a network request the player can read.
 */
audioRouter.get('/audio/:token', async (req, res, next) => {
  const round = getRound(req.params.token, req.session.id);
  const ctx = round ? getContext(round.contextId, req.session.id) : undefined;
  const clip = round && ctx ? ctx.clips.get(round.answer.id) : undefined;
  if (!round || !clip) {
    // Distinguishes the three ways this happens: the round expired or the server restarted
    // (the store is in memory), it belongs to another session, or the context lost its clip.
    console.warn(
      `[audio] 404 token=${req.params.token.slice(0, 8)} round=${Boolean(round)} ` +
        `context=${Boolean(ctx)} clip=${Boolean(clip)}`,
    );
    res.status(404).json({
      error: round ? 'that round is no longer playable' : 'that round expired — start a new one',
    });
    return;
  }

  // Deezer keys on its own track id; direct sources key on the URL itself.
  const cacheKey = clip.provider === 'deezer' ? `dz:${clip.deezerId}` : `url:${clip.url}`;

  try {
    let bytes = await getCachedAudio(cacheKey);
    if (!bytes) {
      // Deezer preview URLs are signed and expire in ~14 minutes, so they are
      // resolved at play time; direct URLs are stable and used as-is.
      const url = clip.provider === 'deezer' ? await previewUrl(clip.deezerId) : clip.url;
      if (!url) {
        console.warn(`[audio] no preview url for ${cacheKey}`);
        res.status(502).json({ error: 'no preview available for this track' });
        return;
      }
      // The URL comes from a third-party payload, so it is pinned to known CDNs
      // rather than trusted as a fetch target.
      if (!isAllowedAudioUrl(url)) {
        console.warn(`[audio] refused source ${url.slice(0, 80)}`);
        res.status(502).json({ error: 'preview source refused' });
        return;
      }
      const upstream = await fetch(url);
      if (!upstream.ok) {
        console.warn(`[audio] upstream ${upstream.status} for ${cacheKey}`);
        res.status(502).json({ error: `preview fetch failed (${upstream.status})` });
        return;
      }
      bytes = Buffer.from(await upstream.arrayBuffer());
      await putCachedAudio(cacheKey, bytes);
    }

    res.setHeader('Content-Type', clip.provider === 'deezer' ? 'audio/mpeg' : clip.mime);
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('Cache-Control', 'no-store');
    res.end(bytes);
  } catch (err) {
    next(err);
  }
});
