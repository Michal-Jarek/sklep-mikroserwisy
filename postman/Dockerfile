# Image of the newman runs (postman/run.sh): Node 22, newman 6.2.3 and newman-reporter-html 1.0.5 only.
# Exact Node version: the TypeScript runner needs Node >= 22.18 (type stripping without a flag); a plain
# node:22-alpine pulled long ago may be older (ERR_UNKNOWN_FILE_EXTENSION).
# The runner, collections and environments are mounted at run time, the image holds just the dependencies.
# .npmrc: legacy-peer-deps for the old peer declaration of newman-reporter-html (see the file).

FROM node:22.23-alpine AS deps
WORKDIR /opt/scenario
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.23-alpine
ENV NODE_ENV=production
WORKDIR /opt/scenario
COPY --from=deps /opt/scenario/node_modules ./node_modules
COPY package.json ./
# node = UID 1000 in the base image.
USER node
ENTRYPOINT ["node"]
