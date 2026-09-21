/**
 * Where this instance is reachable from a browser.
 *
 * APP_URL is the explicit answer, but pinning it by hand is the single easiest thing to
 * get wrong: a host assigns the real URL, and a stale APP_URL silently breaks the Spotify
 * login, because the session cookie is scoped by hostname and the OAuth round trip then
 * lands somewhere the cookie is not sent.
 *
 * So the platform's own answer is used when there is no explicit one. Render exports
 * RENDER_EXTERNAL_URL (https://<service>.onrender.com) into every service.
 */
export function publicOrigin(): string | null {
  const raw = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  return raw ? raw.replace(/\/$/, '') : null;
}
