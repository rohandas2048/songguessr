# songguessr

Name the song from a tenth of a second. Wrong guesses and skips unlock more audio:
`0.1 → 0.2 → 0.5 → 1 → 2 → 4 → 8 → 15` seconds.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
```

Phase 1 (genre mode) needs no credentials or API keys.

## How it works

**Spotify can't supply the audio.** Since 2024-11-27 the Web API returns `null` for
`preview_url` on any app created after that date. And the Web Playback SDK, even with
Premium, is a remote-controlled DRM player with ~200–500ms of variable start latency —
it cannot gate a 100ms window.

So audio comes from Deezer's public API (no key required) and playback is done locally:

1. The server fetches the 30s preview MP3 and proxies it to the client
2. The client `decodeAudioData`s it **once** into an `AudioBuffer`
3. Every rung is `source.start(when, offset, duration)` against that buffer

That makes 0.1s exactly 4,410 samples, and replays instant and unlimited.

Playlist mode is different: Spotify's public **embed payload** ships a preview URL for every
track, so the audio is the exact track the playlist names, with no matching step at all.

## Spotify API limits on a new app (measured, not documented)

A client-credentials app created today is far more restricted than the docs suggest:

| Endpoint | Result |
|---|---|
| `/artists/{id}`, `/albums/{id}`, `/tracks/{id}`, `/albums/{id}/tracks` | 200 — fine |
| `search` (track, artist) | 200, but **`limit` caps at 10** and totals cap around 5 |
| `search` (playlist) | 200 with `items: [null, null, null]` |
| `/artists/{id}/top-tracks` | **403** |
| `/tracks?ids=` (batch) | **403** |
| `/artists/{id}/albums?limit=20` | **400 Invalid limit** |
| editorial playlists (`37i9…`) | **404** |
| `/playlists/{id}` | 200, but the `tracks` key is **absent entirely** |
| `/playlists/{id}/tracks` | **403** at every limit, including `limit=1` |

So Spotify cannot build a track pool, and there is no sanctioned way for a new app to read a
playlist at all. Artist and album modes use Deezer natively
(`/artist/{id}/top?limit=100` returns 100 tracks with 100% preview coverage), and a pasted
Spotify artist/album link is bridged by reading just the *name* from Spotify — which does
work — and matching it on Deezer.

## Playlist mode reads the embed payload

`open.spotify.com/embed/playlist/<id>` returns a Next.js `__NEXT_DATA__` blob containing the
full tracklist — and, for every track observed, an `audioPreview.url` pointing at a 30s MP3 on
`p.scdn.co`. Those serve 200 with `Access-Control-Allow-Origin: *`. This is the same preview
audio the Web API stopped exposing in November 2024.

**This is not an official API** and Spotify may change the page format without notice;
`server/spotifyEmbed.ts` fails with a clear message if the payload shape moves.

**The embed caps at 100 tracks.** Confirmed: Rock Classics (a ~150-track playlist) returns
exactly 100, while shorter playlists return their true length. The payload carries no total, so
an exact-100 result is flagged as possibly truncated. Routes past the cap that do *not* work:
the anonymous token in the embed payload returns 429 QUOTA_EXCEEDED on every call, and
`api-partner.spotify.com/pathfinder` requires a persisted-query hash that the embed bundle
does not expose. The one route that does is a logged-in user's token — see below.

Why it's worth it: matching Spotify tracks to Deezer by text is unreliable for non-Latin
titles. Measured on a 100-track Mandarin playlist:

| Route | Coverage |
|---|---|
| Deezer text search on title + artist | **47%** |
| Spotify ISRC → Deezer `/track/isrc:` | **100%** |
| Spotify embed `audioPreview` (what we use) | **100%**, and it is the exact track |

The embed payload has no per-track artwork and no total count, so the reveal screen hydrates
album art from `/tracks/{id}` (one request per round, and that endpoint does still work), and an
exact-100 result is flagged as possibly truncated.

## Connecting a Spotify account (optional)

Playlist mode works logged out, capped at 100 tracks. Clicking **Connect Spotify** runs the
Authorization Code flow and lifts the cap: the user token pages through the whole playlist,
and the two sources are merged — order, album metadata and ISRCs from the API, audio from the
embed's preview URLs where they reach, ISRC-joined Deezer beyond track 100.

Connecting also enables the **playlist picker** — a dropdown of your public playlists with
track counts, served by `/api/auth/playlists`. Pasting a link still works, and is still the
only way to load a playlist that isn't yours.

### Public playlists only, by design

**The OAuth grant requests no scopes at all.** A user token is needed purely to lift the
embed page's 100-track cap; it is given no permissions, so a connected account exposes
nothing private even if the session layer were to fail. Two tests fail if a scope is ever
added back.

Private playlists are refused with a clear message rather than half-supported. The embed page
serves public playlists only, and it is the gate: if a playlist is not readable there, it is
not used. That keeps one boundary rather than two, and means nothing on the server can reach
a player's private library.

### Use one hostname for the whole flow

In dev, open the app at **http://127.0.0.1:5173**, not `localhost:5173`. The session cookie
is scoped by hostname (cookies ignore port, but not host), so starting the login on
`localhost` and having Spotify return to `127.0.0.1:3000/callback` drops the cookie: the
callback lands in a fresh session and the login fails. `APP_URL` and `SPOTIFY_REDIRECT_URI`
must agree on the hostname, and the server warns at boot when they do not.

The redirect URI must match the Spotify app exactly. `http://127.0.0.1:3000/callback` is the
default; Spotify rejects `http://localhost` URIs. The refresh token is cached in
`.cache/spotify-user-token.json` (gitignored, mode 0600) so a restart doesn't need a re-login.

