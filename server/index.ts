// Must precede every other import: it populates process.env for the modules below.
import './env.ts';

import { createApp } from './app.ts';
import { publicOrigin } from './publicUrl.ts';
import { assertSessionConfig } from './session.ts';
import { redirectUri } from './auth.ts';

// Fail at boot rather than serving 500s: a production deploy without a stable
// SESSION_SECRET would log everyone out on every restart.
assertSessionConfig();

// The session cookie is scoped by hostname, so a login started on one host and returned to
// another loses it. Cheap to misconfigure, confusing to debug, so it is checked at boot.
const origin = publicOrigin();
const appHost = origin ? new URL(origin).hostname : null;
const callbackHost = new URL(redirectUri()).hostname;
if (appHost && appHost !== callbackHost) {
  console.warn(
    `warning: APP_URL host (${appHost}) differs from the redirect URI host (${callbackHost}).\n` +
      '         The session cookie will not survive the OAuth round trip. Use one hostname for both.',
  );
}

const port = Number(process.env.PORT ?? 3000);
// Loopback by default. A deploy must opt in explicitly, and should still sit behind a
// TLS-terminating proxy — the session cookie is only marked Secure in production.
const host = process.env.HOST ?? '127.0.0.1';

createApp().listen(port, host, () => console.log(`api listening on http://${host}:${port}`));
