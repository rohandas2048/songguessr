import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Per-browser sessions, signed into an HttpOnly cookie.
 *
 * Written by hand rather than pulled from npm: the whole surface is one cookie and
 * one map, and a session bug here leaks one player's private Spotify playlists to
 * another. Worth being able to read the whole thing in one sitting.
 */

const COOKIE = 'sg_sid';
/** Sessions are cheap to recreate — the only cost of expiry is a re-login. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface Session {
  id: string;
  /** Spotify token for *this browser only*. Never shared between sessions. */
  token: StoredToken | null;
  /** Outstanding OAuth states, bound to this session so a callback cannot cross browsers. */
  pendingStates: Map<string, number>;
  /**
   * Whether this session ever started a login. Distinguishes "the cookie never arrived"
   * from "this state is stale or forged", which need different explanations.
   */
  issuedAnyState: boolean;
  /** Whether this browser has presented the curator password. Grants featured-list writes. */
  curator: boolean;
  lastSeen: number;
}

const sessions = new Map<string, Session>();

/**
 * The cookie is signed so a forged id cannot mint a session, which would otherwise let
 * an attacker guess their way into a session holding someone's token.
 */
function secret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set (32+ random chars) in production');
  }
  // Dev only: a per-boot secret. Restarting invalidates cookies, which is fine locally.
  ephemeralSecret ??= randomBytes(32).toString('hex');
  return ephemeralSecret;
}
let ephemeralSecret: string | null = null;

function sign(id: string): string {
  return createHmac('sha256', secret()).update(id).digest('base64url');
}

function verify(raw: string): string | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(id);
  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return id;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function sweep(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}

/** Attaches `req.session`, minting one and setting the cookie when absent. */
export function sessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  sweep();

  const raw = parseCookies(req.headers.cookie)[COOKIE];
  const id = raw ? verify(raw) : null;
  let session = id ? sessions.get(id) : undefined;

  if (!session) {
    const fresh = randomBytes(32).toString('base64url');
    session = {
      id: fresh,
      token: null,
      pendingStates: new Map(),
      issuedAnyState: false,
      curator: false,
      lastSeen: Date.now(),
    };
    sessions.set(fresh, session);
    res.cookie(COOKIE, `${fresh}.${sign(fresh)}`, {
      httpOnly: true,
      sameSite: 'lax',
      // Lax still permits the top-level GET redirect back from Spotify's callback.
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  session.lastSeen = Date.now();
  req.session = session;
  next();
}

/** Boot check, so a misconfigured production deploy dies immediately. */
export function assertSessionConfig(): void {
  secret();
}

/** Test seam: drops all sessions. */
export function resetSessions(): void {
  sessions.clear();
}

export function sessionCount(): number {
  return sessions.size;
}
