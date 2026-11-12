FROM node:22-alpine

# pg_dump/pg_restore in derselben Hauptversion wie der Datenbank-Container (postgres:17),
# smbclient für die Kopie der Sicherungen auf eine SMB-Freigabe
RUN apk add --no-cache postgresql17-client tzdata samba-client

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY assets ./assets

ENV NODE_ENV=production \
    PORT=3000 \
    BACKUP_DIR=/backups

RUN mkdir -p /backups && chown node:node /backups
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
