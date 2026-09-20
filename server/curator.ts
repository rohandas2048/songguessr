import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * The curator password: the one credential that separates a player from someone who can
 * change what everybody else sees.
 *
 * Deliberately not a user account. There is exactly one curator — whoever runs the
 * instance — so a shared secret in the environment is the whole model. It is checked
 * once and the result lives on the session, so the password crosses the wire a single
 * time per browser rather than on every write.
 */

const MIN_LENGTH = 12;

export function curatorConfigured(): boolean {
  return (process.env.CURATOR_PASSWORD ?? '').length > 0;
}

/**
 * Constant-time compare of the SHA-256 digests rather than the strings themselves:
 * equal-length inputs are required by timingSafeEqual, and hashing first stops the
 * comparison from revealing the password's length through an early throw.
 */
export function checkCuratorPassword(supplied: string): boolean {
  const expected = process.env.CURATOR_PASSWORD ?? '';
  if (!expected) return false;
  const a = createHash('sha256').update(supplied, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Boot warning: a short password is brute-forceable despite the rate limit. */
export function warnWeakCuratorPassword(): void {
  const pw = process.env.CURATOR_PASSWORD ?? '';
  if (pw && pw.length < MIN_LENGTH) {
    console.warn(
      `warning: CURATOR_PASSWORD is ${pw.length} characters. Use ${MIN_LENGTH}+ — it is the only\n` +
        '         thing standing between a visitor and the featured list.',
    );
  }
}

/** Gate for every route that changes the featured list. */
export function requireCurator(req: Request, res: Response, next: NextFunction): void {
  if (!curatorConfigured()) {
    res.status(403).json({ error: 'no curator password is set on this server, so the featured list is read-only' });
    return;
  }
  if (!req.session.curator) {
    res.status(401).json({ error: 'unlock with the curator password first' });
    return;
  }
  next();
}
