import type { NextFunction, Request, Response } from 'express';

/**
 * Rejects state-changing requests that did not originate from this site.
 *
 * The SameSite=Lax session cookie already blocks cross-site POSTs in current browsers;
 * this is the belt to that pair of braces, and covers clients that omit SameSite.
 */
export function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  // Same-origin fetches from some browsers omit Origin entirely; absence is not an attack.
  if (!origin) {
    next();
    return;
  }
  const allowed = new Set<string>();
  const host = req.get('host');
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  if (process.env.APP_URL) allowed.add(process.env.APP_URL.replace(/\/$/, ''));
  // Vite's dev origin proxies to this server and is same-site in practice.
  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }

  if (!allowed.has(origin.replace(/\/$/, ''))) {
    res.status(403).json({ error: 'cross-origin request refused' });
    return;
  }
  next();
}

/** Conservative headers. No CSP on the API; the SPA is static and framed by nobody. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}

interface Bucket {
  tokens: number;
  updated: number;
}

/**
 * Per-IP token bucket. In-memory and therefore per-process, which is the right scope
 * for a single-box deploy; behind multiple replicas it would need shared state.
 */
export function rateLimit(opts: { capacity: number; refillPerSec: number; name: string }) {
  const buckets = new Map<string, Bucket>();

  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    // Bound the map: drop buckets that have been full (idle) for a while.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (now - b.updated > 60_000) buckets.delete(k);
    }

    const key = req.ip ?? 'unknown';
    const bucket = buckets.get(key) ?? { tokens: opts.capacity, updated: now };
    const elapsed = (now - bucket.updated) / 1000;
    bucket.tokens = Math.min(opts.capacity, bucket.tokens + elapsed * opts.refillPerSec);
    bucket.updated = now;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      res.setHeader('Retry-After', Math.ceil(1 / opts.refillPerSec));
      res.status(429).json({ error: 'too many requests — slow down' });
      return;
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    next();
  };
}

/**
 * Hosts we will fetch preview audio from, one entry per provider in `server/resolve.ts`.
 *
 * Adding a resolution tier without adding its CDN here makes every clip from that tier
 * fail with "preview source refused" — which is exactly how the iTunes tier broke, since
 * its previews come from Apple rather than Spotify or Deezer. `test/security.test.ts`
 * asserts a real host from each provider.
 */
const AUDIO_HOSTS = [
  // Spotify embed previews, e.g. p.scdn.co
  /(^|\.)scdn\.co$/,
  // Deezer previews, e.g. cdnt-preview.dzcdn.net, cdns-preview-a.dzcdn.net
  /(^|\.)dzcdn\.net$/,
  /(^|\.)deezer\.com$/,
  // iTunes fallback previews, e.g. audio-ssl.itunes.apple.com
  /(^|\.)itunes\.apple\.com$/,
  /(^|\.)mzstatic\.com$/,
];

export function isAllowedAudioUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return AUDIO_HOSTS.some((re) => re.test(url.hostname));
}
