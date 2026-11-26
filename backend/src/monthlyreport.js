"use strict";
// Monatsbericht per E-Mail: der Server berechnet aus den gespeicherten Tageswerten eine Übersicht des
// Vormonats (Kennzahlen, SQIDP-Grünquote, Produktion, Ausfälle, Sicherheit, Maßnahmen) und schickt sie
// automatisch an einen Verteiler. Die Formeln entsprechen denen der Oberfläche (frontend/index.html:
// oeeAvailability, periodRatio, outageTotal …) — bei Änderungen dort hier mitziehen.
// Einstellungen und Versandstatus liegen in meta („monthly_report“).
const config = require("./config");
const db = require("./db");
const mailer = require("./mailer");
const templates = require("./mailtemplates");
const { HttpError } = require("./http");

const META_KEY = "monthly_report";
const MAX_RECIPIENTS = 30;
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const CATS = [
  { key: "S", letter: "S", name: "Sicherheit" }, { key: "Q", letter: "Q", name: "Qualität" },
  { key: "C", letter: "I", name: "Inventory" }, { key: "D", letter: "D", name: "Lieferung" },
  { key: "P", letter: "P", name: "Produktivität" }
];
const OUTAGE_KINDS = [
  { k: "pers", label: "Personen-Ausfälle" }, { k: "tech", label: "Technische Ausfälle" },
  { k: "orga", label: "Organisatorische Ausfälle" }, { k: "ruest", label: "Rüst- und Handhabungszeiten" }
];
const DEFAULTS = { enabled: false, day: 1, time: "07:00", recipients: [], last: null };

/* ---------- Rechenregeln (wie in der Oberfläche) ---------- */
function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

