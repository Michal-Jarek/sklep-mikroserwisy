# Shop frontend image: the React app built by Vite, served by nginx without root (port 8080).

# Build: dependencies with the exact versions of package-lock.json, type check and production build into dist/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Runtime: only the built files and the nginx configuration (the template is filled in by the image entrypoint).
FROM nginxinc/nginx-unprivileged:1.30-alpine
# The base image ships its own index.html and 50x.html: the web root holds only the app.
USER root
RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
# Defaults for the template, so the image starts without extra variables: the DNS servers of /etc/resolv.conf for
# the resolver of /api/ and the Gateway under its Docker Compose name. In Kubernetes GATEWAY_URL must be the full
# DNS name (the nginx resolver does not use the search domains of resolv.conf).
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    GATEWAY_URL=http://api-gateway:8080
# Numeric UID (101 = nginx in the base image), so Kubernetes runAsNonRoot can check it without /etc/passwd.
USER 101
EXPOSE 8080
