"use strict";
// Sitzungen per HttpOnly-Cookie. In der Datenbank liegt nur der SHA-256 des Tokens.
const crypto = require("crypto");
const config = require("./config");
const { pool } = require("./db");

const DEMO_USER = { name: "Demo-Zugang", role: "Gast", perm: "viewer", demo: true };
// last_seen wird höchstens alle 5 Minuten geschrieben, nicht bei jeder Anfrage
const TOUCH_EVERY_MS = 5 * 60 * 1000;

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* kaputtes Cookie ignorieren */ }
  });
  return out;
}

function cookieHeader(value, maxAgeSec) {
  // Strict: das Cookie geht nie bei Anfragen mit, die von einer anderen Seite ausgelöst werden.
  // Die App ist eine einzelne Seite — beim Öffnen per Link fehlt es nur beim allerersten
  // Seitenabruf, die API-Aufrufe danach haben es wieder.
  const parts = [
    `${config.cookieName}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function currentTokenHash(req) {
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  return token ? tokenHash(token) : null;
}

async function create(res, { userName, demo }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const days = demo ? 1 : config.sessionDays;
  await pool.query(
    "INSERT INTO sessions (token_hash, user_name, demo, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    [tokenHash(token), userName || null, !!demo, days]
  );
  res.setHeader("Set-Cookie", cookieHeader(token, days * 86400));
}

async function destroy(req, res) {
  const th = currentTokenHash(req);
  if (th) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [th]);
  res.setHeader("Set-Cookie", cookieHeader("", 0));
}

// Alle Sitzungen eines Kontos beenden (z. B. nach Passwortwechsel); exceptHash bleibt bestehen
async function destroyForUser(name, exceptHash, q = pool) {
  const r = await q.query(
    "DELETE FROM sessions WHERE lower(user_name) = lower($1) AND token_hash IS DISTINCT FROM $2",
    [String(name || ""), exceptHash || null]
  );
  return r.rowCount;
}

// Hängt req.user an (oder null). Gesperrte/gelöschte Konten fallen sofort heraus.
// req.sessionExpired = true, wenn ein Cookie da war, die Sitzung aber nicht (mehr) gilt.
async function middleware(req, res, next) {
  req.user = null;
  req.sessionExpired = false;
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  if (!token) return next();
  try {
    const th = tokenHash(token);
    const idle = config.sessionIdleHours;
    const r = await pool.query(
      `SELECT s.demo, s.last_seen, u.name, u.role, u.perm, u.disabled
         FROM sessions s
         LEFT JOIN users u ON lower(u.name) = lower(s.user_name)
        WHERE s.token_hash = $1 AND s.expires_at > now()
          AND ($2::int = 0 OR s.last_seen > now() - make_interval(hours => $2::int))`,
      [th, idle]
    );
    const row = r.rows[0];
    if (row && row.demo) {
      req.user = config.allowDemo ? Object.assign({}, DEMO_USER) : null;
    } else if (row && row.name && !row.disabled) {
      req.user = { name: row.name, role: row.role, perm: row.perm, demo: false };
    }
    if (!req.user) {
      req.sessionExpired = true;
    } else if (!isBackgroundRequest(req) && Date.now() - new Date(row.last_seen).getTime() > TOUCH_EVERY_MS) {
      await pool.query("UPDATE sessions SET last_seen = now() WHERE token_hash = $1", [th]);
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Das regelmäßige Nachfragen nach Änderungen zählt nicht als Aktivität — sonst würde ein
// vergessener, offener Browser nie abgemeldet. Der TV-Modus meldet sich bewusst als aktiv.
function isBackgroundRequest(req) {
  return req.method === "GET" && req.path === "/document" && req.query.since !== undefined && req.query.tv === undefined;
}

async function purgeExpired() {
  const idle = config.sessionIdleHours;
  await pool.query(
    "DELETE FROM sessions WHERE expires_at <= now() OR ($1::int > 0 AND last_seen <= now() - make_interval(hours => $1::int))",
    [idle]
  ).catch(() => {});
}

/* ---------- Bremse gegen Passwort-Raten ----------
   Drei Zähler je 15 Minuten:
     IP + Name   10 Fehlversuche  — gezieltes Raten eines Kontos
     IP          30 Fehlversuche  — viele Namen von einem Gerät aus durchprobieren
     Name        50 Fehlversuche  — verteiltes Raten eines Kontos von vielen Geräten
   Die Client-IP kommt aus Nginx; ein vom Browser mitgeschickter X-Forwarded-For wird dort verworfen. */
const WINDOW = 15 * 60 * 1000;
const LIMITS = { pair: 10, ip: 30, name: 50 };
const buckets = { pair: new Map(), ip: new Map(), name: new Map() };

function keysFor(req, name) {
  const n = String(name || "").trim().toLowerCase();
  return { pair: req.ip + "|" + n, ip: req.ip, name: n };
}
function isLimited(req, name) {
  const k = keysFor(req, name), now = Date.now();
  return Object.keys(LIMITS).some((kind) => {
    const a = buckets[kind].get(k[kind]);
    return !!a && a.count >= LIMITS[kind] && now - a.first < WINDOW;
  });
}
function recordFailure(req, name) {
  const k = keysFor(req, name), now = Date.now();
  Object.keys(LIMITS).forEach((kind) => {
    const a = buckets[kind].get(k[kind]);
    if (!a || now - a.first >= WINDOW) buckets[kind].set(k[kind], { first: now, count: 1 });
    else a.count++;
  });
}
function clearFailures(req, name) {
  const k = keysFor(req, name);
  buckets.pair.delete(k.pair);
}
setInterval(() => {
  const now = Date.now();
  Object.values(buckets).forEach((m) => {
    for (const [k, a] of m) if (now - a.first >= WINDOW) m.delete(k);
  });
}, 60 * 1000).unref();

module.exports = {
  DEMO_USER, create, destroy, destroyForUser, currentTokenHash, middleware, purgeExpired,
  isLimited, recordFailure, clearFailures
};
