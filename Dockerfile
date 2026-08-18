FROM node:20.12.1-alpine AS building

WORKDIR /app

# Dependency layer: only files that can change dependency resolution.
# Source-only changes must not invalidate `yarn install`.
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable
RUN yarn install --immutable && yarn cache clean

# Build layer
COPY ./tsconfig*.json ./nest-cli.json ./.swcrc ./
COPY ./build-info.json ./
COPY ./src ./src
RUN yarn build

# Drop devDependencies from node_modules before it is copied to the runtime stage
RUN yarn workspaces focus --all --production

FROM node:20.12.1-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY --from=building --chown=node:node /app/dist ./dist
COPY --from=building --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node ./package.json ./build-info.json ./
RUN mkdir -p ./storage/ && chown -R node:node ./storage/

USER node

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD sh -c "wget -nv -t1 --spider http://127.0.0.1:$HTTP_PORT/health" || exit 1

CMD ["node", "dist/main.js"]
