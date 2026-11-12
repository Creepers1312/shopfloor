"use strict";
// Anmeldung, Registrierung, Abmeldung und „Passwort vergessen“
const crypto = require("crypto");
const config = require("../config");
const db = require("../db");
const users = require("../users");
const sessions = require("../sessions");
const audit = require("../audit");
const mailer = require("../mailer");
const { sha256hex, passwordProblem, fromPlain } = require("../passwords");
const { HttpError, wrap, publicUser, passwordMatches } = require("../http");

/* ---------- „Passwort vergessen“ ----------
   Einmal-Links: zufälliges Token, in der Datenbank nur dessen SHA-256, gültig RESET_LINK_MINUTES.
   Antworten verraten nie, ob es ein Konto gibt. Bremse: je Anmeldename 3, je IP 10 Anfragen pro Stunde. */
const RESET_WINDOW = 60 * 60 * 1000;
const resetBuckets = new Map();
function resetLimited(key, max) {
  const now = Date.now();
  const a = resetBuckets.get(key);
  if (!a || now - a.first >= RESET_WINDOW) { resetBuckets.set(key, { first: now, count: 1 }); return false; }
  a.count++;
  return a.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of resetBuckets) if (now - a.first >= RESET_WINDOW) resetBuckets.delete(k);
}, 10 * 60 * 1000).unref();
function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol}://${req.headers.host}`;
}

