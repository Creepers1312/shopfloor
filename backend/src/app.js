"use strict";
const express = require("express");
const config = require("./config");
const db = require("./db");
const users = require("./users");
const sessions = require("./sessions");
const backups = require("./backups");
const audit = require("./audit");
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
  return u ? { name: u.name, role: u.role, perm: u.perm, demo: !!u.demo } : null;
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
    // Nicht-Admins sehen keine Anmeldezeitpunkte anderer
    doc.users = doc.users.map((u) => { const c = Object.assign({}, u); delete c.lastLogin; return c; });
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
    const { name, password } = req.body || {};
    const nm = String(name || "").slice(0, 80);
    if (sessions.isLimited(req, nm)) {
      await audit.log(req, "auth.login.blocked", { name: nm });
      throw new HttpError(429, "Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen.");
    }
    const clientHash = fromPlain(password);
    const row = clientHash ? await users.findByName(db.pool, nm) : null;
    const ok = row && row.pw_hash ? await verifyPassword(clientHash, row.pw_hash) : await burn(clientHash);
    if (!ok) {
      sessions.recordFailure(req, nm);
      await audit.log(req, "auth.login.failed", { name: nm });
      throw new HttpError(401, "Name oder Passwort ist falsch.");
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
    const { name, role, password } = req.body || {};
    const nm = String(name || "").slice(0, 80);
    if (sessions.isLimited(req, nm)) throw new HttpError(429, "Zu viele Versuche — bitte in 15 Minuten erneut versuchen.");
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
        const created = await users.createUser(c, { name: nm, role, perm: n === 0 ? "admin" : "editor", clientHash: fromPlain(password) });
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
    const { name, role, perm, password } = req.body || {};
    const problem = passwordProblem(password, name);
    if (problem) throw new HttpError(400, problem);
    const row = await db.tx(async (c) => {
      await db.lockRevision(c);
      const created = await users.createUser(c, { name, role, perm, clientHash: fromPlain(password) });
      await db.bumpRevision(c, ["users"], req.user.name);
      return created;
    });
    await audit.log(req, "user.create", { name: row.name, perm: row.perm });
    res.json({ user: publicUser(row) });
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
