import express, { type ErrorRequestHandler, type Express } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { BadInputError } from './errors.ts';
import { audioRouter } from './routes/audio.ts';
import { authRouter } from './routes/auth.ts';
import { contextRouter } from './routes/context.ts';
import { roundRouter } from './routes/round.ts';
import { rateLimit, securityHeaders } from './security.ts';
import { sessionMiddleware } from './session.ts';

/**
 * Upstream messages can carry URLs, tokens and internal paths, so a 500 answers with a
 * fixed string and only the log sees the detail. Exported so the suite tests the real one.
 */
export const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err instanceof BadInputError ? err.status : 500;
  if (status === 500) {
    console.error(err);
    res.status(500).json({ error: 'something went wrong on our end' });
    return;
  }
  res.status(status).json({ error: err instanceof Error ? err.message : 'bad request' });
};

export function createApp(): Express {
  const app = express();

  // Behind a proxy, req.ip must reflect the real client or the rate limiter keys everyone
  // onto one bucket. Opt-in, since trusting the header blindly lets clients spoof it.
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));
  app.use(sessionMiddleware);

  // Building a context fans out to hundreds of upstream calls, so it is the one route
  // worth protecting from a loop: it is both the slowest and the easiest to abuse.
  app.use('/api/context', rateLimit({ capacity: 10, refillPerSec: 0.2, name: 'context' }));
  app.use('/api/auth/login', rateLimit({ capacity: 10, refillPerSec: 0.5, name: 'login' }));
  app.use('/api', rateLimit({ capacity: 120, refillPerSec: 10, name: 'api' }));

  // Liveness for the platform's health probe: no dependencies, no side effects.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // authRouter owns /callback at the root, so it mounts outside the /api prefix.
  app.use(authRouter);
  app.use('/api', contextRouter, roundRouter, audioRouter);

  // In production the built SPA is served from the same origin; in dev, Vite proxies here.
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(`${dist}/index.html`));
  }

  app.use(onError);

  return app;
}
