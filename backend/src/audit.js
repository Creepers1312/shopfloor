"use strict";
// Sicherheitsprotokoll: wer hat wann von wo was getan.
// Häufige Speichervorgänge desselben Benutzers am selben Dokument werden innerhalb von
// 10 Minuten zu einem Eintrag zusammengefasst (Feld count), damit das Protokoll lesbar bleibt.
const config = require("./config");
const { pool } = require("./db");

const COALESCE = new Set(["document.save"]);

async function log(req, action, detail, q = pool) {
  const d = detail || {};
  const user = req && req.user ? req.user.name : (d.user || null);
  const ip = req ? req.ip : null;
  try {
    if (COALESCE.has(action)) {
      const r = await q.query(
        `UPDATE audit_log SET count = count + 1, at = now()
          WHERE id = (SELECT id FROM audit_log
                       WHERE action = $1 AND user_name IS NOT DISTINCT FROM $2 AND detail = $3::jsonb
                         AND at > now() - interval '10 minutes'
                       ORDER BY at DESC LIMIT 1)
          RETURNING id`,
        [action, user, JSON.stringify(d)]
      );
      if (r.rowCount) return;
    }
    await q.query("INSERT INTO audit_log (user_name, ip, action, detail) VALUES ($1, $2, $3, $4::jsonb)",
      [user, ip, action, JSON.stringify(d)]);
  } catch (err) {
    // Das Protokoll darf die eigentliche Aktion nie verhindern
    console.error("[audit] Eintrag fehlgeschlagen:", err.message);
  }
}

async function list({ limit = 200, before = null, action = null } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const params = [lim];
  const where = [];
  const b = parseInt(before, 10);
  if (Number.isFinite(b)) { params.push(b); where.push(`id < $${params.length}`); }
  if (action && /^[a-z.]+$/.test(action)) { params.push(action + "%"); where.push(`action LIKE $${params.length}`); }
  const r = await pool.query(
    `SELECT id, at, user_name, ip, action, detail, count FROM audit_log
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC LIMIT $1`, params);
  return r.rows.map((x) => ({
    id: Number(x.id), at: new Date(x.at).getTime(), user: x.user_name, ip: x.ip,
    action: x.action, detail: x.detail, count: x.count
  }));
}

async function purge() {
  await pool.query("DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)", [config.auditDays]).catch(() => {});
}

module.exports = { log, list, purge };
