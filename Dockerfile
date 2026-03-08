# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Eliminar devDependencies dejando solo las de producción (con bcrypt ya compilado)
RUN npm prune --production

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:18-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Copiar node_modules ya prunados (bcrypt compilado incluido) y el build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
