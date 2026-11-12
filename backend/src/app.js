"use strict";
const express = require("express");
const config = require("./config");
const db = require("./db");
const users = require("./users");
const sessions = require("./sessions");
const backups = require("./backups");
const audit = require("./audit");
const mailer = require("./mailer");
const crypto = require("crypto");
const { verifyPassword, burn, passwordProblem, fromPlain } = require("./passwords");
const { HttpError } = users;

const DOCS = ["state", "settings", "users"];
let dbVersion = "unbekannt";

async function loadDbVersion() {
  try {
    const r = await db.pool.query("SHOW server_version");
    dbVersion = "PostgreSQL " + String(r.rows[0].server_version).split(" ")[0];
  } catch (e) { /* bleibt "unbekannt" */ }
}

// Fehler aus async-Handlern an den Fehler-Handler weiterreichen
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireUser(req) {
  if (!req.user) {
    throw new HttpError(401, req.sessionExpired ? "Sitzung abgelaufen — bitte erneut anmelden." : "Bitte zuerst anmelden.");
  }
}
function requireEdit(req) {
  requireUser(req);
  if (req.user.perm !== "admin" && req.user.perm !== "editor") {
    throw new HttpError(403, "Nur Leserechte — Änderung nicht gespeichert.");
  }
}
function requireAdmin(req) {
  requireUser(req);
  if (req.user.perm !== "admin") throw new HttpError(403, "Nur für Administratoren.");
}
function publicUser(u) {
  return u ? { name: u.name, username: u.username || "", role: u.role, perm: u.perm, demo: !!u.demo } : null;
}

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
function sha256(v) { return crypto.createHash("sha256").update(String(v)).digest("hex"); }
function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol}://${req.headers.host}`;
}

/* ---------- Einstellungen schützen ----------
   Zugangsdaten (SMTP-Passwort) werden nie gespeichert oder ausgeliefert — der Server
   versendet selbst keine E-Mails. Nicht-Admins dürfen nur ändern, was der Huddle braucht:
   die Unfallchronik (safety) und das Versandprotokoll (mail.log). Alles andere bleibt. */
function stripSecrets(v) {
  if (v && v.mail && typeof v.mail === "object") delete v.mail.authPass;
  return v;
}
function mergeSettings(stored, incoming, isAdmin) {
  const clean = stripSecrets(JSON.parse(JSON.stringify(incoming)));
  if (isAdmin) return clean;
  const base = stored && typeof stored === "object" ? stripSecrets(JSON.parse(JSON.stringify(stored))) : {};
  if (clean.safety !== undefined) base.safety = clean.safety;
  if (clean.mail && Array.isArray(clean.mail.log)) {
    base.mail = base.mail && typeof base.mail === "object" ? base.mail : {};
    base.mail.log = clean.mail.log.slice(-200);
  }
  return base;
}

// Gesamtdokument für die Oberfläche. Ohne Anmeldung gibt es nur den Zähler —
// Board, Einstellungen und Konten bleiben verborgen.
async function buildDocument(q, user) {
  const revision = await db.getRevision(q);
  if (!user) return { revision, state: null, settings: null, users: [] };
  const r = await q.query("SELECT name, value FROM documents WHERE name IN ('state', 'settings')");
  const doc = { revision, state: null, settings: null, users: [] };
  r.rows.forEach((row) => { doc[row.name] = row.value; });
  stripSecrets(doc.settings);
  doc.users = await users.listForClient(q);
  if (user.perm !== "admin") {
    // Nicht-Admins sehen keine Anmeldezeitpunkte und E-Mail-Adressen anderer
    doc.users = doc.users.map((u) => {
      const c = Object.assign({}, u);
      delete c.lastLogin;
      if (c.name.toLowerCase() !== String(user.name).toLowerCase()) delete c.email;
      return c;
    });
  }
  return doc;
}

/* ---------- Herkunftsprüfung (CSRF) ----------
   Zusätzlich zu SameSite=Strict: schreibende Anfragen aus dem Browser müssen von genau
   dieser Adresse kommen. Andere Subdomains (z. B. *.trobox.de) gelten für SameSite als
   „dieselbe Seite“ — hier nicht. Anfragen ohne Origin (curl, Skripte) brauchen trotzdem
   ein gültiges Sitzungs-Cookie. */
