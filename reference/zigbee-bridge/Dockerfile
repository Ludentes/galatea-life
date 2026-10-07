# syntax=docker/dockerfile:1
# The reference Zigbee bridge's image (plan 4a), built from the repository's root:
#   docker build -f reference/zigbee-bridge/Dockerfile .
# The install's compose builds it. Its context is the allow-list beside this file
# (Dockerfile.dockerignore): the workspace's manifests and the three packages the bridge needs.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@ludentes/galatea-life-zigbee-bridge..." \
 && pnpm --filter "@ludentes/galatea-life-zigbee-bridge..." build \
 && pnpm --filter @ludentes/galatea-life-zigbee-bridge deploy --legacy --prod /out \
 && rm -rf /out/src /out/test /out/tsconfig.json /out/vitest.config.ts /out/subject.json /out/Dockerfile /out/Dockerfile.dockerignore

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# The owner's account runs it (compose's `user:`), which owns the data directory; node is no root either way.
USER node
CMD ["node", "dist/main.js"]
