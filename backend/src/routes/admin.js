"use strict";
// Administration: E-Mail-Versand des Servers, Sicherheitsprotokoll, Sicherungen, SMB-Kopie
const db = require("../db");
const backups = require("../backups");
const smb = require("../smb");
const audit = require("../audit");
const mailer = require("../mailer");
const { HttpError, wrap, requireAdmin } = require("../http");

function register(app) {
  /* ---------- E-Mail-Versand des Servers ---------- */
  app.get("/api/mail/server", wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ mail: await mailer.getConfig() });
  }));

  app.put("/api/mail/server", wrap(async (req, res) => {
    requireAdmin(req);
    const r = await mailer.setConfig(req.body || {});
    if (r.changed.length) await audit.log(req, "mail.config", { changed: r.changed, host: r.config.host });
    res.json({ mail: r.config });
  }));

  // Verbindung mit den Formularwerten prüfen; optional Test-E-Mail an „to“ (Liste) senden
  app.post("/api/mail/server/test", wrap(async (req, res) => {
    requireAdmin(req);
    const body = req.body || {};
    let to = Array.isArray(body.to) ? body.to.map((x) => String(x).trim()).filter(Boolean) : [];
    if (to.length > 50) throw new HttpError(400, "Höchstens 50 Empfänger für die Test-E-Mail.");
    if (to.some((x) => !mailer.EMAIL_RE.test(x))) throw new HttpError(400, "Ungültige Empfängeradresse.");
    const result = await mailer.test(body.settings || {}, to);
    await audit.log(req, "mail.test", { ok: result.ok, to: to.length || undefined, error: result.error || undefined });
    res.json({ result });
  }));

  /* ---------- Sicherheitsprotokoll ---------- */
  app.get("/api/audit", wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ entries: await audit.list({ limit: req.query.limit, before: req.query.before, action: req.query.action }) });
  }));

  /* ---------- Sicherungen (nur Admin) ---------- */
  app.get("/api/backups", wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ config: await backups.getConfig(), backups: await backups.list(), smb: await backups.smbStatus() });
  }));

  // SMB-Freigabe: Einstellungen (Passwort wird nie ausgeliefert)
  app.put("/api/backups/smb", wrap(async (req, res) => {
    requireAdmin(req);
    const r = await smb.setConfig(req.body || {});
    if (r.changed.length) await audit.log(req, "backup.smb.config", { changed: r.changed, enabled: r.config.enabled, share: r.config.share });
    // Nach dem Einschalten gleich abgleichen, damit der Status stimmt
    if (r.config.enabled && r.changed.length) await backups.syncSmb().catch(() => {});
    res.json({ smb: await backups.smbStatus() });
  }));

  // Verbindung mit den Werten aus dem Formular prüfen, ohne zu speichern
  app.post("/api/backups/smb/test", wrap(async (req, res) => {
    requireAdmin(req);
    let result;
    try {
      result = await smb.test(req.body || {});
    } catch (e) {
      if (!(e instanceof HttpError) || e.status === 500) throw e;
      result = { ok: false, error: e.message };
    }
    await audit.log(req, "backup.smb.test", { ok: result.ok, error: result.error || undefined });
    res.json({ result });
  }));

  // Fehlende Sicherungen jetzt auf die SMB-Freigabe kopieren
  app.post("/api/backups/smb-sync", wrap(async (req, res) => {
    requireAdmin(req);
    const r = await backups.syncSmb();
    if (r.configured === false) throw new HttpError(400, "Die Kopie auf eine Freigabe ist ausgeschaltet.");
    await audit.log(req, "backup.smb", { copied: r.copied, removed: r.removed, error: r.error || undefined });
    res.json({ result: r, smb: await backups.smbStatus() });
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
    const smb = await backups.syncSmb().catch((e) => ({ ok: false, error: e.message }));
    res.json({ filename: r.filename, smb });
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
    backups.syncSmb().catch(() => {});   // Sicherung „vor Wiederherstellung“ auf die Freigabe
    res.json({ ok: true, revision: await db.getRevision() });
  }));

  app.delete("/api/backups/:file", wrap(async (req, res) => {
    requireAdmin(req);
    await backups.remove(req.params.file);
    await audit.log(req, "backup.delete", { file: req.params.file });
    res.json({ ok: true });
  }));
}

module.exports = { register };
