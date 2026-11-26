"use strict";
// Dashboard-Liste (Standard, öffentlich, privat) — Regeln in ../dashboards.js
const db = require("../db");
const audit = require("../audit");
const dashboards = require("../dashboards");
const { HttpError, wrap, requireUser } = require("../http");

function requireAccount(req) {
  requireUser(req);
  if (req.user.demo) throw new HttpError(403, "Im Demo-Zugang lassen sich keine Dashboards anlegen oder ändern.");
}

function register(app) {
  app.get("/api/dashboards", wrap(async (req, res) => {
    requireUser(req);
    res.json({ dashboards: await dashboards.list(db.pool, req.user) });
  }));

  app.post("/api/dashboards", wrap(async (req, res) => {
    requireAccount(req);
    const row = await dashboards.create(db.pool, req.user, req.body || {});
    if (row.visibility === "public") await audit.log(req, "dashboard.create", { name: row.name, visibility: row.visibility });
    res.json({ dashboard: dashboards.toClient(row, req.user) });
  }));

  app.put("/api/dashboards/:id", wrap(async (req, res) => {
    requireAccount(req);
    const r = await dashboards.update(db.pool, req.user, req.params.id, req.body || {});
    // Protokoll nur für Änderungen, die andere betreffen: Standard-Dashboards, öffentliche und Sichtbarkeit
    const meta = r.changed.filter((c) => c !== "widgets");
    if (r.row.visibility === "standard" || meta.length || r.before.visibility === "public") {
      await audit.log(req, "dashboard.update", { name: r.row.name, visibility: r.row.visibility, changed: r.changed });
    }
    res.json({ dashboard: dashboards.toClient(r.row, req.user) });
  }));

  app.delete("/api/dashboards/:id", wrap(async (req, res) => {
    requireAccount(req);
    const row = await dashboards.remove(db.pool, req.user, req.params.id);
    if (row.visibility === "public" || !dashboards.isOwner(row, req.user)) {
      await audit.log(req, "dashboard.delete", { name: row.name, owner: row.owner, visibility: row.visibility });
    }
    res.json({ ok: true });
  }));
}

module.exports = { register };
