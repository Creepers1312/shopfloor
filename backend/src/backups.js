"use strict";
// Sicherungen per pg_dump (Custom-Format) der Tabellen documents und users.
// Sitzungen, Sicherungsliste und Zähler gehören nicht dazu — eine Wiederherstellung
// meldet also niemanden ab und löscht keine anderen Sicherungen.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("./config");
const db = require("./db");
const { HttpError } = require("./users");

const FILE_RE = /^shopfloor_[0-9_-]+_(auto|manual)\.dump$/;
const TABLES = ["documents", "users"];

let busy = false;
let toolInfo = { ok: false, info: "noch nicht geprüft" };

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let p;
    try {
      p = spawn(cmd, args, {
        env: Object.assign({}, process.env, {
          PGHOST: config.db.host, PGPORT: String(config.db.port),
          PGUSER: config.db.user, PGPASSWORD: config.db.password, PGDATABASE: config.db.database
        })
      });
    } catch (e) {
      return resolve({ code: -1, out: "", err: e.message });
    }
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

async function checkTools() {
  const r = await run("pg_dump", ["--version"]);
  toolInfo = r.code === 0
    ? { ok: true, info: r.out.trim() }
    : { ok: false, info: (r.err || r.out || "pg_dump nicht gefunden").trim() };
  return toolInfo;
}

async function getConfig(q) {
  const v = await db.getMeta("backup_config", q);
  const d = config.backupDefaults;
  return {
    enabled: v && typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    time: config.parseTime(v && v.time, d.time),
    keep: config.parseInt(v && v.keep, d.keep, 1, 365)
  };
}

async function setConfig(body) {
  const cur = await getConfig();
  const next = {
    enabled: typeof body.enabled === "boolean" ? body.enabled : cur.enabled,
    time: config.parseTime(body.time, cur.time),
    keep: config.parseInt(body.keep, cur.keep, 1, 365)
  };
  await db.setMeta("backup_config", next);
  return next;
}

function pad(n) { return String(n).padStart(2, "0"); }
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function todayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

async function list() {
  const r = await db.pool.query("SELECT * FROM backups ORDER BY created_at DESC");
  return r.rows.map((b) => ({
    filename: b.filename,
    createdAt: new Date(b.created_at).getTime(),
    kind: b.kind,
    note: b.note || "",
    ok: b.ok,
    sizeBytes: Number(b.size_bytes),
    error: b.error || undefined
  }));
}

async function create(kind, note) {
  if (busy) throw new HttpError(409, "Es läuft bereits eine Sicherung oder Wiederherstellung.");
  busy = true;
  try {
    await fs.promises.mkdir(config.backupDir, { recursive: true });
    let filename = `shopfloor_${stamp(new Date())}_${kind}.dump`;
    let n = 1;
    while (fs.existsSync(path.join(config.backupDir, filename))) {
      filename = `shopfloor_${stamp(new Date())}-${n++}_${kind}.dump`;
    }
    const file = path.join(config.backupDir, filename);
    const args = ["--format=custom", "--no-owner", "--no-privileges", "--file", file];
    TABLES.forEach((t) => args.push("--table", t));
    const r = await run("pg_dump", args);
    let size = 0;
    try { size = (await fs.promises.stat(file)).size; } catch (e) { /* nicht entstanden */ }
    const ok = r.code === 0 && size > 0;
    const error = ok ? null : (r.err || "pg_dump fehlgeschlagen").trim().slice(0, 500);
    if (!ok) await fs.promises.unlink(file).catch(() => {});
    await db.pool.query(
      "INSERT INTO backups (filename, kind, note, ok, size_bytes, error) VALUES ($1, $2, $3, $4, $5, $6)",
      [filename, kind, (note || "").slice(0, 200) || null, ok, size, error]
    );
    if (!ok) console.error(`[backup] ${filename} fehlgeschlagen: ${error}`);
    else console.log(`[backup] ${filename} erstellt (${size} Bytes)`);
    return { filename, ok, error };
  } finally {
    busy = false;
  }
}

async function resolveFile(filename) {
  if (!FILE_RE.test(filename || "")) throw new HttpError(400, "Ungültiger Dateiname.");
  const r = await db.pool.query("SELECT * FROM backups WHERE filename = $1", [filename]);
  if (!r.rows[0]) throw new HttpError(404, "Sicherung nicht gefunden.");
  const file = path.join(config.backupDir, filename);
  return { row: r.rows[0], file, exists: fs.existsSync(file) };
}

async function remove(filename) {
  const { file } = await resolveFile(filename);
  await fs.promises.unlink(file).catch((e) => { if (e.code !== "ENOENT") throw e; });
  await db.pool.query("DELETE FROM backups WHERE filename = $1", [filename]);
}

async function restore(filename, by) {
  const { row, file, exists } = await resolveFile(filename);
  if (!row.ok || !exists) throw new HttpError(400, "Diese Sicherung ist unvollständig oder die Datei fehlt.");

  // Vorher den aktuellen Stand sichern — so lässt sich jede Wiederherstellung rückgängig machen
  const pre = await create("manual", `vor Wiederherstellung von ${filename}`);
  if (!pre.ok) throw new HttpError(500, "Sicherung des aktuellen Stands fehlgeschlagen — Wiederherstellung abgebrochen.");

  if (busy) throw new HttpError(409, "Es läuft bereits eine Sicherung oder Wiederherstellung.");
  busy = true;
  try {
    const r = await run("pg_restore", [
      "--clean", "--if-exists", "--single-transaction", "--no-owner", "--no-privileges",
      "--dbname", config.db.database, file
    ]);
    if (r.code !== 0) {
      throw new HttpError(500, "pg_restore fehlgeschlagen: " + (r.err || "").trim().slice(0, 300));
    }
    // Alle Geräte sollen den wiederhergestellten Stand neu laden
    await db.tx(async (c) => {
      await db.lockRevision(c);
      await db.bumpRevision(c, ["state", "settings", "users"], by || "Wiederherstellung");
    });
    console.log(`[backup] ${filename} wiederhergestellt`);
  } finally {
    busy = false;
  }
}

async function prune(keep) {
  const r = await db.pool.query(
    "SELECT filename FROM backups WHERE kind = 'auto' ORDER BY created_at DESC OFFSET $1", [keep]
  );
  for (const b of r.rows) {
    await fs.promises.unlink(path.join(config.backupDir, b.filename)).catch(() => {});
    await db.pool.query("DELETE FROM backups WHERE filename = $1", [b.filename]);
  }
  if (r.rows.length) console.log(`[backup] ${r.rows.length} alte automatische Sicherung(en) entfernt`);
}

// Prüft jede halbe Minute, ob die tägliche Sicherung fällig ist
function startScheduler() {
  const tick = async () => {
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return;
      const now = new Date();
      const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      if (hm !== cfg.time) return;
      const today = todayKey(now);
      if ((await db.getMeta("backup_last_auto")) === today) return;
      await db.setMeta("backup_last_auto", today);
      await create("auto", "tägliche Sicherung");
      await prune(cfg.keep);
    } catch (err) {
      console.error("[backup] Zeitplan:", err.message);
    }
  };
  setInterval(tick, 30 * 1000).unref();
}

module.exports = {
  checkTools, tool: () => toolInfo, getConfig, setConfig, list, create, remove, restore, prune,
  resolveFile, startScheduler
};