function register(app) {
  app.post("/api/login", wrap(async (req, res) => {
    const { login, name, password } = req.body || {};
    // Anmeldung mit Anmeldename oder E-Mail ("name" nur noch für ältere Oberflächen)
    const nm = String(login || name || "").trim().slice(0, 200);
    if (sessions.isLimited(req, nm)) {
      await audit.log(req, "auth.login.blocked", { name: nm });
      throw new HttpError(429, "Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen.");
    }
    const row = password ? await users.findByLogin(db.pool, nm) : null;
    if (!(await passwordMatches(row, password))) {
      sessions.recordFailure(req, nm);
      await audit.log(req, "auth.login.failed", { name: nm });
      throw new HttpError(401, "Anmeldename oder Passwort ist falsch.");
    }
    if (row.disabled) {
      await audit.log(req, "auth.login.disabled", { name: row.name });
      throw new HttpError(403, "Dieses Konto ist deaktiviert — bitte an die Administration wenden.");
    }
    sessions.clearFailures(req, nm);
    await db.pool.query("UPDATE users SET last_login = now() WHERE id = $1", [row.id]);
    await sessions.create(res, { userName: row.name });
    await audit.log(req, "auth.login", { user: row.name });
    res.json({ user: publicUser(row) });
  }));

  app.post("/api/register", wrap(async (req, res) => {
    const { name, username, email, role, password } = req.body || {};
    const nm = String(name || "").slice(0, 80);
    if (sessions.isLimited(req, nm)) throw new HttpError(429, "Zu viele Versuche — bitte in 15 Minuten erneut versuchen.");
    users.cleanUsername(username);
    const problem = passwordProblem(password, nm);
    if (problem) throw new HttpError(400, problem);
    let row;
    try {
      row = await db.tx(async (c) => {
        await db.lockRevision(c);
        const n = await users.count(c);
        if (n > 0 && !config.allowRegister) {
          throw new HttpError(403, "Selbstregistrierung ist abgeschaltet — bitte an die Administration wenden.");
        }
        const created = await users.createUser(c, { name: nm, username, email, role, perm: n === 0 ? "admin" : "editor", clientHash: fromPlain(password) });
        await c.query("UPDATE users SET last_login = now() WHERE id = $1", [created.id]);
        await db.bumpRevision(c, ["users"], created.name);
        return created;
      });
    } catch (err) {
      sessions.recordFailure(req, nm);
      throw err;
    }
    await sessions.create(res, { userName: row.name });
    await audit.log(req, "auth.register", { user: row.name, perm: row.perm });
    res.json({ user: publicUser(row) });
  }));

  app.post("/api/login/demo", wrap(async (req, res) => {
    if (!config.allowDemo) throw new HttpError(403, "Der Demo-Zugang ist auf diesem Server abgeschaltet.");
    await sessions.create(res, { demo: true });
    await audit.log(req, "auth.demo", {});
    res.json({ user: publicUser(sessions.DEMO_USER) });
  }));

  app.post("/api/logout", wrap(async (req, res) => {
    if (req.user) await audit.log(req, "auth.logout", {});
    await sessions.destroy(req, res);
    res.json({ ok: true });
  }));

  app.post("/api/password/forgot", wrap(async (req, res) => {
    const login = String((req.body || {}).login || "").trim().slice(0, 200);
    if (!login) throw new HttpError(400, "Bitte Anmeldename oder E-Mail angeben.");
    // Immer dieselbe Antwort — ob es das Konto gibt, bleibt verborgen
    const mailOn = await mailer.isConfigured();
    const answer = { ok: true, mailEnabled: mailOn };
    if (resetLimited("ip:" + req.ip, 10) || resetLimited("login:" + login.toLowerCase(), 3)) {
      await audit.log(req, "user.reset.blocked", { name: login });
      return res.json(answer);
    }
    const row = await users.findByLogin(db.pool, login);
    if (!row || row.disabled) {
      await audit.log(req, "user.reset.unknown", { name: login });
      return res.json(answer);
    }
    if (mailOn && row.email) {
      const token = crypto.randomBytes(32).toString("base64url");
      await db.pool.query("DELETE FROM password_resets WHERE lower(user_name) = lower($1) OR expires_at <= now()", [row.name]);
      await db.pool.query(
        "INSERT INTO password_resets (token_hash, user_name, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))",
        [sha256hex(token), row.name, config.resetMinutes]);
      try {
        await mailer.sendPasswordReset(row.email, row.name, `${baseUrl(req)}/#reset=${token}`, config.resetMinutes);
        await audit.log(req, "user.reset.mail", { name: row.name });
        return res.json(answer);
      } catch (err) {
        console.error("[mail] Versand fehlgeschlagen:", err.message);
        await db.pool.query("DELETE FROM password_resets WHERE token_hash = $1", [sha256hex(token)]);
        // weiter unten: Anfrage an die Administration
      }
    }
    await db.pool.query(
      "INSERT INTO reset_requests (user_name, ip) VALUES ($1, $2) ON CONFLICT (user_name) DO UPDATE SET created_at = now(), ip = EXCLUDED.ip",
      [row.name, req.ip]);
    await audit.log(req, "user.reset.requested", { name: row.name });
    res.json(answer);
  }));

  app.post("/api/password/reset", wrap(async (req, res) => {
    const { token, password } = req.body || {};
    if (resetLimited("reset-ip:" + req.ip, 20)) throw new HttpError(429, "Zu viele Versuche — bitte später erneut versuchen.");
    const r = typeof token === "string" && token.length >= 20
      ? await db.pool.query("SELECT user_name FROM password_resets WHERE token_hash = $1 AND expires_at > now()", [sha256hex(token)])
      : { rows: [] };
    if (!r.rows.length) throw new HttpError(400, "Der Link ist ungültig oder abgelaufen — bitte neu anfordern.");
    const row = await users.findByName(db.pool, r.rows[0].user_name);
    if (!row || row.disabled) throw new HttpError(400, "Der Link ist ungültig oder abgelaufen — bitte neu anfordern.");
    const problem = passwordProblem(password, row.name);
    if (problem) throw new HttpError(400, problem);
    await users.setPassword(db.pool, row.name, fromPlain(password));
    await db.pool.query("DELETE FROM password_resets WHERE lower(user_name) = lower($1)", [row.name]);
    await db.pool.query("DELETE FROM reset_requests WHERE lower(user_name) = lower($1)", [row.name]);
    const ended = await sessions.destroyForUser(row.name, null);
    await audit.log(req, "user.password.reset", { name: row.name, sessionsEnded: ended });
    res.json({ ok: true, username: row.username });
  }));
}

module.exports = { register };