function outageTotal(rec, g) {
  if (!rec) return null;
  const keys = OUTAGE_KINDS.map((o) => `ausfall${g}_${o.k}`);
  if (keys.some((k) => num(rec[k]) != null)) {
    return Math.round(keys.reduce((s, k) => s + (num(rec[k]) || 0), 0) * 100) / 100;
  }
  return num(rec[g === "U" ? "ausfall" : "ausfallGeplant"]);
}
function availability(rec, shift) {
  const u = outageTotal(rec, "U"), g = outageTotal(rec, "G");
  if (!shift || u == null || g == null) return null;
  const planned = shift - g;
  if (planned <= 0) return null;
  return Math.max(0, Math.min(100, (planned - u) / planned * 100));
}
function performance(rec) {
  const g = num(rec && rec.geplant), p = num(rec && rec.produziert);
  return g == null || p == null || g <= 0 ? null : Math.max(0, p / g * 100);
}
function quality(rec) {
  const p = num(rec && rec.produziert), a = num(rec && rec.ausschuss);
  return p == null || a == null || p <= 0 ? null : Math.max(0, Math.min(100, (p - a) / p * 100));
}
function oee(rec, shift) {
  const v = availability(rec, shift), l = performance(rec), q = quality(rec);
  return v == null || l == null || q == null ? null : v * l * q / 10000;
}
// Quoten aus Summen über den Zeitraum (periodRatio der Oberfläche)
const RATIO_PARTS = {
  leist: ["produziert", [], "geplant"],
  qual: ["produziert", ["ausschuss"], "produziert"],
  fpy: ["produziert", ["ausschuss"], "produziert", ["nacharbeit"]],
  otd: ["auftraegePuenktlich", [], "auftraegeFaellig"]
};
function periodRatio(kind, recs) {
  const p = RATIO_PARTS[kind];
  let n = 0, d = 0;
  recs.forEach((rec) => {
    const a = num(rec[p[0]]), den = num(rec[p[2]]);
    let minus = 0;
    for (const k of p[1]) { const mv = num(rec[k]); if (mv == null) { minus = null; break; } minus += mv; }
    if (a == null || minus == null || den == null || den <= 0) return;
    (p[3] || []).forEach((k) => { minus += num(rec[k]) || 0; });
    n += a - minus; d += den;
  });
  if (d <= 0) return null;
  const pct = n / d * 100;
  return kind === "leist" ? Math.max(0, pct) : Math.max(0, Math.min(100, pct));
}
function avgOf(vals) {
  const v = vals.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function sumOf(recs, key) {
  let s = 0, any = false;
  recs.forEach((r) => { const v = num(r[key]); if (v != null) { s += v; any = true; } });
  return any ? s : null;
}

// Übersicht eines Monats (y, m = 0–11) aus den Dokumenten state und settings
function compute(state, settings, y, m, now = new Date()) {
  state = state || {}; settings = settings || {};
  const shift = num(settings.shiftHours) || 24;
  const targets = Object.assign({ oee: 85, fpy: 96, otd: 95 }, settings.targets || {});
  const limits = Object.assign({ scrapPct: 2, outageHours: 1.5 }, settings.limits || {});
  const daily = state.dailyData || {};
  const n = daysIn(y, m);
  const isos = Array.from({ length: n }, (_, i) => isoOf(y, m, i + 1));
  const recs = isos.map((iso) => daily[iso]).filter((r) => r && typeof r === "object");

  const kpi = (yy, mm) => {
    const list = Array.from({ length: daysIn(yy, mm) }, (_, i) => daily[isoOf(yy, mm, i + 1)]).filter((r) => r && typeof r === "object");
    return {
      oee: avgOf(list.map((r) => oee(r, shift))),
      avail: avgOf(list.map((r) => availability(r, shift))),
      perf: periodRatio("leist", list), qual: periodRatio("qual", list),
      fpy: periodRatio("fpy", list), otd: periodRatio("otd", list)
    };
  };
  const prevY = m === 0 ? y - 1 : y, prevM = m === 0 ? 11 : m - 1;

  // SQIDP-Board: grüne/rote Tage je Kategorie
  const board = (state.boards || {})[`${y}-${m + 1}`] || {};
  const sqidp = CATS.map((c) => {
    const col = board[c.key] || {};
    let ok = 0, nok = 0;
    for (let d = 1; d <= n; d++) { if (col[d] === "ok") ok++; else if (col[d] === "nok") nok++; }
    return { key: c.key, letter: c.letter, name: c.name, ok, nok, rate: ok + nok ? Math.round(ok * 100 / (ok + nok)) : null };
  });

  // Produktion und Ausfälle
  const outU = recs.map((r) => outageTotal(r, "U")).filter((v) => v != null);
  const outG = recs.map((r) => outageTotal(r, "G")).filter((v) => v != null);
  const kinds = OUTAGE_KINDS.map((o) => ({
    label: o.label,
    u: recs.reduce((s, r) => s + (num(r[`ausfallU_${o.k}`]) || 0), 0),
    g: recs.reduce((s, r) => s + (num(r[`ausfallG_${o.k}`]) || 0), 0)
  }));
  const produced = sumOf(recs, "produziert"), scrap = sumOf(recs, "ausschuss");
  const outUSum = outU.length ? outU.reduce((a, b) => a + b, 0) : null;
  const outUAvg = outU.length ? outUSum / outU.length : null;
  const scrapPct = scrap == null ? null : scrap <= 0 ? 0 : produced > 0 ? scrap * 100 / produced : null;
  const lastInv = [...isos].reverse().map((iso) => daily[iso]).find((r) => r && num(r.inventory) != null);

  // Sicherheit
  const log = state.safetyLog || {};
  const acc = Array.isArray(settings.safety && settings.safety.accidents) ? settings.safety.accidents : [];
  const safety = { near: 0, nonrep: 0, rep: 0 };
  isos.forEach((iso) => {
    let v = log[iso];
    if (!v) {
      const a = acc.filter((x) => x && x.date === iso);
      if (a.length) v = a.some((x) => x.reportable) ? "rep" : "nonrep";
    }
    if (v && safety[v] != null) safety[v]++;
  });
  const sf = settings.safety || {};
  const base = sf.lastAccident || sf.countSince || "";
  const endOfMonth = new Date(y, m, n);
  const ref = endOfMonth < now ? endOfMonth : now;
  const safeDays = /^\d{4}-\d\d-\d\d$/.test(base)
    ? Math.max(0, Math.round((new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()) - new Date(base + "T00:00:00")) / 86400000))
    : null;

  // Maßnahmen
  const devs = Array.isArray(state.deviations) ? state.deviations : [];
  const monthPrefix = `${y}-${pad(m + 1)}`;
  const todayIso = isoOf(now.getFullYear(), now.getMonth(), now.getDate());
  const open = devs.filter((d) => d && d.phase !== "done");
  const created = devs.filter((d) => d && String(d.created || "").startsWith(monthPrefix));

  return {
    year: y, month: m, monthName: `${MONTHS[m]} ${y}`, daysRecorded: recs.length, daysInMonth: n,
    targets, limits, kpi: kpi(y, m), prev: kpi(prevY, prevM), prevName: `${MONTHS[prevM]} ${prevY}`,
    sqidp,
    production: {
      planned: sumOf(recs, "geplant"), produced, scrap, scrapPct, rework: sumOf(recs, "nacharbeit"),
      invoiced: sumOf(recs, "faktoriert"),
      inventory: lastInv ? num(lastInv.inventory) : null, inventoryLimit: lastInv ? num(lastInv.inventoryGrenzwert) : null
    },
    outages: { unplanned: outUSum, unplannedAvg: outUAvg, planned: outG.length ? outG.reduce((a, b) => a + b, 0) : null, kinds },
    safety: Object.assign(safety, { safeDays, base: sf.lastAccident ? "accident" : base ? "start" : null }),
    actions: {
      createdInMonth: created.length,
      createdByCat: CATS.map((c) => ({ letter: c.letter, n: created.filter((d) => d.cat === c.key).length })),
      open: open.length,
      overdue: open.filter((d) => d.due && d.due < todayIso).length,
      overdueList: open.filter((d) => d.due && d.due < todayIso).slice(0, 8).map((d) => ({ title: d.title || "Abweichung", owner: d.owner || "", due: d.due, cat: (CATS.find((c) => c.key === d.cat) || {}).letter || "" }))
    }
  };
}

