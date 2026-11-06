"use strict";
// Sitzungen per HttpOnly-Cookie. In der Datenbank liegt nur der SHA-256 des Tokens.
const crypto = require("crypto");
const config = require("./config");
const { pool } = require("./db");

const DEMO_USER = { name: "Demo-Zugang", role: "Gast", perm: "viewer", demo: true };

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
  const parts = [
    `${config.cookieName}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
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
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
  res.setHeader("Set-Cookie", cookieHeader("", 0));
}

// Hängt req.user an (oder null). Gesperrte/gelöschte Konten fallen sofort heraus.
async function middleware(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  if (!token) return next();
  try {
    const r = await pool.query(
      `SELECT s.demo, u.name, u.role, u.perm, u.disabled
         FROM sessions s
         LEFT JOIN users u ON lower(u.name) = lower(s.user_name)
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash(token)]
    );
    const row = r.rows[0];
    if (row && row.demo) {
      req.user = config.allowDemo ? Object.assign({}, DEMO_USER) : null;
    } else if (row && row.name && !row.disabled) {
      req.user = { name: row.name, role: row.role, perm: row.perm, demo: false };
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function purgeExpired() {
  await pool.query("DELETE FROM sessions WHERE expires_at <= now()").catch(() => {});
}

// Einfache Bremse gegen Passwort-Raten: max. 10 Fehlversuche je IP+Name in 15 Minuten
const attempts = new Map();
const WINDOW = 15 * 60 * 1000, MAX = 10;
function limiterKey(req, name) { return req.ip + "|" + String(name || "").toLowerCase(); }
function isLimited(req, name) {
  const a = attempts.get(limiterKey(req, name));
  return !!a && a.count >= MAX && Date.now() - a.first < WINDOW;
}
function recordFailure(req, name) {
  const k = limiterKey(req, name), now = Date.now();
  const a = attempts.get(k);
  if (!a || now - a.first >= WINDOW) attempts.set(k, { first: now, count: 1 });
  else a.count++;
}
function clearFailures(req, name) { attempts.delete(limiterKey(req, name)); }
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (now - a.first >= WINDOW) attempts.delete(k);
}, 60 * 1000).unref();

module.exports = { DEMO_USER, create, destroy, middleware, purgeExpired, isLimited, recordFailure, clearFailures };
