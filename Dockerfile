FROM node:20.12.1-alpine AS building

WORKDIR /app

COPY package.json yarn.lock build-info.json .yarnrc.yml ./
COPY ./tsconfig*.json ./nest-cli.json ./.swcrc ./
COPY ./src ./src

RUN corepack enable && corepack prepare yarn@4.12.0 --activate
RUN yarn install --immutable && yarn cache clean
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
  CMD sh -c "wget -nv -t1 --spider http://127.0.0.1:$HTTP_PORT/health" || exit 1

CMD ["yarn", "start:prod"]