### Sessions and multi-user safety

Each browser gets its own session: a signed, HttpOnly, SameSite=Lax cookie (`sg_sid`)
naming an in-memory session that holds **that browser's** Spotify token and nothing else.
Two people using one instance never see each other's libraries, and the last person to log
in does not displace the first.

Tokens live in memory only, so **restarting the server means logging in again**. That is a
deliberate trade: persisting them would mean writing other people's refresh tokens to disk.

The OAuth `state` is stored on the session, which is what stops login-CSRF — a state issued
to one browser cannot be redeemed by another, so nobody can graft their Spotify account onto
someone else's session or capture a victim's code into their own.

Also in place: per-IP rate limiting (tightest on `/api/context`, which fans out to hundreds
of upstream calls), bounded `contexts`/`rounds` maps, same-origin gating on logout, preview
fetches pinned to the Spotify and Deezer CDNs, and 500s that answer with a fixed string so
upstream URLs never reach a client.

A local suite covers all of it — see [Tests](#tests).

### Two undocumented shapes on the user endpoints

Both cost real debugging time and neither matches the published docs:

- `/playlists/{id}/tracks` answers **403** for this app, while `/playlists/{id}/items` serves
  the same payload. The code tries `items` first and falls back.
- On `/items` the track object is nested under `item`, and `track` is a *boolean* flag on the
  entry. On `/me/playlists` the track count arrives as `items.total`, not `tracks.total`.
  Both keys are accepted.

## Random start

With **random start** on, a round begins somewhere other than the first note. The offset is
drawn from the span that still leaves the longest rung (15s) playable, then nudged forward to
the next *sustained* sound — a 0.15s hold, so a start never lands on an isolated tick between
phrases. Verified over 360 trials across six clips: every start left 15s playable and none was
near-silent in its first 0.1s.

Note that Spotify previews vary from ~16s to 30s. On a 16s clip there is only ~1s of room to
move, so random start is most noticeable on full 30s clips.

## Things learned the hard way

- **Deezer preview URLs are signed and expire in ~14 minutes** (`hdnea=exp=…`). Cache the
  bytes, never the URL. `server/routes/audio.ts` resolves a fresh URL at play time.
- **`api.deezer.com` sends no `Access-Control-Allow-Origin`**, so all metadata calls are
  server-side. (The preview CDN *does* send `*`, but we proxy anyway for caching and to
  keep the answer's track id out of the client's network tab.)
- **Deezer previews have 0.02–0.32s of leading silence.** (Spotify's do not — they measure
  -9 to -16 dBFS in the first 0.1s.) Untrimmed, the 0.1s rung is sometimes
  near-silent (-61 dBFS measured). `src/audio/onset.ts` trims it; keep the toggle on.
- **Deezer's documented `artist:"x" track:"y"` search syntax returns 0 results** on the
  public endpoint. Plain text search works, but ranks live and remix cuts above the studio
  original, so `pickBest` in `server/resolve.ts` penalises variant titles.
- **A hard cut at 100ms clicks.** `src/audio/engine.ts` applies a ~5ms gain ramp at each
  edge so the shortest rung is music, not a transient.

## Layout

```
shared/types.ts        Track / Round / ladder — one shape across all modes
server/deezer.ts       public API client (charts, artist/album, ISRC lookup, previews)
server/spotify.ts      client-credentials token, link parsing, artwork hydration
server/spotifyEmbed.ts playlist tracklist + preview URLs from the public embed page
server/auth.ts         Spotify OAuth: login, refresh, cached user token
server/resolve.ts      three-tier clip resolution: ISRC -> Deezer search -> iTunes
server/cache.ts        disk cache for clip bytes, TTL memo for metadata
server/store.ts        contexts and rounds; holds the answer server-side
server/routes/         context.ts, round.ts, audio.ts
src/audio/engine.ts    decode once, slice locally, enveloped playback
src/audio/onset.ts     RMS scan for first audible sample, random start selection
src/game/useGame.ts    round lifecycle
src/game/search.ts     dropdown ranking
```

## Status

- [x] Phase 1 — genre mode, full game loop, audio engine
- [x] Phase 2 — artist + album modes (Deezer-native, accepts Spotify links)
- [x] Phase 2b — playlist import via the embed payload
- [x] Phase 3 — random start point, OAuth for full-length playlists
- [ ] Phase 4 — share card, history, keyboard polish

## Featured playlists (presets)

A loaded pool can be snapshotted to `data/presets/<slug>.json` and then played by anyone,
with no Spotify connection and no 100-track cap — it becomes a tab alongside Genre, Artist
and Album.

Snapshots are durable because of how clips are stored: a Deezer clip keeps only its track id
(its preview URLs are signed and expire in ~14 minutes, so they are re-resolved at play
time), while Spotify and iTunes previews are unsigned URLs that stay valid.

### Curating the featured list

Editing the list is gated on one shared secret, `CURATOR_PASSWORD`. It is not a user
account: there is exactly one curator, whoever runs the instance.

1. Set `CURATOR_PASSWORD` in `.env` (or in the host's dashboard). **With it unset the
   featured list is read-only for everyone, in development too** — there is no code path
   that writes a preset without a password.
2. On the **Featured** tab, type it into the unlock box. The check happens once and the
   result lives on the session cookie, so the password crosses the wire a single time per
   browser. **Lock** clears it.
3. Unlocked, you get **save as featured** in the game header (load the playlist first —
   connected, if it runs past 100 tracks) and a **remove** link under each featured tile.
   Removal deletes the snapshot file, so it asks for confirmation.

Commit the resulting JSON if you want it to ship with the app. That matters on a host with
no persistent disk, such as Render's free plan: a preset saved on the running service is
gone at the next deploy or wake-up, while one committed to `data/presets/` is in the image.

What holds the gate up:

- `POST /api/presets` and `DELETE /api/presets/:slug` both require the session flag, and
  both also require `sameOriginOnly`. Reading presets is always public.
- The password is compared as a SHA-256 digest through `timingSafeEqual`, so neither its
  content nor its length leaks through timing.
- `/api/presets/unlock` is the slowest route in the app — five attempts per IP, then one
  every twenty seconds — and a wrong password clears any unlock already on that session.
- The flag is per session, so unlocking one browser unlocks nothing for anyone else.
- `ALLOW_PRESET_WRITES=false` switches the whole feature off regardless of the password.
- Slugs are restricted to letters, digits and hyphens, so neither a saved label nor a
  requested removal can escape the preset directory.

## Tests

The suite is kept out of this repository — `test/` is gitignored — so it runs on the
maintainer's machine rather than in CI:

```
npm test        # the suite
npm run check   # typecheck + suite
```

36 tests, no network: a fake Spotify is installed over `globalThis.fetch`, so the suite is
deterministic and asserts our behaviour rather than a vendor's. The isolation tests drive the
real OAuth round trip through two separate cookie jars.

It exists mainly to hold one property down — **one player must never reach another player's
Spotify account**. That was checked by mutation: reintroducing the old shared-token design
fails 6 of the 9 isolation tests, so they have teeth rather than merely passing. Coverage:
per-session tokens, cookie flags, forged cookies, OAuth state binding and replay,
session-scoped contexts and rounds, minimal OAuth scope, preset slug safety and path-traversal
refusal, the curator password gate (wrong passwords, non-string passwords, cross-origin
unlocks, brute-force throttling, per-session isolation of the unlock), cross-origin logout, security headers, rate limiting, SSRF
pinning, error sanitization, eviction, and the guess box across Mandarin, Cyrillic, Hangul,
Japanese kana and full-width Latin.

CI (`.github/workflows/ci.yml`) therefore typechecks and builds, but does not test.

## Deploying

### Render (free, the default)

`render.yaml` is a Blueprint: push the repo to GitHub, then **New → Blueprint** on
render.com and point it at the repo. It sets the build and start commands, the health
check, a generated `SESSION_SECRET`, `HOST=0.0.0.0` and `TRUST_PROXY=1`. Only the two
Spotify credentials are entered by hand, in the dashboard.

Two things to know about the free plan:

- **It sleeps after ~15 minutes idle.** Sessions, contexts and rounds are in process
  memory, so a sleep logs everyone out and strands loaded playlists. A stranded round says
  so and offers "start over"; featured playlists reload from disk instantly.
- **`APP_URL` and `SPOTIFY_REDIRECT_URI` in `render.yaml` assume the service is called
  `songguessr`**, giving `songguessr.onrender.com`. If Render assigns a different URL,
  update both — they must match each other, because the session cookie is scoped by
  hostname.

`deploy/azure.sh` remains for an always-on Azure App Service (B1) if the sleeping gets
irritating.

### Preflight

Run it before any deploy — it checks the whole production configuration, the freshness of
`dist/`, and the test suite in one pass:

```
SESSION_SECRET=… SPOTIFY_REDIRECT_URI=https://…/callback ./deploy/preflight.sh https://…
```

There is also a `Dockerfile` (multi-stage; typechecks during the build, runs as the
unprivileged `node` user, sets `HOST=0.0.0.0` because loopback is unreachable from outside a
container) and a `.github/workflows/ci.yml` that typechecks and builds on every push.
CI needs no secrets: the suite stubs every upstream call.

`GET /healthz` is a dependency-free liveness probe.

The server binds `127.0.0.1` unless `HOST` says otherwise, so a deploy is opt-in. Before
putting it on a public URL:

1. Set `SESSION_SECRET` to 32+ random bytes. The server refuses to start in production
   without it.
2. Terminate TLS in front of it. The session cookie is only marked `Secure` when
   `NODE_ENV=production`, and OAuth over plain http on a public host is not safe.
3. Set `TRUST_PROXY` so per-IP rate limiting sees the real client rather than the proxy.
4. Point `SPOTIFY_REDIRECT_URI` and `APP_URL` at the real https origin, and register that
   redirect URI on the Spotify app.

**Spotify's own limit applies regardless of any of this.** Apps start in Development Mode,
where only up to 25 users, added by email on the dashboard, can complete a login at all.
Opening it to the public needs a quota extension, which is a review Spotify often declines
for hobby projects. Self-hosting sidesteps it: each person runs their own instance with their
own Spotify app.

## Self-hosting

```
git clone <repo> && cd songguessr
npm install
cp .env.example .env     # add your own Spotify client id and secret
npm run dev              # http://localhost:5173
```

Nothing is shared with anyone else's instance: your credentials stay in your `.env`, and your
Spotify token never leaves your machine.
