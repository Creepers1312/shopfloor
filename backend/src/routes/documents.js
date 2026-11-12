"use strict";
// Gesamtdokumente (Board, Einstellungen, Kontenliste) — Lesen und Speichern mit Konfliktprüfung
const db = require("../db");
const users = require("../users");
const audit = require("../audit");
const { HttpError, wrap, requireManager, requireEdit } = require("../http");

const DOCS = ["state", "settings", "users"];

/* ---------- Einstellungen schützen ----------
   Zugangsdaten (SMTP-Passwort) werden nie gespeichert oder ausgeliefert — der Server
   speichert das SMTP-Passwort getrennt (E-Mail-Versand). Was gespeichert werden darf, hängt an der Berechtigung:
   Administration alles; Teamleitung alles außer dem E-Mail-Versand (mail, bis auf das Protokoll);
   Bearbeiten nur, was der Huddle braucht: Unfallchronik (safety) und Versandprotokoll (mail.log). */
function stripSecrets(v) {
  if (v && v.mail && typeof v.mail === "object") delete v.mail.authPass;
  return v;
}
function mergeSettings(stored, incoming, perm) {
  const clean = stripSecrets(JSON.parse(JSON.stringify(incoming)));
  if (perm === "admin") return clean;
  const base = stored && typeof stored === "object" ? stripSecrets(JSON.parse(JSON.stringify(stored))) : {};
  if (perm === "manager") {
    Object.keys(clean).forEach((k) => { if (k !== "mail") base[k] = clean[k]; });
  } else if (clean.safety !== undefined) {
    base.safety = clean.safety;
  }
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
  if (user.perm !== "admin" && user.perm !== "manager") {
    // Nur Administration und Teamleitung sehen Anmeldezeitpunkte und E-Mail-Adressen anderer
    doc.users = doc.users.map((u) => {
      const c = Object.assign({}, u);
      delete c.lastLogin;
      if (c.name.toLowerCase() !== String(user.name).toLowerCase()) delete c.email;
      return c;
    });
  }
  return doc;
}

function register(app) {
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
    if (name === "users") requireManager(req); else requireEdit(req);
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
        changes = await users.syncFromClient(c, value, req.user.perm);
      } else {
        const toStore = name === "settings" ? mergeSettings(cur.rows[0].value, value, req.user.perm) : value;
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
}

module.exports = { register };
