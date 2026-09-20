# Two stages so the runtime image carries no build tooling and no dev dependencies.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Typechecks here, so a broken build never becomes an image. The test suite is
# not part of the repo, so it cannot run in this stage; run `npm run check` locally.
RUN npm run typecheck && npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only what the server actually reads at runtime.
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY tsconfig.json ./
COPY data ./data

# Listen on every interface: inside a container, loopback is unreachable from outside.
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Runs as the image's unprivileged user rather than root.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
