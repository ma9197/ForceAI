# ForceAI — runs the bot + dashboard as one always-on process.
# Uses the full node:22 image because better-sqlite3 compiles a native module.
FROM node:22-bookworm

WORKDIR /app

# install backend deps (cache-friendly: copy manifests first)
COPY package*.json ./
RUN npm ci

# install + build the dashboard UI
COPY ui/package*.json ui/
RUN cd ui && npm ci
COPY . .
RUN cd ui && npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3008

# data/ (SQLite, WhatsApp auth, images, stickers) MUST be a persistent volume so it
# survives redeploys. On Railway: attach a Volume in the UI mounted at /app/data.
# On a VPS with docker-compose: the ./data bind-mount handles it (see docker-compose.yml).
# NOTE: a Dockerfile `VOLUME` instruction is intentionally omitted — Railway rejects it.

CMD ["npx", "tsx", "src/index.ts"]
