"use strict";
const express = require("express");
const config = require("./config");
const db = require("./db");
const users = require("./users");
const sessions = require("./sessions");
const backups = require("./backups");
const { normalizeClientHash, verifyPassword, burn } = require("./passwords");
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
  if (!req.user) throw new HttpError(401, "Bitte zuerst anmelden.");
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

// Gesamtdokument für die Oberfläche. Ohne Anmeldung gibt es nur den Zähler —
// Board, Einstellungen (inkl. SMTP-Zugang) und Konten bleiben verborgen.
async function buildDocument(q, user) {
  const revision = await db.getRevision(q);
  if (!user) return { revision, state: null, settings: null, users: [] };
  const r = await q.query("SELECT name, value FROM documents WHERE name IN ('state', 'settings')");
  const doc = { revision, state: null, settings: null, users: [] };
  r.rows.forEach((row) => { doc[row.name] = row.value; });
  doc.users = await users.listForClient(q);
  if (user.perm !== "admin") {
    // Nicht-Admins sehen keine Anmeldezeitpunkte anderer
    doc.users = doc.users.map((u) => { const c = Object.assign({}, u); delete c.lastLogin; return c; });
  }
  return doc;
}

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(express.json({ limit: config.bodyLimit }));
  app.use("/api", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use("/api", sessions.middleware);

  // Schreibende Anfragen nur als JSON — schützt zusammen mit SameSite=Lax vor CSRF
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "DELETE"].includes(req.method) && req.headers["content-length"] !== "0" &&
        req.headers["content-length"] !== undefined && !req.is("application/json")) {
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
      revision: await db.getRevision(),
      user: publicUser(req.user)
    });
  }));

  /* ---------- Dokumente ---------- */
  app.get("/api/document", wrap(async (req, res) => {
    if (req.query.since !== undefined) {
      const since = Number(req.query.since);
      const rev = await db.getRevision();
      if (!req.user || (Number.isFinite(since) && rev <= since)) return res.status(204).end();
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

    const result = await db.tx(async (c) => {
      await db.lockRevision(c);
      const cur = await c.query("SELECT revision FROM documents WHERE name = $1", [name]);
      const docRev = Number(cur.rows[0].revision);
      // Konflikt nur, wenn ein anderes Gerät genau dieses Dokument seit dem Stand des Clients geändert hat
      if (!Number.isFinite(clientRev) || docRev > clientRev) {
        return { conflict: await buildDocument(c, req.user) };
      }
      if (name === "users") {
        await users.syncFromClient(c, value);
      } else {
        await c.query("UPDATE documents SET value = $2::jsonb WHERE name = $1", [name, JSON.stringify(value)]);
      }
      return { revision: await db.bumpRevision(c, [name], req.user.name) };
    });

    if (result.conflict) {
      return res.status(409).json({ error: "Auf einem anderen Gerät wurde zwischenzeitlich gespeichert.", document: result.conflict });
    }
    res.json({ revision: result.revision });
  }));

  /* ---------- Anmeldung ---------- */
  app.post("/api/login", wrap(async (req, res) => {
    const { name, hash } = req.body || {};
    if (sessions.isLimited(req, name)) {
      throw new HttpError(429, "Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen.");
    }
    const clientHash = normalizeClientHash(hash);
    const row = clientHash ? await users.findByName(db.pool, name) : null;
    const ok = row && row.pw_hash ? await verifyPassword(clientHash, row.pw_hash) : await burn(clientHash);
    if (!ok) {
      sessions.recordFailure(req, name);
      throw new HttpError(401, "Name oder Passwort ist falsch.");
    }
    if (row.disabled) throw new HttpError(403, "Dieses Konto ist deaktiviert — bitte an die Administration wenden.");
    sessions.clearFailures(req, name);
    await db.pool.query("UPDATE users SET last_login = now() WHERE id = $1", [row.id]);
    await sessions.create(res, { userName: row.name });
    res.json({ user: publicUser(row) });
  }));

  app.post("/api/register", wrap(async (req, res) => {
    const { name, role, hash } = req.body || {};
    const clientHash = normalizeClientHash(hash);
    if (!clientHash) throw new HttpError(400, "Bitte ein Passwort angeben.");
    const row = await db.tx(async (c) => {
      await db.lockRevision(c);
      const n = await users.count(c);
      if (n > 0 && !config.allowRegister) {
        throw new HttpError(403, "Selbstregistrierung ist abgeschaltet — bitte an die Administration wenden.");
      }
      const created = await users.createUser(c, { name, role, perm: n === 0 ? "admin" : "editor", clientHash });
      await c.query("UPDATE users SET last_login = now() WHERE id = $1", [created.id]);
      await db.bumpRevision(c, ["users"], created.name);
      return created;
    });
    await sessions.create(res, { userName: row.name });
    res.json({ user: publicUser(row) });
  }));

  app.post("/api/login/demo", wrap(async (req, res) => {
    if (!config.allowDemo) throw new HttpError(403, "Der Demo-Zugang ist auf diesem Server abgeschaltet.");
    await sessions.create(res, { demo: true });
    res.json({ user: publicUser(sessions.DEMO_USER) });
  }));

  app.post("/api/logout", wrap(async (req, res) => {
    await sessions.destroy(req, res);
    res.json({ ok: true });
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

  /* ---------- Sicherungen (nur Admin) ---------- */
  app.get("/api/backups", wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ config: await backups.getConfig(), backups: await backups.list() });
  }));

  app.put("/api/backups/config", wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ config: await backups.setConfig(req.body || {}) });
  }));

  app.post("/api/backups", wrap(async (req, res) => {
    requireAdmin(req);
    const note = String((req.body || {}).note || "").slice(0, 200);
    const r = await backups.create("manual", note + (note ? " · " : "") + req.user.name);
    if (!r.ok) throw new HttpError(500, "Sicherung fehlgeschlagen: " + r.error);
    res.json({ filename: r.filename });
  }));

  app.get("/api/backups/:file/download", wrap(async (req, res) => {
    requireAdmin(req);
    const { file, exists } = await backups.resolveFile(req.params.file);
    if (!exists) throw new HttpError(404, "Datei nicht mehr vorhanden.");
    res.download(file, req.params.file);
  }));

  app.post("/api/backups/:file/restore", wrap(async (req, res) => {
    requireAdmin(req);
    await backups.restore(req.params.file, req.user.name);
    res.json({ ok: true, revision: await db.getRevision() });
  }));

  app.delete("/api/backups/:file", wrap(async (req, res) => {
    requireAdmin(req);
    await backups.remove(req.params.file);
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
