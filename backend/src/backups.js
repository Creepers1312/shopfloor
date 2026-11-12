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
const smb = require("./smb");

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

/* ---------- Kopie auf die SMB-Freigabe (Einstellungen in der Oberfläche, siehe smb.js) ----------
   Lokale Sicherungen funktionieren immer unabhängig davon. Die Liste der Dateien auf der
   Freigabe merkt sich der Server vom letzten Abgleich — die Oberfläche fragt das NAS nicht
   bei jedem Aufruf ab. */
let smbBusy = false;
let smbKnown = null;   // Set der Dateinamen auf der Freigabe (Stand letzter Abgleich)

async function smbStatus() {
  const cfg = await smb.getConfig();
  return Object.assign(cfg, { last: (await db.getMeta("backup_smb_last")) || null });
}

// Fehlende Sicherungen auf die Freigabe kopieren und alte automatische dort aufräumen
async function syncSmb({ force = false } = {}) {
  const raw = await smb.getRaw();
  if (!raw.enabled && !force) return { configured: false };
  if (smbBusy) throw new HttpError(409, "Der Abgleich mit der Freigabe läuft bereits.");
  smbBusy = true;
  const result = { at: Date.now(), ok: true, copied: 0, removed: 0, error: null };
  try {
    const remote = new Set(await smb.listFiles(raw));
    const r = await db.pool.query("SELECT filename FROM backups WHERE ok ORDER BY created_at");
    for (const { filename } of r.rows) {
      if (remote.has(filename)) continue;
      const src = path.join(config.backupDir, filename);
      if (!fs.existsSync(src)) continue;
      await smb.putFile(raw, src, filename);
      remote.add(filename);
      result.copied++;
    }
    // Automatische Sicherungen auf der Freigabe: die neuesten behalten
    // (Zeitstempel im Namen → alphabetisch = chronologisch); manuelle bleiben immer
    const autos = [...remote].filter((f) => f.endsWith("_auto.dump")).sort().reverse();
    for (const f of autos.slice(raw.keep || 30)) {
      try { await smb.deleteFile(raw, f); remote.delete(f); result.removed++; } catch (e) { /* beim nächsten Mal */ }
    }
    smbKnown = remote;
  } catch (e) {
    result.ok = false;
    result.error = e.message;
  } finally {
    smbBusy = false;
  }
  await db.setMeta("backup_smb_last", result).catch(() => {});
  if (result.copied || result.removed) console.log(`[backup] Freigabe: ${result.copied} kopiert, ${result.removed} alte entfernt`);
  if (!result.ok) console.error(`[backup] Freigabe: ${result.error}`);
  return result;
}

// Sicherungsdateien, die von Hand in den Ordner gelegt wurden (z. B. von der Freigabe
// zurückkopiert), in die Liste aufnehmen — so lassen sie sich wiederherstellen
async function adoptFiles() {
  let files;
  try { files = (await fs.promises.readdir(config.backupDir)).filter((f) => FILE_RE.test(f)); } catch (e) { return; }
  if (!files.length) return;
  const known = new Set((await db.pool.query("SELECT filename FROM backups")).rows.map((r) => r.filename));
  for (const f of files) {
    if (known.has(f)) continue;
    let st;
    try { st = await fs.promises.stat(path.join(config.backupDir, f)); } catch (e) { continue; }
    if (!st.isFile() || !st.size) continue;
    await db.pool.query(
      "INSERT INTO backups (filename, kind, note, ok, size_bytes, created_at) VALUES ($1, $2, $3, true, $4, $5) ON CONFLICT DO NOTHING",
      [f, f.endsWith("_auto.dump") ? "auto" : "manual", "im Sicherungsordner gefunden", st.size, st.mtime]
    );
  }
}

async function list() {
  await adoptFiles();
  const onSmb = (await smb.getRaw()).enabled ? smbKnown : null;
  const r = await db.pool.query("SELECT * FROM backups ORDER BY created_at DESC");
  return r.rows.map((b) => ({
    onSmb: onSmb ? onSmb.has(b.filename) : null,   // null = unbekannt bzw. keine Freigabe
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
    // Ältere Sicherungen kennen neuere Spalten nicht (z. B. Anmeldename) — Schema nachziehen
    await db.migrate();
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
      await syncSmb().catch((e) => console.error("[backup] Freigabe:", e.message));
    } catch (err) {
      console.error("[backup] Zeitplan:", err.message);
    }
  };
  setInterval(tick, 30 * 1000).unref();
  // War die Freigabe zeitweise weg, holt der stündliche Abgleich fehlende Kopien nach
  setInterval(() => { syncSmb().catch(() => {}); }, 60 * 60 * 1000).unref();
  setTimeout(() => { syncSmb().catch(() => {}); }, 20 * 1000).unref();
}

module.exports = {
  checkTools, tool: () => toolInfo, getConfig, setConfig, list, create, remove, restore, prune,
  resolveFile, startScheduler, smbStatus, syncSmb
};
