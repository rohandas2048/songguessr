import { randomBytes } from 'node:crypto';
import type { Session, StoredToken } from './session.ts';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/**
 * Deliberately empty: this app reads public playlists only.
 *
 * A user token is still needed — the app-only token gets 403 on the tracklist endpoint,
 * and the embed page caps at 100 tracks — but it is granted no scopes, so connecting an
 * account exposes nothing private even if the session layer were to fail. Adding
 * `playlist-read-private` here would silently widen that blast radius.
 */
const SCOPES = '';

/** An unused login attempt is dead after this long. Bounds the pending-state map. */
const STATE_TTL_MS = 10 * 60 * 1000;

export function redirectUri(): string {
  // Must match the app's registered URI exactly. Spotify rejects `localhost` over http.
  return process.env.SPOTIFY_REDIRECT_URI ?? `http://127.0.0.1:${process.env.PORT ?? 3000}/callback`;
}

function basicAuth(): string {
  const raw = `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

/**
 * Builds the authorize URL and records the state *on this session*.
 *
 * Binding state to the session is what stops login-CSRF: a state minted for one browser
 * cannot be redeemed by another, so an attacker cannot graft their Spotify account onto
 * someone else's session (or capture a victim's code into their own).
 */
export function loginUrl(session: Session): string {
  const now = Date.now();
  for (const [s, issued] of session.pendingStates) {
    if (now - issued > STATE_TTL_MS) session.pendingStates.delete(s);
  }

  const state = randomBytes(16).toString('hex');
  session.pendingStates.set(state, now);
  session.issuedAnyState = true;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    redirect_uri: redirectUri(),
    state,
  });
  // Omitted entirely rather than sent empty, which Spotify treats as a malformed request.
  if (SCOPES) params.set('scope', SCOPES);
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode(session: Session, code: string, state: string): Promise<void> {
  const issued = session.pendingStates.get(state);
  if (issued === undefined) {
    // A session that never started a login means this request arrived without the session
    // cookie — in practice the login began on a different hostname than the callback lands
    // on (`localhost` vs `127.0.0.1` — cookies ignore port, but not host).
    if (!session.issuedAnyState) {
      throw new Error(
        'the login lost its session — open the app on the same hostname as the redirect URI ' +
          `(${new URL(redirectUri()).hostname}) and try again`,
      );
    }
    throw new Error('auth state did not match — start the login again');
  }
  session.pendingStates.delete(state);
  if (Date.now() - issued > STATE_TTL_MS) throw new Error('that login attempt expired — try again');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
  });
  // The upstream body can echo credentials, so it never reaches the caller.
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);

  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  session.token = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
}

async function refresh(session: Session): Promise<void> {
  const current = session.token;
  if (!current) return;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }),
  });
  if (!res.ok) {
    // The refresh token was revoked or expired; force a fresh login.
    session.token = null;
    return;
  }

  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const next: StoredToken = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
  session.token = next;
}

/** This session's access token, refreshing if needed. Null when this browser isn't logged in. */
export async function userToken(session: Session): Promise<string | null> {
  if (!session.token) return null;
  if (Date.now() >= session.token.expiresAt) await refresh(session);
  return session.token?.accessToken ?? null;
}

export async function isConnected(session: Session): Promise<boolean> {
  return (await userToken(session)) !== null;
}

export function logout(session: Session): void {
  session.token = null;
  session.pendingStates.clear();
}
