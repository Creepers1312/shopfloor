"use strict";
// Konten (Administration) und das eigene Konto: Passwort, E-Mail, Dashboard-Layout
const db = require("../db");
const users = require("../users");
const sessions = require("../sessions");
const audit = require("../audit");
const { passwordProblem, fromPlain } = require("../passwords");
const { HttpError, wrap, requireUser, requireManager, guardAdminAccount, publicUser, passwordMatches } = require("../http");

function register(app) {
  // Konten verwalten: Administration und Teamleitung (die Teamleitung nicht für Administrator-Konten)
  // Konto mit Passwort anlegen
  app.post("/api/users", wrap(async (req, res) => {
    requireManager(req);
    const { name, username, email, role, perm, password } = req.body || {};
    guardAdminAccount(req, null, perm);
    const problem = passwordProblem(password, name);
    if (problem) throw new HttpError(400, problem);
    users.cleanUsername(username);
    const row = await db.tx(async (c) => {
      await db.lockRevision(c);
      const created = await users.createUser(c, { name, username, email, role, perm, clientHash: fromPlain(password) });
      await db.bumpRevision(c, ["users"], req.user.name);
      return created;
    });
    await audit.log(req, "user.create", { name: row.name, username: row.username, perm: row.perm });
    res.json({ user: publicUser(row) });
  }));

  // Anmeldename, E-Mail und Rolle eines Kontos ändern
  app.patch("/api/users", wrap(async (req, res) => {
    requireManager(req);
    const { name, username, email, role } = req.body || {};
    const target = await users.findByName(db.pool, name);
    if (target) guardAdminAccount(req, target.perm);
    const r = await db.tx(async (c) => {
      await db.lockRevision(c);
      const out = await users.updateProfile(c, name, { username, email, role });
      await db.bumpRevision(c, ["users"], req.user.name);
      return out;
    });
    const changed = ["username", "email", "role"].filter((k) => (r.before[k] || "") !== (r.after[k] || ""));
    if (changed.length) await audit.log(req, "user.update", { name: r.after.name, fields: changed });
    res.json({ user: users.toClient(r.after) });
  }));

  // Offene „Passwort vergessen“-Anfragen (wenn keine E-Mail verschickt werden konnte)
  app.get("/api/users/reset-requests", wrap(async (req, res) => {
    requireManager(req);
    const r = await db.pool.query("SELECT user_name, created_at FROM reset_requests ORDER BY created_at");
    res.json({ requests: r.rows.map((x) => ({ name: x.user_name, at: new Date(x.created_at).getTime() })) });
  }));
  app.delete("/api/users/reset-requests/:name", wrap(async (req, res) => {
    requireManager(req);
    await db.pool.query("DELETE FROM reset_requests WHERE lower(user_name) = lower($1)", [req.params.name]);
    await audit.log(req, "user.reset.dismissed", { name: req.params.name });
    res.json({ ok: true });
  }));

  // Passwort eines Kontos neu setzen — beendet alle Sitzungen dieses Kontos
  app.post("/api/users/password", wrap(async (req, res) => {
    requireManager(req);
    const { name, password } = req.body || {};
    const row = await users.findByName(db.pool, name);
    if (!row) throw new HttpError(404, "Konto nicht gefunden.");
    guardAdminAccount(req, row.perm);
    const problem = passwordProblem(password, row.name);
    if (problem) throw new HttpError(400, problem);
    await users.setPassword(db.pool, row.name, fromPlain(password));
    await db.pool.query("DELETE FROM reset_requests WHERE lower(user_name) = lower($1)", [row.name]);
    await db.pool.query("DELETE FROM password_resets WHERE lower(user_name) = lower($1)", [row.name]);
    const self = row.name.toLowerCase() === req.user.name.toLowerCase();
    const ended = await sessions.destroyForUser(row.name, self ? sessions.currentTokenHash(req) : null);
    await audit.log(req, "user.password", { name: row.name, sessionsEnded: ended });
    res.json({ ok: true, sessionsEnded: ended });
  }));

  // Eigenes Passwort ändern — altes Passwort nötig, andere Geräte werden abgemeldet
  app.post("/api/me/password", wrap(async (req, res) => {
    requireUser(req);
    if (req.user.demo) throw new HttpError(403, "Im Demo-Zugang nicht möglich.");
    const { current, password } = req.body || {};
    if (sessions.isLimited(req, req.user.name)) throw new HttpError(429, "Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen.");
    const row = await users.findByName(db.pool, req.user.name);
    if (!(await passwordMatches(row, current))) {
      sessions.recordFailure(req, req.user.name);
      await audit.log(req, "user.password.self.failed", {});
      throw new HttpError(400, "Das bisherige Passwort stimmt nicht.");
    }
    const problem = passwordProblem(password, row.name);
    if (problem) throw new HttpError(400, problem);
    if (password === current) throw new HttpError(400, "Das neue Passwort muss sich vom bisherigen unterscheiden.");
    await users.setPassword(db.pool, row.name, fromPlain(password));
    const ended = await sessions.destroyForUser(row.name, sessions.currentTokenHash(req));
    await audit.log(req, "user.password.self", { sessionsEnded: ended });
    res.json({ ok: true, sessionsEnded: ended });
  }));

  // Eigenes Konto: Anzeige von Anmeldename und E-Mail
  app.get("/api/me", wrap(async (req, res) => {
    requireUser(req);
    if (req.user.demo) return res.json({ user: publicUser(req.user), email: "" });
    const row = await users.findByName(db.pool, req.user.name);
    res.json({ user: publicUser(row), email: row ? row.email || "" : "" });
  }));

  // Eigene E-Mail ändern — mit bisherigem Passwort, damit eine fremde offene Sitzung
  // die Adresse für „Passwort vergessen“ nicht umbiegen kann
  app.post("/api/me/profile", wrap(async (req, res) => {
    requireUser(req);
    if (req.user.demo) throw new HttpError(403, "Im Demo-Zugang nicht möglich.");
    const { current, email } = req.body || {};
    if (sessions.isLimited(req, req.user.name)) throw new HttpError(429, "Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen.");
    const row = await users.findByName(db.pool, req.user.name);
    if (!(await passwordMatches(row, current))) {
      sessions.recordFailure(req, req.user.name);
      throw new HttpError(400, "Das Passwort stimmt nicht.");
    }
    const r = await db.tx(async (c) => {
      await db.lockRevision(c);
      const out = await users.updateProfile(c, row.name, { email });
      await db.bumpRevision(c, ["users"], req.user.name);
      return out;
    });
    await audit.log(req, "user.email.self", {});
    res.json({ email: r.after.email || "" });
  }));

  app.get("/api/user/dashboard", wrap(async (req, res) => {
    requireUser(req);
    if (req.user.demo) return res.json({ layout: null });
    const row = await users.findByName(db.pool, req.user.name);
    res.json({ layout: row ? row.dashboard : null });
  }));

  app.put("/api/user/dashboard", wrap(async (req, res) => {
    requireUser(req);
    if (req.user.demo) throw new HttpError(403, "Im Demo-Zugang wird kein Layout gespeichert.");
    const layout = (req.body || {}).layout;
    if (!layout || typeof layout !== "object") throw new HttpError(400, "Ungültiges Layout.");
    if (JSON.stringify(layout).length > 200000) throw new HttpError(413, "Layout zu groß.");
    await db.pool.query("UPDATE users SET dashboard = $2::jsonb WHERE lower(name) = lower($1)",
      [req.user.name, JSON.stringify(layout)]);
    res.json({ ok: true });
  }));
}

module.exports = { register };
