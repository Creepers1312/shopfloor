"use strict";
// Konten liegen in einer eigenen Tabelle. Die Oberfläche sieht sie als Liste
// (Dokument "users") — ohne Passwort-Hashes. Speichert ein Admin die Liste,
// wird sie hier mit der Tabelle abgeglichen (Name, Rolle, Recht, Sperre, Reihenfolge).
// Passwörter werden darüber nie gesetzt — nur über POST /api/users bzw. /api/users/password.
const { hashPassword } = require("./passwords");

const PERMS = ["admin", "editor", "viewer"];
const KNOWN = new Set(["name", "role", "perm", "disabled", "hash", "lastLogin"]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanName(v) {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
  if (name.length > 80) throw new HttpError(400, "Der Name ist zu lang (max. 80 Zeichen).");
  return name;
}
function cleanRole(v) {
  return (typeof v === "string" ? v.trim() : "").slice(0, 80);
}
function cleanPerm(v) {
  return PERMS.includes(v) ? v : "editor";
}

function toClient(row) {
  const u = Object.assign({}, row.extra || {}, {
    name: row.name,
    role: row.role,
    perm: row.perm
  });
  if (row.disabled) u.disabled = true;
  if (row.last_login) u.lastLogin = new Date(row.last_login).getTime();
  return u;
}

async function listForClient(q) {
  const r = await q.query("SELECT * FROM users ORDER BY position, id");
  return r.rows.map(toClient);
}

async function findByName(q, name) {
  const r = await q.query("SELECT * FROM users WHERE lower(name) = lower($1)", [String(name || "").trim()]);
  return r.rows[0] || null;
}

async function count(q) {
  const r = await q.query("SELECT count(*)::int AS n FROM users");
  return r.rows[0].n;
}

async function createUser(q, { name, role, perm, clientHash }) {
  name = cleanName(name);
  if (await findByName(q, name)) throw new HttpError(409, "Dieser Name ist bereits vergeben — bitte melden Sie sich an.");
  const pos = await q.query("SELECT coalesce(max(position), -1) + 1 AS p FROM users");
  const pw = clientHash ? await hashPassword(clientHash) : null;
  const r = await q.query(
    "INSERT INTO users (name, role, perm, pw_hash, position) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [name, cleanRole(role), cleanPerm(perm), pw, pos.rows[0].p]
  );
  return r.rows[0];
}

async function setPassword(q, name, clientHash) {
  const r = await q.query("UPDATE users SET pw_hash = $2 WHERE lower(name) = lower($1) RETURNING *",
    [name, await hashPassword(clientHash)]);
  return r.rows[0] || null;
}

// Gleicht die vom Admin gespeicherte Liste mit der Tabelle ab
async function syncFromClient(q, list) {
  if (!Array.isArray(list)) throw new HttpError(400, "Ungültige Benutzerliste.");
  if (list.length > 1000) throw new HttpError(400, "Zu viele Benutzerkonten.");

  const seen = new Set();
  const incoming = list.map((u, idx) => {
    if (!u || typeof u !== "object") throw new HttpError(400, "Ungültiger Eintrag in der Benutzerliste.");
    const name = cleanName(u.name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, `Der Name „${name}“ kommt doppelt vor.`);
    seen.add(key);
    const extra = {};
    Object.keys(u).forEach((k) => { if (!KNOWN.has(k) && k !== "password") extra[k] = u[k]; });
    if (JSON.stringify(extra).length > 4000) throw new HttpError(400, `Zu viele Zusatzdaten für „${name}“.`);
    return { name, key, role: cleanRole(u.role), perm: cleanPerm(u.perm), disabled: !!u.disabled, extra, position: idx };
  });

  if (!incoming.some((u) => u.perm === "admin" && !u.disabled)) {
    throw new HttpError(400, "Mindestens ein aktiver Administrator muss erhalten bleiben.");
  }

  const existing = await q.query("SELECT id, name, lower(name) AS key, perm, disabled FROM users");
  const byKey = new Map(existing.rows.map((r) => [r.key, r]));
  // Änderungen fürs Sicherheitsprotokoll
  const changes = { created: [], removed: [], perm: [], disabled: [], enabled: [] };

  for (const u of incoming) {
    const old = byKey.get(u.key);
    if (old) {
      await q.query(
        `UPDATE users SET name = $2, role = $3, perm = $4, disabled = $5, extra = $6::jsonb, position = $7
          WHERE id = $1`,
        [old.id, u.name, u.role, u.perm, u.disabled, JSON.stringify(u.extra), u.position]
      );
      if (old.perm !== u.perm) changes.perm.push({ name: u.name, from: old.perm, to: u.perm });
      if (!old.disabled && u.disabled) changes.disabled.push(u.name);
      if (old.disabled && !u.disabled) changes.enabled.push(u.name);
    } else {
      // Ohne Passwort angelegt — kann sich erst anmelden, wenn ein Admin eines setzt
      await q.query(
        `INSERT INTO users (name, role, perm, disabled, extra, position)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [u.name, u.role, u.perm, u.disabled, JSON.stringify(u.extra), u.position]
      );
      changes.created.push(u.name);
    }
  }

  const removed = existing.rows.filter((r) => !seen.has(r.key)).map((r) => r.id);
  if (removed.length) {
    const del = await q.query("DELETE FROM users WHERE id = ANY($1::int[]) RETURNING name", [removed]);
    await q.query("DELETE FROM sessions WHERE lower(user_name) = ANY($1::text[])",
      [del.rows.map((r) => r.name.toLowerCase())]);
    changes.removed = del.rows.map((r) => r.name);
  }
  // Gesperrte Konten verlieren sofort alle Sitzungen (nicht nur beim nächsten Zugriff)
  if (changes.disabled.length) {
    await q.query("DELETE FROM sessions WHERE lower(user_name) = ANY($1::text[])",
      [changes.disabled.map((n) => n.toLowerCase())]);
  }
  return changes;
}

module.exports = { HttpError, PERMS, toClient, listForClient, findByName, count, createUser, setPassword, syncFromClient, cleanName };
