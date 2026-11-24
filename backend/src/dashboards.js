"use strict";
// Dashboard-Liste: gemeinsame Standard-Dashboards („Standard“, „Detaillierte Auswertung“), öffentliche und
// private Dashboards der Benutzer. Die Widgets prüft die Oberfläche (sanitizeWidgets); der Server begrenzt
// nur Form und Größe. widgets = NULL bei einem Standard-Dashboard heißt: eingebautes Layout der Oberfläche.
//   Standard:   sehen alle, ändern Teamleitung und Administration (Name fest, nicht löschbar)
//   Öffentlich: sehen alle, ändern/löschen der Ersteller und die Administration
//   Privat:     sieht und ändert nur der Ersteller (Administration darf löschen, sieht es aber nicht)
const crypto = require("crypto");
const { HttpError } = require("./http");

const BUILTIN = [
  { id: "standard", name: "Standard", position: 0 },
  { id: "detail", name: "Detaillierte Auswertung", position: 1 }
];
const MAX_PER_USER = 30;
const MAX_WIDGETS = 80;
const MAX_BYTES = 200000;

function isBuiltin(id) { return BUILTIN.some((b) => b.id === id); }

function canEdit(row, user) {
  if (!user || user.demo) return false;
  if (row.visibility === "standard") return user.perm === "admin" || user.perm === "manager";
  return user.perm === "admin" || String(row.owner || "").toLowerCase() === String(user.name).toLowerCase();
}

function toClient(row, user) {
  return {
    id: row.id, name: row.name, visibility: row.visibility, owner: row.owner || "",
    widgets: row.widgets, updatedAt: new Date(row.updated_at).getTime(), updatedBy: row.updated_by || "",
    canEdit: canEdit(row, user)
  };
}

function cleanName(v) {
  const s = String(v == null ? "" : v).trim().replace(/\s+/g, " ");
  if (!s) throw new HttpError(400, "Bitte einen Namen für das Dashboard angeben.");
  if (s.length > 60) throw new HttpError(400, "Der Name ist zu lang (höchstens 60 Zeichen).");
  return s;
}
function cleanVisibility(v) {
  if (v !== "public" && v !== "private") throw new HttpError(400, "Sichtbarkeit bitte „öffentlich“ oder „privat“.");
  return v;
}
function cleanWidgets(v) {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > MAX_WIDGETS || v.some((w) => !w || typeof w !== "object" || Array.isArray(w))) {
    throw new HttpError(400, "Ungültiges Dashboard-Layout.");
  }
  if (JSON.stringify(v).length > MAX_BYTES) throw new HttpError(413, "Dashboard-Layout zu groß.");
  return v;
}

// Sichtbare Dashboards: Standard, öffentliche und die eigenen privaten
async function list(q, user) {
  const r = await q.query(
    `SELECT * FROM dashboards
      WHERE visibility IN ('standard', 'public') OR lower(owner) = lower($1)
      ORDER BY CASE visibility WHEN 'standard' THEN 0 WHEN 'public' THEN 1 ELSE 2 END, position, lower(name)`,
    [user && !user.demo ? user.name : ""]);
  return r.rows.map((row) => toClient(row, user));
}

async function get(q, id, user) {
  const r = await q.query("SELECT * FROM dashboards WHERE id = $1", [String(id || "")]);
  const row = r.rows[0];
  // Fremde private Dashboards gibt es für andere nicht
  if (!row || (row.visibility === "private" && !canEdit(row, user) && user.perm !== "admin")) {
    throw new HttpError(404, "Dashboard nicht gefunden.");
  }
  return row;
}

async function create(q, user, body) {
  const name = cleanName(body.name);
  const visibility = cleanVisibility(body.visibility || "private");
  const widgets = cleanWidgets(Array.isArray(body.widgets) ? body.widgets : []);
  const n = await q.query("SELECT count(*)::int AS n FROM dashboards WHERE lower(owner) = lower($1)", [user.name]);
  if (n.rows[0].n >= MAX_PER_USER) throw new HttpError(400, `Höchstens ${MAX_PER_USER} eigene Dashboards.`);
  const id = "d" + crypto.randomBytes(8).toString("hex");
  const r = await q.query(
    `INSERT INTO dashboards (id, name, visibility, owner, widgets, position, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, 100, $4) RETURNING *`,
    [id, name, visibility, user.name, JSON.stringify(widgets)]);
  return r.rows[0];
}

