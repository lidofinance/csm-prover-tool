FROM node:20.12.1-bookworm-slim AS building

RUN apt-get update && apt-get install -y --no-install-recommends -qq \
    curl=7.88.1-10+deb12u8 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json yarn.lock build-info.json ./
COPY ./tsconfig*.json ./nest-cli.json ./.swcrc ./
COPY ./src ./src

RUN yarn install --frozen-lockfile --non-interactive && yarn cache clean && yarn typechain
RUN yarn build

FROM building AS production

WORKDIR /app

COPY --from=building /app/dist ./dist
COPY --from=building /app/node_modules ./node_modules
COPY ./package.json ./
COPY ./build-info.json ./
RUN mkdir -p ./storage/ && chown -R node:node ./storage/

USER node

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:$HTTP_PORT/health || exit 1

CMD ["yarn", "start:prod"]
