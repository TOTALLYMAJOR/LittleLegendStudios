# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --ignore-scripts

FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json tsconfig.base.json
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm --workspace @little/shared run build \
  && npm --workspace @little/api run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev --ignore-scripts --workspace @little/shared --workspace @little/api

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/api/dist apps/api/dist

EXPOSE 4000

CMD ["npm", "--workspace", "@little/api", "run", "start"]
