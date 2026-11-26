"use strict";
// Sicherungen per pg_dump (Custom-Format) der Tabellen documents, users, dashboards und user_avatars.
// Sitzungen, Sicherungsliste und Zähler gehören nicht dazu — eine Wiederherstellung
// meldet also niemanden ab und löscht keine anderen Sicherungen.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("./config");
const db = require("./db");
const { HttpError } = require("./http");
const smb = require("./smb");

const FILE_RE = config.backupFileRe;
const TABLES = ["documents", "users", "dashboards", "user_avatars"];

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
  if (result.ok) await db.setMeta("backup_smb_ok_at", result.at).catch(() => {});
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

/* ---------- Teilweise Wiederherstellung (Standard: CLAUDE.md „Wiederherstellung & Konsistenz“) ----------
   Die Sicherung wird mit pg_restore als Text (COPY-Blöcke) gelesen und in Objekte zerlegt; danach werden nur
   die gewählten Teile bzw. einzelnen Datensätze in EINER Transaktion übernommen. Regeln:
     1. Zusammengehöriges kommt als Einheit: ein Tag = Tageswerte + SQIDP-Status + Begründungen + Huddle-Haken +
        Sicherheitseintrag. Berechnete Werte (OEE, Ampeln) werden nie gespeichert, sondern neu berechnet.
     2. Zuordnung über eindeutige Kennungen: Abweichungen über id, Konten über Anmeldenamen, Dashboards über id.
        Vorhanden → auf den Stand der Sicherung setzen, sonst neu anlegen. Zähler (seq, users.id) werden nachgezogen.
     3. Verknüpfungen werden erkannt und als Hinweis gemeldet (Abweichung ↔ Tag über created/due).
     4. dryRun liefert nur den Plan (ersetzt/neu/unverändert, Hinweise) und ändert nichts.
     5. Vor dem Speichern wird das Ergebnis geprüft (validateResult); ein Verstoß bricht alles ab (Rollback).
     6. Vorher automatische Sicherung, danach Sicherheitsprotokoll mit den Datensätzen.
   Teile: daily | deviations | settings | users | dashboards */
const PARTS = ["daily", "deviations", "settings", "users", "dashboards"];
const DAILY_KEYS = ["dailyData", "boards", "huddleLog", "reasons", "safetyLog"];

// Ein Feld im Textformat von COPY entschlüsseln (\N = NULL, Backslash-Folgen)
function copyField(v) {
  if (v === "\\N") return null;
  if (v.indexOf("\\") < 0) return v;
  return v.replace(/\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|(.))/g, (m, oct, hex, ch) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[ch] || ch;
  });
}
function parseCopyText(sql) {
  const tables = {};
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^COPY (?:public\.)?"?(\w+)"? \(([^)]*)\) FROM stdin;$/.exec(lines[i]);
    if (!m) continue;
    const cols = m[2].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const rows = [];
    for (i++; i < lines.length && lines[i] !== "\\."; i++) {
      const vals = lines[i].split("\t").map(copyField);
      const row = {};
      cols.forEach((c, k) => { row[c] = vals[k] === undefined ? null : vals[k]; });
      rows.push(row);
    }
    tables[m[1]] = { cols, rows };
  }
  return tables;
}
async function readDump(filename) {
  const { row, file, exists } = await resolveFile(filename);
  if (!row.ok || !exists) throw new HttpError(400, "Diese Sicherung ist unvollständig oder die Datei fehlt.");
  const r = await run("pg_restore", ["--data-only", "--file=-", file]);
  if (r.code !== 0) throw new HttpError(500, "Sicherung konnte nicht gelesen werden: " + (r.err || "").trim().slice(0, 200));
  const t = parseCopyText(r.out);
  const doc = (name) => {
    const d = ((t.documents && t.documents.rows) || []).find((x) => x.name === name);
    if (!d || d.value == null) return null;
    try { return JSON.parse(d.value); } catch (e) { return null; }
  };
  return { row, tables: t, state: doc("state"), settings: doc("settings") };
}

