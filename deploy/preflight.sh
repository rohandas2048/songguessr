#!/usr/bin/env bash
#
# Checks a production configuration before it goes anywhere.
#
#     ./deploy/preflight.sh https://songguessr.example.com
#
# Every failure here is one that is painful to diagnose after deployment:
# a missing session secret logs everyone out, a mismatched redirect URI
# breaks the login, and a stale build serves last week's UI.

set -euo pipefail

APP_URL="${1:-${APP_URL:-}}"
fail=0

note() { printf '  %s\n' "$1"; }
ok()   { printf 'ok    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

echo "== configuration"

if [ -z "$APP_URL" ]; then
    bad "APP_URL not given (pass it as the first argument)"
else
    case "$APP_URL" in
        https://*) ok "APP_URL is https" ;;
        *)         bad "APP_URL must be https in production: $APP_URL" ;;
    esac
fi

if [ -z "${SESSION_SECRET:-}" ]; then
    bad "SESSION_SECRET is unset — the server refuses to start in production"
    note "generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
elif [ "${#SESSION_SECRET}" -lt 32 ]; then
    bad "SESSION_SECRET is ${#SESSION_SECRET} chars; use 32 or more"
else
    ok "SESSION_SECRET is set and long enough"
fi

if [ -z "${SPOTIFY_CLIENT_ID:-}" ] || [ -z "${SPOTIFY_CLIENT_SECRET:-}" ]; then
    note "Spotify credentials unset — genre, artist, album and featured modes still work"
else
    ok "Spotify credentials present"
fi

# The session cookie is scoped by hostname, so these two must agree.
if [ -n "${SPOTIFY_REDIRECT_URI:-}" ] && [ -n "$APP_URL" ]; then
    app_host=$(printf '%s' "$APP_URL" | sed -E 's|https?://([^/:]+).*|\1|')
    cb_host=$(printf '%s' "$SPOTIFY_REDIRECT_URI" | sed -E 's|https?://([^/:]+).*|\1|')
    if [ "$app_host" = "$cb_host" ]; then
        ok "APP_URL and SPOTIFY_REDIRECT_URI share a hostname ($app_host)"
    else
        bad "hostname mismatch: APP_URL=$app_host but redirect URI=$cb_host"
        note "the session cookie will not survive the OAuth round trip"
    fi
fi

if [ "${ALLOW_PRESET_WRITES:-}" = "false" ]; then
    ok "featured-list editing is switched off"
elif [ -z "${CURATOR_PASSWORD:-}" ]; then
    ok "no CURATOR_PASSWORD — the featured list is read-only"
elif [ "${#CURATOR_PASSWORD}" -lt 16 ]; then
    bad "CURATOR_PASSWORD is ${#CURATOR_PASSWORD} chars; use 16 or more"
    note "it is the only guessable secret in the app"
else
    ok "CURATOR_PASSWORD is set and long enough"
    note "presets written at runtime do not survive a restart unless the host has a disk"
fi

if [ "${HOST:-}" = "127.0.0.1" ]; then
    note "HOST=127.0.0.1 — correct behind a proxy on the same host, wrong in a container"
fi

if [ -z "${TRUST_PROXY:-}" ]; then
    note "TRUST_PROXY unset — behind a proxy, rate limiting will key every client to one bucket"
fi

echo
echo "== build"

if [ -d dist ]; then
    ok "dist/ exists"
    if [ -n "$(find server src shared -newer dist/index.html -name '*.ts*' -print -quit 2>/dev/null)" ]; then
        bad "dist/ is older than the sources — run npm run build"
    else
        ok "dist/ is newer than the sources"
    fi
else
    bad "no dist/ — run npm run build"
fi

echo
echo "== tests"
# test/ is gitignored, so a fresh clone has no suite to run. Typecheck still applies.
if compgen -G "test/*.test.ts" >/dev/null; then
    task="npm run check"; label="typecheck and tests pass"
else
    task="npm run typecheck"; label="typecheck passes (no test/ in this checkout)"
fi
if $task >/tmp/songguessr-preflight.log 2>&1; then
    ok "$label"
else
    bad "$task failed — see /tmp/songguessr-preflight.log"
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "preflight passed"
else
    echo "preflight FAILED — fix the items above before deploying"
    exit 1
fi
