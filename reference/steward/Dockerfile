# syntax=docker/dockerfile:1
# The reference steward's image (the install-core design, *The applier and the steward as services*),
# built from the repository's root:
#   docker build -f reference/steward/Dockerfile -t galatea-steward:local .
# One image serves both entries: `node dist/migrate-main.js` and `node dist/main.js` (the default).
# Its context is the allow-list beside this file (Dockerfile.dockerignore): the workspace's manifests
# and the packages the steward runs on; of its development dependencies in the workspace, only their
# manifests, so pnpm links them. `--filter-prod` builds only what the steward runs on.
# It needs BuildKit (Docker's default builder since 23.0), which reads that allow-list; the legacy
# builder ignores it and falls back to the repository's own `.dockerignore`, a stricter allow-list.
# The base image is pinned by digest (node:24-bookworm-slim, 2026-10-07); a new one is taken on purpose.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter-prod "@ludentes/galatea-life-steward..." \
 && pnpm --filter-prod "@ludentes/galatea-life-steward..." build \
 && pnpm --filter @ludentes/galatea-life-steward deploy --legacy --prod /out

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# The owner's account runs it (compose's `user:`), which owns its secret files; node is no root either way.
USER node
CMD ["node", "dist/main.js"]