const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const devDay = (d) => (d && (d.created || d.due)) || null;
const devNum = (id) => { const m = /(\d+)$/.exec(String(id || "")); return m ? +m[1] : 0; };
const lc = (v) => String(v == null ? "" : v).trim().toLowerCase();
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// Alles, was zu einem Tag gehört (Einheit für Vergleich und Übernahme)
function dayUnit(st, iso) {
  st = st || {};
  const p = iso.split("-"), mk = `${+p[0]}-${+p[1]}`, d = +p[2];
  const board = {};
  const bm = (st.boards || {})[mk] || {};
  Object.keys(bm).forEach((cat) => { if (bm[cat] && bm[cat][d] != null) board[cat] = bm[cat][d]; });
  const reasons = {};
  Object.keys(st.reasons || {}).forEach((k) => { if (k.split("|")[0] === iso) reasons[k] = st.reasons[k]; });
  return {
    daily: (st.dailyData || {})[iso] || null, huddle: (st.huddleLog || {})[iso] || null,
    safety: (st.safetyLog || {})[iso] || null, board, reasons
  };
}
function unitEmpty(u) {
  return !u.daily && !u.huddle && !u.safety && !Object.keys(u.board).length && !Object.keys(u.reasons).length;
}
// Tage (Einheiten) aus der Sicherung in den aktuellen Stand übernehmen
function applyDays(cur, bak, days) {
  ["dailyData", "huddleLog", "safetyLog", "reasons", "boards"].forEach((k) => { if (!cur[k] || typeof cur[k] !== "object") cur[k] = {}; });
  days.forEach((iso) => {
    const u = dayUnit(bak, iso);
    [["dailyData", "daily"], ["huddleLog", "huddle"], ["safetyLog", "safety"]].forEach(([k, f]) => {
      if (u[f] != null) cur[k][iso] = u[f]; else delete cur[k][iso];
    });
    Object.keys(cur.reasons).forEach((k) => { if (k.split("|")[0] === iso) delete cur.reasons[k]; });
    Object.assign(cur.reasons, u.reasons);
    const p = iso.split("-"), mk = `${+p[0]}-${+p[1]}`, d = +p[2];
    const cm = cur.boards[mk] || (cur.boards[mk] = {});
    new Set(Object.keys(cm).concat(Object.keys((bak.boards || {})[mk] || {}))).forEach((cat) => {
      const col = cm[cat] = Object.assign({}, cm[cat] || {});
      if (u.board[cat] != null) col[d] = u.board[cat]; else delete col[d];
    });
  });
}
function daysInRange(st, from, to) {
  const set = new Set();
  const add = (iso) => { if (isIso(iso) && (!from || iso >= from) && (!to || iso <= to)) set.add(iso); };
  st = st || {};
  ["dailyData", "huddleLog", "safetyLog"].forEach((k) => Object.keys(st[k] || {}).forEach(add));
  Object.keys(st.reasons || {}).forEach((k) => add(k.split("|")[0]));
  Object.keys(st.boards || {}).forEach((mk) => {
    const m = /^(\d{4})-(\d{1,2})$/.exec(mk);
    if (!m) return;
    Object.values(st.boards[mk] || {}).forEach((col) => Object.keys(col || {}).forEach((d) =>
      add(`${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+d).padStart(2, "0")}`)));
  });
  return [...set].sort();
}

