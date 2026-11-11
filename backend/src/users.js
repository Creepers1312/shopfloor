"use strict";
// Konten liegen in einer eigenen Tabelle. Die Oberfläche sieht sie als Liste
// (Dokument "users") — ohne Passwort-Hashes. Speichert ein Admin die Liste,
// wird sie hier mit der Tabelle abgeglichen (Recht, Sperre, Reihenfolge, Löschen).
// Passwörter, Anmeldename und E-Mail werden darüber nie gesetzt — dafür gibt es eigene
// Endpunkte (POST/PATCH /api/users, /api/users/password, /api/me/…).
//
// name      Anzeigename und Kennung des Kontos (Sitzungen, Layouts, Verantwortliche)
// username  Anmeldename (eindeutig, ohne Groß-/Kleinschreibung)
// email     E-Mail-Adresse (optional, eindeutig) — für „Passwort vergessen“
const { hashPassword } = require("./passwords");

const PERMS = ["admin", "editor", "viewer"];
const KNOWN = new Set(["name", "role", "perm", "disabled", "hash", "lastLogin", "username", "email", "password"]);

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
function cleanUsername(v) {
  const u = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!u) throw new HttpError(400, "Bitte einen Anmeldenamen angeben.");
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(u)) {
    throw new HttpError(400, "Anmeldename: 2–40 Zeichen, nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.");
  }
  return u;
}
function cleanEmail(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!e) return null;
  if (e.length > 200 || !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z0-9-]{2,}$/i.test(e)) {
    throw new HttpError(400, "Bitte eine gültige E-Mail-Adresse angeben.");
  }
  return e;
}

// Vorschlag für einen Anmeldenamen aus dem Anzeigenamen: „Jörg Müller“ → „joerg.mueller“
function slugUsername(name) {
  const map = { "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" };
  let s = String(name || "").toLowerCase().replace(/[äöüß]/g, (c) => map[c]);
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "").replace(/\.{2,}/g, ".").replace(/^[._-]+|[._-]+$/g, "");
  if (s.length < 2) s = "benutzer";
  return s.slice(0, 36);
}
async function freeUsername(q, base, exceptId) {
  for (let i = 1; i < 1000; i++) {
    const cand = i === 1 ? base : `${base}${i}`;
    const r = await q.query("SELECT 1 FROM users WHERE lower(username) = $1 AND id IS DISTINCT FROM $2", [cand, exceptId || null]);
    if (!r.rowCount) return cand;
  }
  throw new HttpError(409, "Kein freier Anmeldename gefunden.");
}

// Datenbank meldet doppelten Anmeldenamen/E-Mail → verständliche Fehlermeldung
function uniqueError(err) {
  if (err && err.code === "23505") {
    if (/email/.test(err.constraint || err.detail || "")) return new HttpError(409, "Diese E-Mail-Adresse gehört bereits zu einem anderen Konto.");
    if (/username/.test(err.constraint || err.detail || "")) return new HttpError(409, "Dieser Anmeldename ist bereits vergeben.");
    return new HttpError(409, "Name, Anmeldename oder E-Mail ist bereits vergeben.");
  }
  return err;
}

