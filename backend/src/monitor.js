"use strict";
// Status für Checkmk (Local Check). Ausgabe je Dienst eine Zeile:
//   <Status> "<Dienstname>" <Metriken> <Text>
// Status: 0 = OK, 1 = WARN, 2 = CRIT, 3 = UNKNOWN. Aufgerufen vom Skript, das deploy.sh
// im Agent-Verzeichnis ablegt (docker exec … node src/cli.js checkmk).
const fs = require("fs");
const config = require("./config");
const db = require("./db");
const backups = require("./backups");

const H = 3600;
const LIMITS = {
  backupWarnH: 26,    // tägliche Sicherung: einen Tag + Puffer
  backupCritH: 50,
  smbWarnH: 3,        // Abgleich läuft stündlich
  smbCritH: 26,
  diskWarnPct: 10,    // freier Platz im Sicherungsordner
  diskCritPct: 5
};

function ago(sec) {
  if (sec < 90) return "gerade eben";
  if (sec < 2 * H) return `vor ${Math.round(sec / 60)} min`;
  if (sec < 48 * H) return `vor ${Math.round(sec / H)} h`;
  return `vor ${Math.round(sec / 86400)} Tagen`;
}
function fmtBytes(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " kB";
}
// Checkmk verträgt keine Zeilenumbrüche und kein „|“ im Text
const clean = (t) => String(t).replace(/[\r\n|]+/g, " ").trim();
const line = (state, name, metrics, text) => `${state} "${name}" ${metrics.length ? metrics.join("|") : "-"} ${clean(text)}`;

async function backupService(name) {
  const now = Date.now() / 1000;
  const cfg = await backups.getConfig();
  const r = await db.pool.query("SELECT filename, created_at, ok, size_bytes, error FROM backups ORDER BY created_at DESC");
  const rows = r.rows;
  const okRows = rows.filter((b) => b.ok);
  const latest = rows[0];
  const lastOk = okRows[0];
  const metrics = [];
  const problems = [];
  let state = 0;
  const worse = (s, msg) => { state = Math.max(state, s); problems.push(msg + (s === 2 ? " (!!)" : " (!)")); };

  const info = [];
  if (!lastOk) {
    worse(2, "noch keine erfolgreiche Sicherung");
  } else {
    const age = Math.max(0, Math.round(now - new Date(lastOk.created_at).getTime() / 1000));
    const warn = cfg.enabled ? LIMITS.backupWarnH * H : "";
    const crit = cfg.enabled ? LIMITS.backupCritH * H : "";
    metrics.push(`age=${age};${warn};${crit};0`, `backup_size=${Number(lastOk.size_bytes)};;;0`, `backup_count=${okRows.length};;;0`);
    info.push(`letzte Sicherung ${ago(age)} (${lastOk.filename}, ${fmtBytes(Number(lastOk.size_bytes))})`, `${okRows.length} vorhanden`);
    if (cfg.enabled && age >= LIMITS.backupCritH * H) worse(2, `älter als ${LIMITS.backupCritH} h`);
    else if (cfg.enabled && age >= LIMITS.backupWarnH * H) worse(1, `älter als ${LIMITS.backupWarnH} h`);
    if (!fs.existsSync(require("path").join(config.backupDir, lastOk.filename))) worse(2, "Datei der letzten Sicherung fehlt");
  }
  if (latest && !latest.ok) worse(2, "letzter Versuch fehlgeschlagen: " + String(latest.error || "unbekannt").slice(0, 120));
  if (!cfg.enabled) worse(1, "automatische Sicherung ist ausgeschaltet");
  else info.push(`täglich ${cfg.time} Uhr`);

  try {
    const st = fs.statfsSync(config.backupDir);
    const pct = Math.round((st.bavail / st.blocks) * 1000) / 10;
    metrics.push(`fs_free_percent=${pct};${LIMITS.diskWarnPct};${LIMITS.diskCritPct};0;100`);
    info.push(`${pct} % frei im Sicherungsordner`);
    if (pct < LIMITS.diskCritPct) worse(2, "kaum Platz im Sicherungsordner");
    else if (pct < LIMITS.diskWarnPct) worse(1, "wenig Platz im Sicherungsordner");
  } catch (e) { /* Dateisystem nicht abfragbar — kein Fehler */ }

  return line(state, name, metrics, [problems.join(", "), info.join(", ")].filter(Boolean).join(" — "));
}

async function smbService(name) {
  const st = await backups.smbStatus();
  if (!st.enabled) return null;   // ausgeschaltet: Dienst verschwindet in Checkmk
  const now = Date.now() / 1000;
  const last = st.last;
  const okAt = await db.getMeta("backup_smb_ok_at");
  const metrics = [];
  let state = 0, text;
  if (!last) {
    state = 1;
    text = `${st.share}: noch nicht abgeglichen (!)`;
  } else if (!last.ok) {
    state = 2;
    text = `${st.share}: Abgleich fehlgeschlagen (!!) — ${last.error}` + (okAt ? `, zuletzt erfolgreich ${ago(now - okAt / 1000)}` : ", noch nie erfolgreich");
  } else {
    const age = Math.max(0, Math.round(now - last.at / 1000));
    metrics.push(`age=${age};${LIMITS.smbWarnH * H};${LIMITS.smbCritH * H};0`);
    if (age >= LIMITS.smbCritH * H) state = 2;
    else if (age >= LIMITS.smbWarnH * H) state = 1;
    text = `${st.share}: abgeglichen ${ago(age)}${state ? (state === 2 ? " (!!)" : " (!)") : ""}, ${last.copied} kopiert, ${last.removed} alte entfernt`;
  }
  if (okAt) metrics.push(`last_ok_age=${Math.max(0, Math.round(now - okAt / 1000))};;;0`);
  return line(state, name, metrics, text);
}

async function boardService(name) {
  const v = await db.pool.query("SHOW server_version");
  const u = await db.pool.query("SELECT count(*)::int AS n FROM users WHERE NOT disabled");
  const tool = await backups.checkTools();
  const state = tool.ok ? 0 : 2;
  return line(state, name, [`users=${u.rows[0].n};;;0`],
    `API und Datenbank erreichbar — Board ${config.version}, PostgreSQL ${v.rows[0].server_version}, ${u.rows[0].n} aktive Konten`
    + (tool.ok ? "" : ", pg_dump fehlt (!!)"));
}

// prefix: Dienstname-Präfix, z. B. „Shopfloor“ oder „Shopfloor linie2“
async function checkmk(prefix) {
  const p = prefix || "Shopfloor";
  const out = [await boardService(`${p} Board`), await backupService(`${p} Backup`)];
  const smb = await smbService(`${p} Backup SMB`);
  if (smb) out.push(smb);
  return out.join("\n");
}

module.exports = { checkmk, LIMITS };
