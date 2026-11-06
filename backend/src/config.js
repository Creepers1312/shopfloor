"use strict";
// Zentrale Konfiguration — alles kommt aus Umgebungsvariablen (.env → docker-compose.yml)

const env = process.env;

function bool(v, dflt) {
  if (v === undefined || v === null || String(v).trim() === "") return dflt;
  return /^(1|true|yes|ja|on)$/i.test(String(v).trim());
}
function int(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max ?? n, Math.max(min ?? n, n));
}
function time(v, dflt) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : dflt;
}

module.exports = {
  version: require("../package.json").version,
  port: int(env.PORT, 3000, 1, 65535),
  db: {
    host: env.DB_HOST || "db",
    port: int(env.DB_PORT, 5432, 1, 65535),
    database: env.DB_NAME || "shopfloor",
    user: env.DB_USER || "shopfloor",
    password: env.DB_PASSWORD || ""
  },
  allowRegister: bool(env.ALLOW_REGISTER, false),
  allowDemo: bool(env.ALLOW_DEMO, false),
  sessionDays: int(env.SESSION_DAYS, 14, 1, 365),
  cookieSecure: bool(env.COOKIE_SECURE, false),
  cookieName: "sfm_session",
  trustProxy: env.TRUST_PROXY || "loopback, linklocal, uniquelocal",
  bodyLimit: env.BODY_LIMIT || "25mb",
  backupDir: env.BACKUP_DIR || "/backups",
  backupDefaults: {
    enabled: bool(env.BACKUP_ENABLED, true),
    time: time(env.BACKUP_TIME, "02:00"),
    keep: int(env.BACKUP_KEEP, 14, 1, 365)
  },
  parseTime: time,
  parseInt: int
};