function toClient(row) {
  const u = Object.assign({}, row.extra || {}, {
    name: row.name,
    username: row.username || "",
    email: row.email || "",
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
// Anmeldung: Anmeldename oder E-Mail
async function findByLogin(q, login) {
  const v = String(login || "").trim().toLowerCase();
  if (!v) return null;
  const r = await q.query("SELECT * FROM users WHERE lower(username) = $1 OR lower(email) = $1 LIMIT 2", [v]);
  return r.rows.length === 1 ? r.rows[0] : null;
}

async function count(q) {
  const r = await q.query("SELECT count(*)::int AS n FROM users");
  return r.rows[0].n;
}

async function createUser(q, { name, username, email, role, perm, clientHash }) {
  name = cleanName(name);
  if (await findByName(q, name)) throw new HttpError(409, "Ein Konto mit diesem Namen gibt es bereits.");
  const uname = username ? cleanUsername(username) : await freeUsername(q, slugUsername(name));
  const mail = cleanEmail(email);
  const pos = await q.query("SELECT coalesce(max(position), -1) + 1 AS p FROM users");
  const pw = clientHash ? await hashPassword(clientHash) : null;
  try {
    const r = await q.query(
      "INSERT INTO users (name, username, email, role, perm, pw_hash, position) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [name, uname, mail, cleanRole(role), cleanPerm(perm), pw, pos.rows[0].p]
    );
    return r.rows[0];
  } catch (err) { throw uniqueError(err); }
}

// Anmeldename, E-Mail und Rolle eines Kontos ändern (Admin bzw. eigene E-Mail)
async function updateProfile(q, name, fields) {
  const row = await findByName(q, name);
  if (!row) throw new HttpError(404, "Konto nicht gefunden.");
  const next = {
    username: fields.username !== undefined ? cleanUsername(fields.username) : row.username,
    email: fields.email !== undefined ? cleanEmail(fields.email) : row.email,
    role: fields.role !== undefined ? cleanRole(fields.role) : row.role
  };
  try {
    const r = await q.query("UPDATE users SET username = $2, email = $3, role = $4 WHERE id = $1 RETURNING *",
      [row.id, next.username, next.email, next.role]);
    return { before: row, after: r.rows[0] };
  } catch (err) { throw uniqueError(err); }
}

async function setPassword(q, name, clientHash) {
  const r = await q.query("UPDATE users SET pw_hash = $2 WHERE lower(name) = lower($1) RETURNING *",
    [name, await hashPassword(clientHash)]);
  return r.rows[0] || null;
}

// Fehlende Anmeldenamen (ältere Konten) aus dem Namen ableiten — läuft bei jedem Start
async function backfillUsernames(q) {
  const r = await q.query("SELECT id, name FROM users WHERE username IS NULL OR username = '' ORDER BY id");
  for (const row of r.rows) {
    const u = await freeUsername(q, slugUsername(row.name), row.id);
    await q.query("UPDATE users SET username = $2 WHERE id = $1", [row.id, u]);
  }
  return r.rows.length;
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
    Object.keys(u).forEach((k) => { if (!KNOWN.has(k)) extra[k] = u[k]; });
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
      const uname = await freeUsername(q, slugUsername(u.name));
      await q.query(
        `INSERT INTO users (name, username, role, perm, disabled, extra, position)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [u.name, uname, u.role, u.perm, u.disabled, JSON.stringify(u.extra), u.position]
      );
      changes.created.push(u.name);
    }
  }

  const removed = existing.rows.filter((r) => !seen.has(r.key)).map((r) => r.id);
  if (removed.length) {
    const del = await q.query("DELETE FROM users WHERE id = ANY($1::int[]) RETURNING name", [removed]);
    const names = del.rows.map((r) => r.name.toLowerCase());
    await q.query("DELETE FROM sessions WHERE lower(user_name) = ANY($1::text[])", [names]);
    await q.query("DELETE FROM password_resets WHERE lower(user_name) = ANY($1::text[])", [names]);
    await q.query("DELETE FROM reset_requests WHERE lower(user_name) = ANY($1::text[])", [names]);
    changes.removed = del.rows.map((r) => r.name);
  }
  // Gesperrte Konten verlieren sofort alle Sitzungen und offenen Reset-Links
  if (changes.disabled.length) {
    const names = changes.disabled.map((n) => n.toLowerCase());
    await q.query("DELETE FROM sessions WHERE lower(user_name) = ANY($1::text[])", [names]);
    await q.query("DELETE FROM password_resets WHERE lower(user_name) = ANY($1::text[])", [names]);
  }
  return changes;
}

module.exports = {
  HttpError, PERMS, toClient, listForClient, findByName, findByLogin, count, createUser, updateProfile,
  setPassword, syncFromClient, cleanName, cleanUsername, cleanEmail, slugUsername, backfillUsernames
};
