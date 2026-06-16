# syntax=docker/dockerfile:1
#
# Landing-page SaaS (Next.js + MongoDB + Stripe + AWS). Fixed-domain app,
# so a real `next build` is fine (no per-user URL baking concern). All
# secrets are server-side env supplied at runtime by docker-compose.
# Only started with `--profile landing`.

FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-bookworm AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
# Copy the whole built app (incl. node_modules + .next + public + config)
# so `next start` has everything it needs without guessing file layout.
COPY --from=builder /app ./
EXPOSE 3000
CMD ["npm", "run", "start"]
