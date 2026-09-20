#!/usr/bin/env bash
#
# Deploy songguessr to Azure App Service.
#
# Run it from the project root:
#
#     SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
#     ./deploy/azure.sh
#
# The first run creates everything and takes a few minutes. Later runs only
# upload the code. Requires the Azure CLI and a completed `az login`.
#
# Spotify credentials are optional: without them, genre, artist, album and
# featured modes still work, and playlist mode is disabled.

set -euo pipefail

# Becomes <APP_NAME>.azurewebsites.net, so it has to be unique across Azure.
APP_NAME="${APP_NAME:-songguessr}"

RESOURCE_GROUP="${RESOURCE_GROUP:-songguessr-rg}"
PLAN_NAME="${PLAN_NAME:-songguessr-plan}"
LOCATION="${LOCATION:-westus2}"

# B1 is the cheapest tier with Always On, which keeps the process resident.
# That matters more here than usual: sessions, contexts and rounds are all in
# memory, so an unloaded process logs everyone out.
SKU="${SKU:-B1}"
RUNTIME="${RUNTIME:-NODE:22-lts}"

URL="https://${APP_NAME}.azurewebsites.net"
REDIRECT_URI="${SPOTIFY_REDIRECT_URI:-$URL/callback}"

if [ -z "${SESSION_SECRET:-}" ]; then
    echo "SESSION_SECRET is required. Generate one with:" >&2
    echo "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"" >&2
    exit 1
fi

echo "==> Preflight"
APP_URL="$URL" SPOTIFY_REDIRECT_URI="$REDIRECT_URI" ./deploy/preflight.sh "$URL"

echo "==> Resource group: $RESOURCE_GROUP ($LOCATION)"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> App Service plan: $PLAN_NAME ($SKU, Linux)"
az appservice plan create \
    --name "$PLAN_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku "$SKU" \
    --is-linux \
    --output none

echo "==> Web app: $APP_NAME"
if ! az webapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null; then
    az webapp create \
        --name "$APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --plan "$PLAN_NAME" \
        --runtime "$RUNTIME" \
        --output none
fi

echo "==> Settings"
#   always-on     keeps the process resident, so in-memory sessions survive an idle hour
#   startup-file  npm start, which sets NODE_ENV=production itself
az webapp config set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --always-on true \
    --startup-file "npm start" \
    --output none

# Sessions, contexts and rounds live in one process's memory. A second instance
# would log people out at random and 404 their rounds, so the plan stays at one.
az appservice plan update \
    --name "$PLAN_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --number-of-workers 1 \
    --output none

# HTTPS only: the session cookie is marked Secure in production, so it would
# not be sent over plain http at all.
az webapp update \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --https-only true \
    --output none

echo "==> App settings"
#
# NODE_ENV is deliberately NOT set here. As a build-time setting it would make
# npm skip devDependencies, and the server-side build needs tsc and vite.
# `npm start` sets it at runtime instead.
#
#   HOST          0.0.0.0, because App Service reaches the app over the network
#   TRUST_PROXY   1, so per-IP rate limiting sees the client, not the front end
#
settings=(
    "SESSION_SECRET=$SESSION_SECRET"
    "APP_URL=$URL"
    "SPOTIFY_REDIRECT_URI=$REDIRECT_URI"
    "HOST=0.0.0.0"
    "TRUST_PROXY=1"
    "SCM_DO_BUILD_DURING_DEPLOYMENT=true"
)
# Optional: without it the featured list is read-only on the deployed instance.
if [ -n "${CURATOR_PASSWORD:-}" ]; then
    settings+=("CURATOR_PASSWORD=$CURATOR_PASSWORD")
fi
if [ -n "${SPOTIFY_CLIENT_ID:-}" ] && [ -n "${SPOTIFY_CLIENT_SECRET:-}" ]; then
    settings+=("SPOTIFY_CLIENT_ID=$SPOTIFY_CLIENT_ID" "SPOTIFY_CLIENT_SECRET=$SPOTIFY_CLIENT_SECRET")
else
    echo "    (no Spotify credentials given — playlist mode will be disabled)"
fi

az webapp config appsettings set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --settings "${settings[@]}" \
    --output none

echo "==> Health probe"
az webapp config set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --generic-configurations '{"healthCheckPath": "/healthz"}' \
    --output none

echo "==> Packaging"
# node_modules is left out on purpose: esbuild (under tsx) ships platform-specific
# binaries, so it must be installed on the server rather than uploaded from a Mac.
# data/ carries the saved playlists; dist/ is rebuilt server-side but shipping it
# means the site is correct even if that build is skipped.
ZIP="$(mktemp -d)/app.zip"
zip -qr "$ZIP" \
    package.json package-lock.json tsconfig.json \
    server shared data dist \
    -x '*.DS_Store' '*/.*'

echo "==> Uploading $(du -h "$ZIP" | cut -f1)"
az webapp deploy \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --src-path "$ZIP" \
    --type zip \
    --output none

rm -f "$ZIP"

echo
echo "Deployed:  $URL"
echo "Health:    $URL/healthz"
echo
echo "Register this exact redirect URI on the Spotify app:"
echo "    $REDIRECT_URI"
echo
echo "Logs:      az webapp log tail --name $APP_NAME --resource-group $RESOURCE_GROUP"