// Inhalt einer Sicherung für das Auswahlfenster (mit Listen für die Einzelauswahl)
async function inspect(filename) {
  const d = await readDump(filename);
  const st = d.state || {};
  const days = Object.keys(st.dailyData || {}).filter(isIso).sort();
  const devs = Array.isArray(st.deviations) ? st.deviations.filter(Boolean) : [];
  const users = (d.tables.users && d.tables.users.rows) || [];
  const dash = ((d.tables.dashboards && d.tables.dashboards.rows) || []).filter((x) => x.visibility !== "standard");
  return {
    filename, createdAt: d.row.created_at, kind: d.row.kind, note: d.row.note,
    daily: { days: days.length, from: days[0] || null, to: days[days.length - 1] || null, list: days },
    deviations: {
      total: devs.length, open: devs.filter((x) => x.phase !== "done").length,
      list: devs.map((x) => ({ id: x.id, title: x.title || "Abweichung", cat: x.cat, phase: x.phase, owner: x.owner || "", due: x.due || null, day: devDay(x) }))
    },
    settings: { present: !!d.settings, lineName: (d.settings && d.settings.lineName) || "" },
    users: {
      total: users.length, admins: users.filter((u) => u.perm === "admin" && u.disabled !== "t").length,
      names: users.slice(0, 50).map((u) => u.name), avatars: ((d.tables.user_avatars && d.tables.user_avatars.rows) || []).length,
      list: users.map((u) => ({ name: u.name, username: u.username || "", perm: u.perm, disabled: u.disabled === "t" }))
    },
    dashboards: { total: dash.length, names: dash.slice(0, 50).map((x) => x.name), list: dash.map((x) => ({ id: x.id, name: x.name, visibility: x.visibility, owner: x.owner || "" })) }
  };
}

// Zeilen einer Tabelle aus der Sicherung einsetzen (nur Spalten, die es heute gibt)
async function tableCols(c, table) {
  const r = await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]);
  return new Set(r.rows.map((x) => x.column_name));
}
async function insertRow(c, table, row, have, skip = []) {
  const cols = Object.keys(row).filter((x) => have.has(x) && !skip.includes(x));
  const res = await c.query(`INSERT INTO ${table} (${cols.map((x) => `"${x}"`).join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")}) RETURNING *`, cols.map((x) => row[x]));
  return res.rows[0];
}
async function replaceTable(c, table, dumpTable) {
  await c.query(`DELETE FROM ${table}`);
  if (!dumpTable || !dumpTable.rows.length) return 0;
  const have = await tableCols(c, table);
  for (const row of dumpTable.rows) await insertRow(c, table, row, have);
  return dumpTable.rows.length;
}

function cleanSelect(sel) {
  sel = sel && typeof sel === "object" ? sel : {};
  const list = (v, max, ok) => (Array.isArray(v) ? [...new Set(v.map(String))].filter(ok).slice(0, max) : null);
  return {
    days: list(sel.days, 1000, isIso),
    deviations: list(sel.deviations, 2000, (x) => x.length <= 64),
    users: list(sel.users, 500, (x) => x.length <= 64),
    dashboards: list(sel.dashboards, 500, (x) => x.length <= 64),
    keepPasswords: sel.keepPasswords !== false
  };
}

// Prüfung des Ergebnisses vor dem Speichern (Rollback bei Verstoß)
async function validateResult(c, state, parts) {
  const problems = [];
  if (state) {
    const ids = (state.deviations || []).map((x) => x && x.id);
    const dup = ids.filter((x, i) => x && ids.indexOf(x) !== i);
    if (dup.length) problems.push(`Doppelte Abweichungsnummern: ${[...new Set(dup)].join(", ")}`);
    const maxN = Math.max(0, ...ids.map(devNum));
    if ((Number(state.seq) || 0) <= maxN) problems.push("Nummernzähler der Abweichungen zu klein");
    Object.keys(state.reasons || {}).forEach((k) => { if (!isIso(k.split("|")[0])) problems.push(`Ungültige Begründung „${k}“`); });
  }
  if (parts.includes("users")) {
    const r = await c.query(`SELECT
      (SELECT count(*) FROM users WHERE perm = 'admin' AND NOT disabled AND pw_hash IS NOT NULL)::int AS admins,
      (SELECT count(*) - count(DISTINCT lower(name)) FROM users)::int AS dupnames`);
    if (!r.rows[0].admins) problems.push("Kein aktiver Administrator mehr vorhanden");
    if (r.rows[0].dupnames) problems.push("Doppelte Kontonamen");
  }
  if (parts.includes("dashboards") || parts.includes("users")) {
    const r = await c.query(`SELECT name FROM dashboards d WHERE visibility = 'private'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.name) = lower(d.owner))`);
    if (r.rows.length && parts.includes("dashboards")) problems.push(`Private Dashboards ohne Besitzer: ${r.rows.map((x) => x.name).join(", ")}`);
  }
  if (problems.length) throw new HttpError(409, "Wiederherstellung abgebrochen — das Ergebnis wäre nicht stimmig: " + problems.join("; "));
}

