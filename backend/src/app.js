"use strict";
// Express-App: Middleware (Größenlimits, Sitzung, Herkunftsprüfung), Status und Fehlerbehandlung.
// Die Endpunkte stehen nach Bereichen in routes/.
const express = require("express");
const config = require("./config");
const db = require("./db");
const users = require("./users");
const sessions = require("./sessions");
const backups = require("./backups");
const mailer = require("./mailer");
const { HttpError, wrap, publicUser } = require("./http");

let dbVersion = "unbekannt";

async function loadDbVersion() {
  try {
    const r = await db.pool.query("SHOW server_version");
    dbVersion = "PostgreSQL " + String(r.rows[0].server_version).split(" ")[0];
  } catch (e) { /* bleibt "unbekannt" */ }
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
      mailEnabled: await mailer.isConfigured(),
      sessionIdleHours: config.sessionIdleHours,
      revision: await db.getRevision(),
      user: publicUser(req.user)
    });
  }));

  ["documents", "auth", "account", "admin"].forEach((m) => require("./routes/" + m).register(app));

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
