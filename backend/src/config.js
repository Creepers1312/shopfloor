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
  // Abmeldung nach so vielen Stunden ohne Aktivität (0 = aus)
  sessionIdleHours: int(env.SESSION_IDLE_HOURS, 12, 0, 720),
  passwordMinLength: int(env.PASSWORD_MIN_LENGTH, 10, 8, 128),
  auditDays: int(env.AUDIT_DAYS, 365, 30, 3650),
  resetMinutes: int(env.RESET_LINK_MINUTES, 60, 10, 1440),
  // E-Mail-Versand für „Passwort vergessen“ (leer = aus, Anfragen gehen an die Administration)
  smtp: {
    host: String(env.SMTP_HOST || "").trim(),
    port: int(env.SMTP_PORT, 587, 1, 65535),
    security: ["starttls", "tls", "none"].includes(String(env.SMTP_SECURITY || "").toLowerCase()) ? String(env.SMTP_SECURITY).toLowerCase() : "starttls",
    user: String(env.SMTP_USER || "").trim(),
    password: String(env.SMTP_PASSWORD || ""),
    from: String(env.SMTP_FROM || "").trim()
  },
  // Erlaubte Herkunft schreibender Anfragen zusätzlich zur eigenen Adresse (z. B. https://shopfloor.trobox.de)
  publicUrl: String(env.PUBLIC_URL || "").replace(/\/+$/, ""),
  cookieSecure: bool(env.COOKIE_SECURE, false),
  // Mit HTTPS: __Host-Präfix — der Browser nimmt das Cookie dann nur über HTTPS und nur für genau diese Adresse an
  cookieName: bool(env.COOKIE_SECURE, false) ? "__Host-sfm_session" : "sfm_session",
  trustProxy: env.TRUST_PROXY || "loopback, linklocal, uniquelocal",
  bodyLimit: env.BODY_LIMIT || "25mb",      // nur für Dokumente (Board, Wiederherstellung aus Datei)
  smallBodyLimit: "32kb",                   // alle übrigen Anfragen (Anmeldung, Konten, Sicherungen …)
  backupDir: env.BACKUP_DIR || "/backups",
  backupDefaults: {
    enabled: bool(env.BACKUP_ENABLED, true),
    time: time(env.BACKUP_TIME, "02:00"),
    keep: int(env.BACKUP_KEEP, 14, 1, 365)
  },
  parseTime: time,
  parseInt: int
};
