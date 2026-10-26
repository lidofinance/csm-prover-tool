FROM node:24.22.1-alpine AS building

WORKDIR /app

# Dependency layer: only files that can change dependency resolution.
# Source-only changes must not invalidate `yarn install`.
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable
RUN yarn install --immutable

# Build layer
COPY ./tsconfig*.json ./nest-cli.json ./.swcrc ./
COPY ./build-info.json ./
COPY ./src ./src
RUN yarn build

# Drop devDependencies from node_modules before it is copied to the runtime stage
RUN yarn workspaces focus --all --production

# Only the node binary, no npm/corepack/yarn; keep the Alpine version in sync with the building stage image
FROM alpine:3.24 AS production
RUN apk add --no-cache libstdc++ && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=building /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
ENV NODE_ENV=production

COPY --from=building --chown=node:node /app/dist ./dist
COPY --from=building --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node ./package.json ./build-info.json ./
RUN mkdir -p ./storage/ && chown -R node:node ./storage/

USER node

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD wget -nv -t1 --spider "http://127.0.0.1:${HTTP_PORT:-8080}/health" || exit 1

CMD ["node", "dist/main.js"]