function originAllowed(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  let o;
  try { o = new URL(origin); } catch (e) { return false; }
  if (config.publicUrl) {
    try { if (o.origin === new URL(config.publicUrl).origin) return true; } catch (e) { /* ungültige PUBLIC_URL */ }
  }
  return o.host === String(req.headers.host || "");
}

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  // Große Anfragen nur für Dokumente; alles andere klein halten
  app.use("/api/document", express.json({ limit: config.bodyLimit }));
  app.use("/api/user/dashboard", express.json({ limit: "256kb" }));
  app.use("/api", express.json({ limit: config.smallBodyLimit }));
  app.use("/api", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use("/api", sessions.middleware);

  app.use("/api", (req, res, next) => {
    if (!["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) return next();
    if (!originAllowed(req)) return res.status(403).json({ error: "Anfrage von fremder Herkunft abgelehnt." });
    // Schreibende Anfragen nur als JSON
    if (req.headers["content-length"] !== "0" && req.headers["content-length"] !== undefined && !req.is("application/json")) {
      return res.status(415).json({ error: "Bitte als JSON senden." });
    }
    next();
  });

  /* ---------- Status ---------- */
  app.get("/api/health", wrap(async (req, res) => {
    const userCount = await users.count(db.pool);
    const tool = backups.tool();
    res.json({
      mode: "server",
      ok: true,
      version: config.version,
      db: dbVersion,
      pgDump: tool.ok,
      pgDumpInfo: tool.info,
      allowDemo: config.allowDemo,
      allowRegister: config.allowRegister || userCount === 0,
      passwordMinLength: config.passwordMinLength,
      mailEnabled: mailer.configured(),
      sessionIdleHours: config.sessionIdleHours,
      revision: await db.getRevision(),
      user: publicUser(req.user)
    });
  }));

  /* ---------- Dokumente ---------- */
  app.get("/api/document", wrap(async (req, res) => {
    if (req.query.since !== undefined) {
      if (!req.user) {
        // Abgelaufene Sitzung melden, damit die Oberfläche zur Anmeldung wechselt
        if (req.sessionExpired) return res.status(401).json({ error: "Sitzung abgelaufen — bitte erneut anmelden.", expired: true });
        return res.status(204).end();
      }
      const since = Number(req.query.since);
      const rev = await db.getRevision();
      if (Number.isFinite(since) && rev <= since) return res.status(204).end();
    }
    res.json(await buildDocument(db.pool, req.user));
  }));

  app.put("/api/document/:name", wrap(async (req, res) => {
    const name = req.params.name;
    if (!DOCS.includes(name)) throw new HttpError(404, "Unbekanntes Dokument.");
    if (name === "users") requireAdmin(req); else requireEdit(req);
    const body = req.body || {};
    const clientRev = Number(body.revision);
    const value = body.value;
    if (name !== "users" && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new HttpError(400, "Ungültige Daten.");
    }

    let changes = null;
    const result = await db.tx(async (c) => {
      await db.lockRevision(c);
      const cur = await c.query("SELECT revision, value FROM documents WHERE name = $1", [name]);
      const docRev = Number(cur.rows[0].revision);
      // Konflikt nur, wenn ein anderes Gerät genau dieses Dokument seit dem Stand des Clients geändert hat
      if (!Number.isFinite(clientRev) || docRev > clientRev) {
        return { conflict: await buildDocument(c, req.user) };
      }
      if (name === "users") {
        changes = await users.syncFromClient(c, value);
      } else {
        const toStore = name === "settings" ? mergeSettings(cur.rows[0].value, value, req.user.perm === "admin") : value;
        await c.query("UPDATE documents SET value = $2::jsonb WHERE name = $1", [name, JSON.stringify(toStore)]);
      }
      return { revision: await db.bumpRevision(c, [name], req.user.name) };
    });

    if (result.conflict) {
      return res.status(409).json({ error: "Auf einem anderen Gerät wurde zwischenzeitlich gespeichert.", document: result.conflict });
    }
    if (changes) {
      const any = Object.values(changes).some((a) => a.length);
      if (any) await audit.log(req, "users.update", changes);
    } else {
      await audit.log(req, "document.save", { doc: name });
    }
    res.json({ revision: result.revision });
  }));

  /* ---------- Anmeldung ---------- */
  app.post("/api/login", wrap(async (req, res) => {
    const { login, name, password } = req.body || {};
    // Anmeldung mit Anmeldename oder E-Mail ("name" nur noch für ältere Oberflächen)
    const nm = String(login || name || "").trim().slice(0, 200);
    if (sessions.isLimited(req, nm)) {
      await audit.log(req, "auth.login.blocked", { name: nm });
      throw new HttpError(429, "Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen.");
    }
    const clientHash = fromPlain(password);
    const row = clientHash ? await users.findByLogin(db.pool, nm) : null;
    const ok = row && row.pw_hash ? await verifyPassword(clientHash, row.pw_hash) : await burn(clientHash);
    if (!ok) {
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

  /* ---------- Konten und Passwörter ---------- */
  // Konto mit Passwort anlegen (Admin)
  app.post("/api/users", wrap(async (req, res) => {
    requireAdmin(req);
    const { name, username, email, role, perm, password } = req.body || {};
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

  // Anmeldename, E-Mail und Rolle eines Kontos ändern (Admin)
  app.patch("/api/users", wrap(async (req, res) => {
    requireAdmin(req);
    const { name, username, email, role } = req.body || {};
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
    requireAdmin(req);
    const r = await db.pool.query("SELECT user_name, created_at FROM reset_requests ORDER BY created_at");
    res.json({ requests: r.rows.map((x) => ({ name: x.user_name, at: new Date(x.created_at).getTime() })) });
  }));
  app.delete("/api/users/reset-requests/:name", wrap(async (req, res) => {
    requireAdmin(req);
    await db.pool.query("DELETE FROM reset_requests WHERE lower(user_name) = lower($1)", [req.params.name]);
    await audit.log(req, "user.reset.dismissed", { name: req.params.name });
    res.json({ ok: true });
  }));

  // Passwort eines Kontos neu setzen (Admin) — beendet alle Sitzungen dieses Kontos
  app.post("/api/users/password", wrap(async (req, res) => {
    requireAdmin(req);
    const { name, password } = req.body || {};
    const row = await users.findByName(db.pool, name);
    if (!row) throw new HttpError(404, "Konto nicht gefunden.");
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
    const curHash = fromPlain(current);
    const ok = row && row.pw_hash && curHash ? await verifyPassword(curHash, row.pw_hash) : await burn(curHash);
    if (!ok) {
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
    const curHash = fromPlain(current);
    const ok = row && row.pw_hash && curHash ? await verifyPassword(curHash, row.pw_hash) : await burn(curHash);
    if (!ok) {
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

  /* ---------- Passwort vergessen ---------- */
  app.post("/api/password/forgot", wrap(async (req, res) => {
    const login = String((req.body || {}).login || "").trim().slice(0, 200);
    if (!login) throw new HttpError(400, "Bitte Anmeldename oder E-Mail angeben.");
    // Immer dieselbe Antwort — ob es das Konto gibt, bleibt verborgen
    const answer = { ok: true, mailEnabled: mailer.configured() };
    if (resetLimited("ip:" + req.ip, 10) || resetLimited("login:" + login.toLowerCase(), 3)) {
      await audit.log(req, "user.reset.blocked", { name: login });
      return res.json(answer);
    }
    const row = await users.findByLogin(db.pool, login);
    if (!row || row.disabled) {
      await audit.log(req, "user.reset.unknown", { name: login });
      return res.json(answer);
    }
    if (mailer.configured() && row.email) {
      const token = crypto.randomBytes(32).toString("base64url");
      await db.pool.query("DELETE FROM password_resets WHERE lower(user_name) = lower($1) OR expires_at <= now()", [row.name]);
      await db.pool.query(
        "INSERT INTO password_resets (token_hash, user_name, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))",
        [sha256(token), row.name, config.resetMinutes]);
      try {
        await mailer.sendPasswordReset(row.email, row.name, `${baseUrl(req)}/#reset=${token}`, config.resetMinutes);
        await audit.log(req, "user.reset.mail", { name: row.name });
        return res.json(answer);
      } catch (err) {
        console.error("[mail] Versand fehlgeschlagen:", err.message);
        await db.pool.query("DELETE FROM password_resets WHERE token_hash = $1", [sha256(token)]);
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
      ? await db.pool.query("SELECT user_name FROM password_resets WHERE token_hash = $1 AND expires_at > now()", [sha256(token)])
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

  /* ---------- Persönliches Dashboard-Layout ---------- */
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

  /* ---------- Sicherheitsprotokoll (nur Admin) ---------- */
  app.get("/api/audit", wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ entries: await audit.list({ limit: req.query.limit, before: req.query.before, action: req.query.action }) });
  }));

  /* ---------- Sicherungen (nur Admin) ---------- */
  app.get("/api/backups", wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ config: await backups.getConfig(), backups: await backups.list() });
  }));

  app.put("/api/backups/config", wrap(async (req, res) => {
    requireAdmin(req);
    const cfg = await backups.setConfig(req.body || {});
    await audit.log(req, "backup.config", cfg);
    res.json({ config: cfg });
  }));

  app.post("/api/backups", wrap(async (req, res) => {
    requireAdmin(req);
    const note = String((req.body || {}).note || "").slice(0, 200);
    const r = await backups.create("manual", note + (note ? " · " : "") + req.user.name);
    if (!r.ok) throw new HttpError(500, "Sicherung fehlgeschlagen: " + r.error);
    await audit.log(req, "backup.create", { file: r.filename });
    res.json({ filename: r.filename });
  }));

  app.get("/api/backups/:file/download", wrap(async (req, res) => {
    requireAdmin(req);
    const { file, exists } = await backups.resolveFile(req.params.file);
    if (!exists) throw new HttpError(404, "Datei nicht mehr vorhanden.");
    await audit.log(req, "backup.download", { file: req.params.file });
    res.download(file, req.params.file);
  }));

  app.post("/api/backups/:file/restore", wrap(async (req, res) => {
    requireAdmin(req);
    await backups.restore(req.params.file, req.user.name);
    await audit.log(req, "backup.restore", { file: req.params.file });
    res.json({ ok: true, revision: await db.getRevision() });
  }));

  app.delete("/api/backups/:file", wrap(async (req, res) => {
    requireAdmin(req);
    await backups.remove(req.params.file);
    await audit.log(req, "backup.delete", { file: req.params.file });
    res.json({ ok: true });
  }));

  /* ---------- Rest ---------- */
  app.use("/api", (req, res) => res.status(404).json({ error: "Unbekannter Endpunkt." }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Daten zu groß." });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Ungültiges JSON." });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? "Interner Serverfehler." : err.message });
  });

  return app;
}

module.exports = { createApp, loadDbVersion };