// Änderungen: Name/Sichtbarkeit nur bei eigenen Dashboards, Widgets überall mit Bearbeitungsrecht
async function update(q, user, id, body) {
  const row = await get(q, id, user);
  if (!canEdit(row, user)) {
    throw new HttpError(403, row.visibility === "standard"
      ? "Standard-Dashboards ändern nur Teamleitung und Administration."
      : "Dieses Dashboard darf nur ändern, wer es angelegt hat.");
  }
  const next = { name: row.name, visibility: row.visibility, widgets: row.widgets };
  const changed = [];
  if (body.name !== undefined && row.visibility !== "standard") {
    next.name = cleanName(body.name);
    if (next.name !== row.name) changed.push("name");
  }
  if (body.visibility !== undefined && row.visibility !== "standard") {
    next.visibility = cleanVisibility(body.visibility);
    if (next.visibility !== row.visibility) changed.push("visibility");
  }
  if (body.widgets !== undefined) {
    // null = eingebautes Layout wiederherstellen (nur bei Standard-Dashboards)
    if (body.widgets === null && row.visibility !== "standard") throw new HttpError(400, "Ungültiges Dashboard-Layout.");
    next.widgets = cleanWidgets(body.widgets);
    changed.push("widgets");
  }
  const r = await q.query(
    `UPDATE dashboards SET name = $2, visibility = $3, widgets = $4::jsonb, updated_at = now(), updated_by = $5
      WHERE id = $1 RETURNING *`,
    [row.id, next.name, next.visibility, next.widgets === null ? null : JSON.stringify(next.widgets), user.name]);
  return { row: r.rows[0], before: row, changed };
}

async function remove(q, user, id) {
  const row = await get(q, id, user);
  if (row.visibility === "standard") throw new HttpError(400, "Standard-Dashboards lassen sich nicht löschen.");
  if (!canEdit(row, user)) throw new HttpError(403, "Dieses Dashboard darf nur löschen, wer es angelegt hat.");
  await q.query("DELETE FROM dashboards WHERE id = $1", [row.id]);
  return row;
}

// Migration: Standard-Dashboards anlegen; frühere persönliche Layouts (users.dashboard v1 mit
// widgets/detail) werden zu privaten Dashboards „Mein Dashboard“/„Meine Auswertung“
async function migrate(q) {
  for (const b of BUILTIN) {
    await q.query(
      `INSERT INTO dashboards (id, name, visibility, owner, widgets, position)
       VALUES ($1, $2, 'standard', NULL, NULL, $3) ON CONFLICT (id) DO NOTHING`,
      [b.id, b.name, b.position]);
  }
  const r = await q.query(
    `SELECT id, name, dashboard FROM users
      WHERE dashboard IS NOT NULL AND coalesce(dashboard->>'v', '1') = '1'`);
  let moved = 0;
  for (const u of r.rows) {
    const old = u.dashboard || {};
    let current = "standard";
    for (const [key, label] of [["widgets", "Mein Dashboard"], ["detail", "Meine Auswertung"]]) {
      if (!Array.isArray(old[key]) || !old[key].length) continue;
      const id = "d" + crypto.randomBytes(8).toString("hex");
      await q.query(
        `INSERT INTO dashboards (id, name, visibility, owner, widgets, position, updated_by)
         VALUES ($1, $2, 'private', $3, $4::jsonb, 100, $3)`,
        [id, label, u.name, JSON.stringify(old[key].slice(0, MAX_WIDGETS))]);
      if (key === "widgets") current = id;   // wer sein Dashboard angepasst hatte, sieht es weiter
      moved++;
    }
    await q.query("UPDATE users SET dashboard = $2::jsonb WHERE id = $1", [u.id, JSON.stringify({ v: 2, current })]);
  }
  return moved;
}

module.exports = { list, get, create, update, remove, migrate, toClient, canEdit, isBuiltin };