/* ---------- E-Mail ---------- */
const nf = (v, d = 1) => v == null ? "–" : new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const dfmt = (iso) => { const p = String(iso || "").split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : ""; };

function render(r, { lineName, url } = {}) {
  const e = templates.esc, F = templates.FONT, C = templates.C;
  const st = (v, target) => v == null ? "none" : v >= target ? "ok" : v >= target - 3 ? "warn" : "bad";
  const col = { ok: "#15803d", warn: "#b45309", bad: "#b91c1c", none: C.muted };
  const bg = { ok: "#f0fdf4", warn: "#fffbeb", bad: "#fef2f2", none: "#f9fafb" };
  const delta = (cur, prev) => cur == null || prev == null ? "" : `${cur - prev >= 0 ? "▲" : "▼"} ${nf(Math.abs(cur - prev), 1)} Pp. ggü. ${r.prevName}`;
  const tile = (label, v, target, prev) => {
    const s = st(v, target);
    return `<td width="33%" valign="top" style="padding:4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg[s]};border:1px solid ${C.line};border-top:4px solid ${col[s]};border-radius:8px;">
        <tr><td style="padding:12px 12px 10px;">
          <div style="font:600 12px/1.3 ${F};color:${C.muted};">${e(label)}</div>
          <div style="font:700 24px/1.2 ${F};color:${col[s]};margin-top:4px;">${v == null ? "–" : nf(v, 1) + " %"}</div>
          <div style="font:12px/1.4 ${F};color:${C.muted};margin-top:2px;">Ziel ${nf(target, 0)} %</div>
          <div style="font:11px/1.4 ${F};color:${C.muted};">${e(delta(v, prev))}</div>
        </td></tr></table></td>`;
  };
  const h2 = (t) => `<h2 style="margin:24px 0 10px;font:700 16px/1.3 ${F};color:${C.ink};">${e(t)}</h2>`;
  const rows = (list) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:8px;margin:0 0 8px;">
    ${list.map(([k, v, c], i) => `<tr>
      <td style="padding:9px 12px;font:13px/1.4 ${F};color:${C.muted};${i ? `border-top:1px solid ${C.line};` : ""}">${e(k)}</td>
      <td align="right" style="padding:9px 12px;font:600 13px/1.4 ${F};color:${c || C.ink};${i ? `border-top:1px solid ${C.line};` : ""}">${e(v)}</td></tr>`).join("")}
  </table>`;
  const k = r.kpi, p = r.prev, pr = r.production, o = r.outages, s = r.safety, a = r.actions;
  const scrapCol = pr.scrapPct == null || pr.scrapPct <= 0 ? null : pr.scrapPct > r.limits.scrapPct ? col.bad : col.warn;
  const outCol = o.unplannedAvg == null || o.unplannedAvg <= 0 ? null : o.unplannedAvg > r.limits.outageHours ? col.bad : col.warn;

  const sqidpTable = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:8px;">
    <tr>${["Kategorie", "grün", "rot", "Grünquote"].map((t, i) => `<td ${i ? 'align="right"' : ""} style="padding:8px 12px;font:600 12px/1.3 ${F};color:${C.muted};background:#f9fafb;">${t}</td>`).join("")}</tr>
    ${r.sqidp.map((c) => {
      const s2 = c.rate == null ? "none" : c.rate >= 80 ? "ok" : c.rate >= 60 ? "warn" : "bad";
      return `<tr>
        <td style="padding:8px 12px;border-top:1px solid ${C.line};font:13px/1.4 ${F};color:${C.ink};"><b>${c.letter}</b> · ${e(c.name)}</td>
        <td align="right" style="padding:8px 12px;border-top:1px solid ${C.line};font:13px/1.4 ${F};color:${col.ok};">${c.ok}</td>
        <td align="right" style="padding:8px 12px;border-top:1px solid ${C.line};font:13px/1.4 ${F};color:${col.bad};">${c.nok}</td>
        <td align="right" style="padding:8px 12px;border-top:1px solid ${C.line};font:700 13px/1.4 ${F};color:${col[s2]};">${c.rate == null ? "–" : c.rate + " %"}</td></tr>`;
    }).join("")}
  </table>`;

  const body = [
    `<p style="margin:0 0 16px;font:15px/1.6 ${F};color:${C.text};">Übersicht für <b>${e(r.monthName)}</b> — ${r.daysRecorded} von ${r.daysInMonth} Tagen mit erfassten Tageswerten.</p>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${tile("OEE", k.oee, r.targets.oee, p.oee)}${tile("First Pass Yield", k.fpy, r.targets.fpy, p.fpy)}${tile("Termintreue", k.otd, r.targets.otd, p.otd)}</tr></table>`,
    `<p style="margin:6px 4px 0;font:12px/1.5 ${F};color:${C.muted};">Verfügbarkeit ${nf(k.avail)} % · Leistung ${nf(k.perf)} % · Qualität ${nf(k.qual)} %</p>`,
    h2("SQIDP-Grünquote"), sqidpTable,
    h2("Produktion"),
    rows([
      ["Geplante Menge", pr.planned == null ? "–" : nf(pr.planned, 2) + " t"],
      ["Produzierte Menge", pr.produced == null ? "–" : nf(pr.produced, 2) + " t" + (pr.planned ? ` (${nf(pr.produced * 100 / pr.planned, 1)} % vom Plan)` : "")],
      ["Ausschuss", pr.scrap == null ? "–" : `${nf(pr.scrap, 2)} t · ${nf(pr.scrapPct, 2)} % (Toleranz ${nf(r.limits.scrapPct, 1)} %)`, scrapCol],
      ["Mit Nacharbeit verwendbar", pr.rework == null ? "–" : nf(pr.rework, 2) + " t"],
      ["Fakturierte Menge", pr.invoiced == null ? "–" : nf(pr.invoiced, 2) + " t"],
      ["Inventory (Monatsende)", pr.inventory == null ? "–" : nf(pr.inventory, 2) + " t" + (pr.inventoryLimit != null ? ` · Grenzwert ${nf(pr.inventoryLimit, 0)} t` : ""),
        pr.inventory != null && pr.inventoryLimit != null && pr.inventory > pr.inventoryLimit ? col.bad : null]
    ]),
    h2("Produktionsausfälle"),
    rows([
      ["Ungeplant gesamt", o.unplanned == null ? "–" : `${nf(o.unplanned)} h · Ø ${nf(o.unplannedAvg, 2)} h je Tag (Grenzwert ${nf(r.limits.outageHours, 1)} h)`, outCol],
      ["Geplant gesamt", o.planned == null ? "–" : nf(o.planned) + " h"]
    ].concat(o.kinds.filter((x) => x.u || x.g).map((x) => [x.label, `ungeplant ${nf(x.u)} h · geplant ${nf(x.g)} h`]))),
    h2("Arbeitssicherheit"),
    rows([
      ["Tage ohne meldepflichtigen Unfall", s.safeDays == null ? "nicht erfasst" : String(s.safeDays)],
      ["Meldepflichtige Unfälle", String(s.rep), s.rep ? col.bad : null],
      ["Nicht meldepflichtige Unfälle", String(s.nonrep), s.nonrep ? col.warn : null],
      ["Beinahe-Unfälle", String(s.near), s.near ? col.warn : null]
    ]),
    h2("Abweichungen & Maßnahmen"),
    rows([
      ["Im Monat angelegt", `${a.createdInMonth}` + (a.createdInMonth ? " (" + a.createdByCat.filter((x) => x.n).map((x) => `${x.letter} ${x.n}`).join(" · ") + ")" : "")],
      ["Offen (heute)", String(a.open)],
      ["Davon überfällig", String(a.overdue), a.overdue ? col.bad : null]
    ]),
    a.overdueList.length ? `<p style="margin:4px 0 0;font:13px/1.6 ${F};color:${C.text};">${a.overdueList.map((d) =>
      `<span style="color:${col.bad};">●</span> [${e(d.cat)}] ${e(d.title)}${d.owner ? " — " + e(d.owner) : ""} · fällig ${e(dfmt(d.due))}`).join("<br>")}</p>` : "",
    url ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 16px;"><tr><td bgcolor="${C.accent}" style="border-radius:8px;">
      <a href="${e(url)}" target="_blank" style="display:inline-block;padding:12px 22px;font:600 14px/1 ${F};color:#ffffff;text-decoration:none;border-radius:8px;">Board öffnen</a></td></tr></table>` : ""
  ].join("\n");

  const subject = `Monatsbericht ${lineName || "Shopfloor Board"} — ${r.monthName}`;
  const text = [
    `Monatsbericht ${lineName || ""} — ${r.monthName}`, `${r.daysRecorded} von ${r.daysInMonth} Tagen erfasst`, "",
    `OEE ${nf(k.oee)} % (Ziel ${nf(r.targets.oee, 0)} %) · FPY ${nf(k.fpy)} % (Ziel ${nf(r.targets.fpy, 0)} %) · Termintreue ${nf(k.otd)} % (Ziel ${nf(r.targets.otd, 0)} %)`,
    "", "SQIDP-Grünquote: " + r.sqidp.map((c) => `${c.letter} ${c.rate == null ? "–" : c.rate + " %"}`).join(" · "),
    "", `Produziert ${nf(pr.produced, 2)} t von ${nf(pr.planned, 2)} t geplant · Ausschuss ${nf(pr.scrap, 2)} t (${nf(pr.scrapPct, 2)} %) · Nacharbeit ${nf(pr.rework, 2)} t`,
    `Ungeplante Ausfälle ${nf(o.unplanned)} h (Ø ${nf(o.unplannedAvg, 2)} h je Tag) · geplant ${nf(o.planned)} h`,
    `Sicherheit: ${s.rep} meldepflichtig, ${s.nonrep} nicht meldepflichtig, ${s.near} Beinahe-Unfälle · ${s.safeDays == null ? "–" : s.safeDays} Tage unfallfrei`,
    `Maßnahmen: ${a.createdInMonth} im Monat angelegt · ${a.open} offen · ${a.overdue} überfällig`,
    url ? `\nBoard: ${url}` : ""
  ].join("\n");
  const html = templates.layout({ title: subject, preheader: `OEE ${nf(k.oee)} % · FPY ${nf(k.fpy)} % · Termintreue ${nf(k.otd)} %`, heading: `Monatsbericht ${r.monthName}`, body, lineName });
  return { subject, text, html, attachments: templates.attachments() };
}

/* ---------- Einstellungen, Versand, Zeitplan ---------- */
async function getConfig() {
  return Object.assign({}, DEFAULTS, (await db.getMeta(META_KEY)) || {});
}
async function setConfig(body) {
  body = body || {};
  const cur = await getConfig();
  const day = Number(body.day), time = String(body.time || "");
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new HttpError(400, "Versandtag bitte zwischen 1 und 28 wählen.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "Uhrzeit bitte als HH:MM angeben.");
  if (!Array.isArray(body.recipients)) throw new HttpError(400, "Ungültige Empfängerliste.");
  const recipients = [...new Set(body.recipients.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
  if (recipients.length > MAX_RECIPIENTS) throw new HttpError(400, `Höchstens ${MAX_RECIPIENTS} Empfänger.`);
  const bad = recipients.find((x) => !mailer.EMAIL_RE.test(x) || x.length > 200);
  if (bad) throw new HttpError(400, `Ungültige E-Mail-Adresse: ${bad}`);
  const enabled = !!body.enabled;
  if (enabled && !recipients.length) throw new HttpError(400, "Für den automatischen Versand mindestens einen Empfänger eintragen.");
  const next = { enabled, day, time, recipients, last: cur.last || null };
  await db.setMeta(META_KEY, next);
  return next;
}
async function loadDocs() {
  const r = await db.pool.query("SELECT name, value FROM documents WHERE name IN ('state', 'settings')");
  const out = { state: null, settings: null };
  r.rows.forEach((row) => { out[row.name] = row.value; });
  return out;
}
function previousMonth(now = new Date()) {
  return now.getMonth() === 0 ? { y: now.getFullYear() - 1, m: 11 } : { y: now.getFullYear(), m: now.getMonth() - 1 };
}
function parseMonth(v) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(v || ""));
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return { y: +m[1], m: +m[2] - 1 };
}
async function build(ym) {
  const docs = await loadDocs();
  const r = compute(docs.state, docs.settings, ym.y, ym.m);
  const lineName = (docs.settings && docs.settings.lineName) || "";
  return render(r, { lineName, url: config.publicUrl || "" });
}
// Versand an den Verteiler (oder an `to`); merkt sich das Ergebnis
async function send(ym, { to, by, auto } = {}) {
  const cfg = await getConfig();
  const list = to && to.length ? to : cfg.recipients;
  if (!list.length) throw new HttpError(400, "Kein Empfänger eingetragen.");
  if (!(await mailer.isConfigured())) throw new HttpError(400, "Der E-Mail-Versand ist nicht eingerichtet (Einstellungen → E-Mail-Versand).");
  const mail = await build(ym);
  const month = `${ym.y}-${pad(ym.m + 1)}`;
  const probe = !!(to && to.length);   // Probe an einzelne Adressen zählt nicht als Versand an den Verteiler
  const remember = async (last) => { if (!probe) await db.setMeta(META_KEY, Object.assign(await getConfig(), { last })); };
  try {
    await mailer.send({ to: list.join(", "), subject: mail.subject, text: mail.text, html: mail.html, attachments: mail.attachments });
    const last = { month, at: Date.now(), ok: true, to: list.length, auto: !!auto, by: by || null, probe };
    await remember(last);
    return last;
  } catch (err) {
    const last = { month, at: Date.now(), ok: false, error: String(err && err.message || err).slice(0, 300), to: list.length, auto: !!auto, by: by || null, probe };
    await remember(last);
    throw new HttpError(502, "Versand fehlgeschlagen: " + last.error);
  }
}
// Zeitplan: am eingestellten Tag ab der Uhrzeit den Vormonat senden; bei Fehlern stündlich erneut
async function tick(now = new Date()) {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg.recipients.length) return null;
  const [hh, mm] = cfg.time.split(":").map(Number);
  const due = new Date(now.getFullYear(), now.getMonth(), cfg.day, hh, mm);
  if (now < due) return null;
  const ym = previousMonth(now), month = `${ym.y}-${pad(ym.m + 1)}`;
  const last = cfg.last;
  if (last && last.month === month && (last.ok || now - last.at < 60 * 60 * 1000)) return null;
  try {
    const res = await send(ym, { auto: true });
    console.log(`[monatsbericht] ${month} an ${res.to} Empfänger gesendet`);
    return res;
  } catch (err) {
    console.error(`[monatsbericht] ${month} nicht gesendet: ${err.message}`);
    return null;
  }
}
function startScheduler() {
  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000).unref();
  setTimeout(() => { tick().catch(() => {}); }, 30 * 1000).unref();
}

module.exports = { compute, render, getConfig, setConfig, send, build, tick, startScheduler, previousMonth, parseMonth, META_KEY };
