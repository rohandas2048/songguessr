import { Router } from 'express';
import { exchangeCode, isConnected, loginUrl, logout, redirectUri, userToken } from '../auth.ts';
import { listMyPlaylists, spotifyConfigured } from '../spotify.ts';
import { sameOriginOnly } from '../security.ts';

export const authRouter = Router();

/** Where to send the browser after the OAuth round trip. Vite serves the UI on another port in dev. */
function appUrl(): string {
  return process.env.APP_URL ?? (process.env.NODE_ENV === 'production' ? '/' : 'http://localhost:5173');
}

authRouter.get('/api/auth/status', async (req, res) => {
  res.json({
    configured: spotifyConfigured(),
    connected: spotifyConfigured() ? await isConnected(req.session) : false,
    redirectUri: redirectUri(),
  });
});

authRouter.get('/api/auth/login', (req, res) => {
  if (!spotifyConfigured()) {
    res.status(400).json({ error: 'Spotify is not configured' });
    return;
  }
  res.redirect(loginUrl(req.session));
});

/**
 * The playlists of *this session's* account. A session that has not connected gets an
 * empty list — never another player's library.
 */
authRouter.get('/api/auth/playlists', async (req, res, next) => {
  try {
    const token = spotifyConfigured() ? await userToken(req.session) : null;
    if (!token) {
      res.json([]);
      return;
    }
    // The token carries no scopes, so this lists public playlists only — and if Spotify
    // refuses it outright, an empty picker is a better answer than a broken page.
    res.json(
      await listMyPlaylists(token).catch((err: unknown) => {
        console.warn('playlist listing unavailable:', err instanceof Error ? err.message : err);
        return [];
      }),
    );
  } catch (err) {
    next(err);
  }
});

// State-changing, so it is same-origin gated on top of the SameSite=Lax cookie.
authRouter.post('/api/auth/logout', sameOriginOnly, (req, res) => {
  logout(req.session);
  res.json({ ok: true });
});

// Registered on the Spotify app as http://127.0.0.1:3000/callback, so it lives at the root.
authRouter.get('/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) {
    res.redirect(`${appUrl()}?auth=${encodeURIComponent(error)}`);
    return;
  }
  if (!code || !state) {
    res.redirect(`${appUrl()}?auth=missing_code`);
    return;
  }
  try {
    await exchangeCode(req.session, code, state);
    res.redirect(`${appUrl()}?auth=ok`);
  } catch (err) {
    res.redirect(`${appUrl()}?auth=${encodeURIComponent(err instanceof Error ? err.message : 'failed')}`);
  }
});
