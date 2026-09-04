FROM docker.m.daocloud.io/library/node:20-bookworm-slim AS base
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=sleep-backend-pnpm,target=/pnpm/store \
  PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma \
  pnpm install --frozen-lockfile --store-dir=/pnpm/store

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
RUN PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma \
  pnpm exec prisma generate
RUN pnpm run build
RUN test -f dist/src/main.js
RUN --mount=type=cache,id=sleep-backend-pnpm,target=/pnpm/store \
  pnpm --config.store-dir=/pnpm/store prune --prod

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm \
  /usr/local/bin/npm \
  /usr/local/bin/npx
RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 --gid 1001 --no-create-home nestjs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

USER nestjs

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
