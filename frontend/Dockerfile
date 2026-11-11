# Stufe 1: Content-Security-Policy aus den Inline-Skripten von index.html berechnen
FROM node:22-alpine AS csp
WORKDIR /build
COPY csp-hashes.js index.html ./
RUN node csp-hashes.js index.html shopfloor-csp.conf

# Stufe 2: Nginx ohne Root-Rechte — läuft als Benutzer "nginx" und lauscht deshalb auf Port 8080
FROM nginxinc/nginx-unprivileged:1.31-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY shopfloor-proxy.conf /etc/nginx/shopfloor-proxy.conf
COPY --from=csp /build/shopfloor-csp.conf /etc/nginx/shopfloor-csp.conf
COPY --chmod=755 05-shopfloor-proxy.sh /docker-entrypoint.d/05-shopfloor-proxy.sh
COPY index.html /usr/share/nginx/html/index.html
COPY fonts /usr/share/nginx/html/fonts

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
