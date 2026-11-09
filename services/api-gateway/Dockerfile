# API Gateway image.

# Build: all dependencies and compiled TypeScript.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Production dependencies only.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Numeric UID:GID (1000 = node in the base image), so Kubernetes runAsNonRoot can check it without /etc/passwd.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/main.js"]