async function restoreParts(filename, opts = {}, by) {
  let { parts, from, to } = opts;
  const dryRun = !!opts.dryRun;
  const sel = cleanSelect(opts.select);
  parts = Array.isArray(parts) ? [...new Set(parts)].filter((p) => PARTS.includes(p)) : [];
  if (!parts.length) throw new HttpError(400, "Bitte mindestens einen Teil zum Wiederherstellen wählen.");
  if ((from && !isIso(from)) || (to && !isIso(to)) || (from && to && from > to)) throw new HttpError(400, "Ungültiger Zeitraum.");
  const pick = { daily: !!(from || to || sel.days), deviations: !!sel.deviations, users: !!sel.users, dashboards: !!sel.dashboards };
  if (pick.daily && sel.days && !sel.days.length && !from && !to) throw new HttpError(400, "Bitte mindestens einen Tag wählen.");
  ["deviations", "users", "dashboards"].forEach((k) => {
    if (parts.includes(k) && pick[k] && !sel[k].length) throw new HttpError(400, "Bitte mindestens einen Eintrag wählen.");
  });
  const anyPick = PARTS.some((p) => parts.includes(p) && pick[p]);
  // Alles ohne Einzelauswahl: vollständige Wiederherstellung wie bisher (inkl. Tabellenaufbau)
  if (parts.length === PARTS.length && !anyPick && !dryRun) { await restore(filename, by); return { full: true, parts }; }

  const d = await readDump(filename);
  if ((parts.includes("daily") || parts.includes("deviations")) && !d.state) throw new HttpError(400, "Die Sicherung enthält keine Board-Daten.");
  if (parts.includes("settings") && !d.settings) throw new HttpError(400, "Die Sicherung enthält keine Stammdaten.");

  const curDocs = await db.pool.query("SELECT name, value FROM documents WHERE name IN ('state', 'settings')");
  const cur = { state: {}, settings: null };
  curDocs.rows.forEach((r) => { cur[r.name] = r.value; });
  const curState = JSON.parse(JSON.stringify(cur.state || {}));
  const bak = d.state || {};
  const plan = { parts, replaced: 0, added: 0, removed: 0, unchanged: 0, details: {}, warnings: [], records: {} };
  const count = (part, kind, label) => {
    plan[kind]++;
    const det = plan.details[part] || (plan.details[part] = { replaced: 0, added: 0, removed: 0, unchanged: 0 });
    det[kind]++;
    if (label && kind !== "unchanged") (plan.records[part] = plan.records[part] || []).push(label);
  };

  // Tageswerte
  let days = [];
  if (parts.includes("daily")) {
    if (pick.daily) {
      const set = new Set(sel.days || []);
      if (from || to) { daysInRange(bak, from, to).forEach((x) => set.add(x)); daysInRange(curState, from, to).forEach((x) => set.add(x)); }
      days = [...set].sort();
    } else {
      days = [...new Set(daysInRange(bak).concat(daysInRange(curState)))].sort();
    }
    days.forEach((iso) => {
      const a = dayUnit(curState, iso), b = dayUnit(bak, iso);
      if (same(a, b)) count("daily", "unchanged");
      else if (unitEmpty(b)) count("daily", "removed", iso);
      else count("daily", unitEmpty(a) ? "added" : "replaced", iso);
    });
  }
  // Abweichungen
  let newDevs = null;
  if (parts.includes("deviations")) {
    const bDevs = (Array.isArray(bak.deviations) ? bak.deviations : []).filter(Boolean);
    const cDevs = (Array.isArray(curState.deviations) ? curState.deviations : []).filter(Boolean);
    if (pick.deviations) {
      newDevs = cDevs.slice();
      sel.deviations.forEach((id) => {
        const b = bDevs.find((x) => x.id === id);
        if (!b) { plan.warnings.push(`Abweichung ${id} ist in der Sicherung nicht enthalten.`); return; }
        const i = newDevs.findIndex((x) => x.id === id);
        if (i < 0) { newDevs.push(b); count("deviations", "added", b.title || id); }
        else if (same(newDevs[i], b)) count("deviations", "unchanged");
        else { newDevs[i] = b; count("deviations", "replaced", b.title || id); }
        // Verknüpfung: gehört zu einem Tag, der sich seither geändert hat und nicht mit ausgewählt ist?
        const day = devDay(b);
        if (day && !days.includes(day) && !same(dayUnit(curState, day), dayUnit(bak, day))) {
          plan.warnings.push(`„${b.title || id}“ gehört zum ${day.split("-").reverse().join(".")} — die Tageswerte dieses Tags haben sich seit der Sicherung geändert und sind nicht ausgewählt.`);
        }
      });
    } else {
      newDevs = bDevs;
      const ids = new Set(bDevs.map((x) => x.id).concat(cDevs.map((x) => x.id)));
      ids.forEach((id) => {
        const a = cDevs.find((x) => x.id === id), b = bDevs.find((x) => x.id === id);
        if (!b) count("deviations", "removed", (a && a.title) || id);
        else if (!a) count("deviations", "added", b.title || id);
        else count("deviations", same(a, b) ? "unchanged" : "replaced", b.title || id);
      });
    }
  }
  // Tage gewählt, zugehörige Abweichungen der Sicherung fehlen heute und sind nicht gewählt → Hinweis
  if (parts.includes("daily") && pick.daily) {
    const cIds = new Set(((newDevs || curState.deviations) || []).filter(Boolean).map((x) => x.id));
    (bak.deviations || []).filter(Boolean).forEach((b) => {
      if (days.includes(devDay(b)) && !cIds.has(b.id)) {
        plan.warnings.push(`Zum ${devDay(b).split("-").reverse().join(".")} gehört die Abweichung „${b.title || b.id}“, die es heute nicht mehr gibt — bei Bedarf unter „Abweichungen & Maßnahmen“ mit auswählen.`);
      }
    });
  }
  if (parts.includes("settings")) count("settings", same(cur.settings, d.settings) ? "unchanged" : "replaced", "Stammdaten");

  // Konten
  const bUsers = (d.tables.users && d.tables.users.rows) || [];
  let curUsers = [];
  if (parts.includes("users") || parts.includes("dashboards")) curUsers = (await db.pool.query("SELECT id, name, username, email, perm, disabled FROM users")).rows;
  if (parts.includes("users")) {
    if (pick.users) {
      sel.users.forEach((un) => {
        const b = bUsers.find((x) => lc(x.username) === lc(un));
        if (!b) { plan.warnings.push(`Konto „${un}“ ist in der Sicherung nicht enthalten.`); return; }
        const a = curUsers.find((x) => lc(x.username) === lc(un));
        const clashName = curUsers.find((x) => lc(x.name) === lc(b.name) && (!a || x.id !== a.id));
        const clashMail = b.email && curUsers.find((x) => lc(x.email) === lc(b.email) && (!a || x.id !== a.id));
        if (clashName || clashMail) {
          throw new HttpError(409, `Konto „${b.name}“ kann nicht übernommen werden: ${clashName ? `der Name wird heute von „${clashName.username}“ benutzt` : `die E-Mail wird heute von „${clashMail.username}“ benutzt`}.`);
        }
        count("users", a ? "replaced" : "added", b.name);
      });
      if (sel.keepPasswords) plan.warnings.push("Bei vorhandenen Konten bleibt das heutige Passwort; neu angelegte Konten bekommen das Passwort aus der Sicherung.");
    } else {
      if (!bUsers.some((u) => u.perm === "admin" && u.disabled !== "t" && u.pw_hash)) {
        throw new HttpError(400, "Die Benutzerkonten der Sicherung enthalten keinen aktiven Administrator — nicht übernommen.");
      }
      const keys = new Set(bUsers.map((x) => lc(x.username || x.name)).concat(curUsers.map((x) => lc(x.username || x.name))));
      keys.forEach((k) => {
        const a = curUsers.find((x) => lc(x.username || x.name) === k), b = bUsers.find((x) => lc(x.username || x.name) === k);
        count("users", !b ? "removed" : !a ? "added" : "replaced", (b || a).name);
      });
    }
  }
  // Dashboards
  const bDash = ((d.tables.dashboards && d.tables.dashboards.rows) || []);
  if (parts.includes("dashboards")) {
    const curDash = (await db.pool.query("SELECT id, name, owner, visibility FROM dashboards")).rows;
    const ownerOk = (b) => b.visibility !== "private" || curUsers.some((u) => lc(u.name) === lc(b.owner)) ||
      (parts.includes("users") && bUsers.some((u) => lc(u.name) === lc(b.owner)) && (!pick.users || sel.users.some((un) => bUsers.some((u) => lc(u.username) === lc(un) && lc(u.name) === lc(b.owner)))));
    const ids = pick.dashboards ? sel.dashboards : [...new Set(bDash.map((x) => x.id).concat(curDash.map((x) => x.id)))];
    ids.forEach((id) => {
      const b = bDash.find((x) => x.id === id), a = curDash.find((x) => x.id === id);
      if (!b && pick.dashboards) { plan.warnings.push(`Dashboard ${id} ist in der Sicherung nicht enthalten.`); return; }
      if (b && !ownerOk(b)) throw new HttpError(409, `Privates Dashboard „${b.name}“: der Besitzer „${b.owner}“ existiert nicht — bitte das Konto mit auswählen oder das Dashboard abwählen.`);
      count("dashboards", !b ? "removed" : !a ? "added" : "replaced", (b || a).name);
    });
  }
  if (dryRun) return { dryRun: true, plan };

  // Vorher den aktuellen Stand sichern — so lässt sich jede Wiederherstellung rückgängig machen
  const pre = await create("manual", `vor Teil-Wiederherstellung von ${filename}`);
  if (!pre.ok) throw new HttpError(500, "Sicherung des aktuellen Stands fehlgeschlagen — Wiederherstellung abgebrochen.");
  if (busy) throw new HttpError(409, "Es läuft bereits eine Sicherung oder Wiederherstellung.");
  busy = true;
  try {
    const changed = [];
    await db.tx(async (c) => {
      await db.lockRevision(c);
      let newState = null;
      if (parts.includes("daily") || parts.includes("deviations")) {
        const r = await c.query("SELECT value FROM documents WHERE name = 'state' FOR UPDATE");
        newState = (r.rows[0] && r.rows[0].value) || {};
        if (parts.includes("daily")) {
          if (pick.daily) applyDays(newState, bak, days);
          else DAILY_KEYS.forEach((k) => { newState[k] = bak[k] !== undefined ? bak[k] : {}; });
        }
        if (parts.includes("deviations")) newState.deviations = newDevs;
        const maxN = Math.max(0, ...((newState.deviations || []).filter(Boolean).map((x) => devNum(x.id))));
        newState.seq = Math.max(Number(newState.seq) || 1, Number(bak.seq) || 1, maxN + 1);
      }
      if (parts.includes("users")) {
        const have = await tableCols(c, "users"), haveAv = await tableCols(c, "user_avatars");
        const bAv = (d.tables.user_avatars && d.tables.user_avatars.rows) || [];
        if (pick.users) {
          for (const un of sel.users) {
            const b = bUsers.find((x) => lc(x.username) === lc(un));
            if (!b) continue;
            const ex = (await c.query("SELECT id, pw_hash FROM users WHERE lower(username) = lower($1)", [un])).rows[0];
            let id;
            if (ex) {
              const cols = Object.keys(b).filter((x) => have.has(x) && !["id", "created_at"].includes(x) && !(sel.keepPasswords && x === "pw_hash"));
              await c.query(`UPDATE users SET ${cols.map((x, i) => `"${x}" = $${i + 2}`).join(", ")} WHERE id = $1`, [ex.id].concat(cols.map((x) => b[x])));
              id = ex.id;
            } else {
              id = (await insertRow(c, "users", b, have, ["id"])).id;
            }
            await c.query("DELETE FROM user_avatars WHERE user_id = $1", [id]);
            const av = bAv.find((x) => String(x.user_id) === String(b.id));
            if (av) await insertRow(c, "user_avatars", Object.assign({}, av, { user_id: id }), haveAv);
          }
        } else {
          await replaceTable(c, "users", d.tables.users);
          await replaceTable(c, "user_avatars", d.tables.user_avatars);
          // wie beim Löschen eines Kontos: private Dashboards nicht mehr vorhandener Konten entfernen
          if (!parts.includes("dashboards")) {
            await c.query(`DELETE FROM dashboards d WHERE visibility = 'private'
              AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.name) = lower(d.owner))`);
          }
        }
        await c.query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM users), 1))");
        // Wer nicht (mehr) vorkommt oder gesperrt ist, wird abgemeldet
        await c.query(`DELETE FROM sessions s WHERE NOT s.demo AND NOT EXISTS
          (SELECT 1 FROM users u WHERE lower(u.name) = lower(s.user_name) AND NOT u.disabled)`);
        changed.push("users");
      }
      if (parts.includes("dashboards")) {
        if (pick.dashboards) {
          const have = await tableCols(c, "dashboards");
          for (const id of sel.dashboards) {
            const b = bDash.find((x) => x.id === id);
            if (!b) continue;
            await c.query("DELETE FROM dashboards WHERE id = $1", [id]);
            await insertRow(c, "dashboards", b, have);
          }
        } else {
          await replaceTable(c, "dashboards", d.tables.dashboards);
        }
        await require("./dashboards").migrate(c);   // fehlende Standard-Dashboards ergänzen
      }
      await validateResult(c, newState, parts);
      if (newState) {
        await c.query("UPDATE documents SET value = $1::jsonb, updated_at = now(), updated_by = $2 WHERE name = 'state'", [JSON.stringify(newState), by || null]);
        changed.push("state");
      }
      if (parts.includes("settings")) {
        await c.query("UPDATE documents SET value = $1::jsonb, updated_at = now(), updated_by = $2 WHERE name = 'settings'", [JSON.stringify(d.settings), by || null]);
        changed.push("settings");
      }
      if (changed.length) await db.bumpRevision(c, changed, by || "Wiederherstellung");
    });
    console.log(`[backup] aus ${filename} wiederhergestellt: ${parts.join(", ")} (${plan.replaced} ersetzt, ${plan.added} neu, ${plan.removed} entfernt)`);
    return { full: false, parts, from: from || null, to: to || null, plan };
  } finally {
    busy = false;
  }
}

module.exports = {
  checkTools, tool: () => toolInfo, getConfig, setConfig, list, create, remove, restore, prune, inspect, restoreParts, parseCopyText, PARTS,
  resolveFile, startScheduler, smbStatus, syncSmb
};
