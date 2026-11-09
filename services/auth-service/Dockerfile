# Auth Service image. Also used by the one-off auth-migrate container (prisma migrate deploy).

# Build: all dependencies, Prisma client (npm postinstall) and compiled TypeScript.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Production dependencies only. The Prisma CLI is a production dependency (migrate deploy)
# and downloads its engines here, because the backend network has no internet access.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
# Numeric UID:GID (1000 = node in the base image), so Kubernetes runAsNonRoot can check it without /etc/passwd.
USER 1000:1000
EXPOSE 8081
CMD ["node", "dist/main.js"]
