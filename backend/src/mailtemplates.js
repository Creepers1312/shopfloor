"use strict";
// HTML-Vorlagen für E-Mails des Servers. Jede Mail hat zusätzlich eine Textfassung für
// Programme ohne HTML. Aufbau mit Tabellen und Inline-Styles, damit auch Outlook die
// Mails ordentlich darstellt; das Logo hängt als eingebettetes Bild (cid) an.
const fs = require("fs");
const path = require("path");

const LOGO_FILE = path.join(__dirname, "..", "assets", "mail-logo.png");
const LOGO_CID = "logo@shopfloor-board";
let logo = null;
try { logo = fs.readFileSync(LOGO_FILE); } catch (e) { /* ohne Logo */ }

const C = {
  accent: "#2563eb", ink: "#111827", text: "#374151", muted: "#6b7280",
  line: "#e5e7eb", bg: "#f3f4f6", card: "#ffffff", note: "#eff6ff", noteText: "#1e3a8a",
  warnBg: "#fffbeb", warnText: "#92400e"
};
const FONT = "'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(d) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short", timeZone: process.env.TZ || "Europe/Berlin" }).format(d);
}

// Bausteine
const p = (html) => `<p style="margin:0 0 16px;font:15px/1.6 ${FONT};color:${C.text};">${html}</p>`;
const button = (label, url) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
  <tr><td bgcolor="${C.accent}" style="border-radius:8px;">
    <a href="${esc(url)}" target="_blank" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px;">${esc(label)}</a>
  </td></tr>
</table>`;
const box = (html, warn) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
  <tr><td style="background:${warn ? C.warnBg : C.note};border-radius:8px;padding:12px 16px;font:14px/1.55 ${FONT};color:${warn ? C.warnText : C.noteText};">${html}</td></tr>
</table>`;
const facts = (rows) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${C.line};border-radius:8px;">
  ${rows.map(([k, v], i) => `<tr>
    <td style="padding:10px 14px;font:13px/1.4 ${FONT};color:${C.muted};width:38%;${i ? `border-top:1px solid ${C.line};` : ""}">${esc(k)}</td>
    <td style="padding:10px 14px;font:600 13px/1.4 ${FONT};color:${C.ink};${i ? `border-top:1px solid ${C.line};` : ""}">${esc(v)}</td>
  </tr>`).join("")}
</table>`;

// Rahmen jeder Mail: Kopf mit Logo und Linie, Karte mit Inhalt, Fußzeile
function layout({ title, preheader, heading, body, lineName }) {
  const brand = esc(lineName ? `Shopfloor Board · ${lineName}` : "Shopfloor Board");
  const logoImg = logo
    ? `<img src="cid:${LOGO_CID}" width="40" height="40" alt="" style="display:block;border:0;border-radius:8px;">`
    : "";
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
      <tr><td style="padding:0 4px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          ${logoImg ? `<td style="padding-right:12px;">${logoImg}</td>` : ""}
          <td style="font:600 15px/1.3 ${FONT};color:${C.ink};">${brand}<br><span style="font-weight:400;font-size:13px;color:${C.muted};">Digitales Shopfloor Management</span></td>
        </tr></table>
      </td></tr>
      <tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:12px;padding:32px 32px 16px;">
        <h1 style="margin:0 0 20px;font:700 22px/1.3 ${FONT};color:${C.ink};">${esc(heading)}</h1>
        ${body}
      </td></tr>
      <tr><td style="padding:16px 4px 0;font:12px/1.6 ${FONT};color:${C.muted};">
        Diese E-Mail wurde automatisch vom ${brand} versendet.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function attachments() {
  return logo ? [{ filename: "logo.png", content: logo, cid: LOGO_CID, contentType: "image/png" }] : [];
}

// „Passwort vergessen“: Link zum Zurücksetzen
function passwordReset({ name, username, link, minutes, lineName, requestedAt = new Date() }) {
  const subject = "Shopfloor Board: neues Passwort vergeben";
  const text = [
    `Hallo ${name},`,
    "",
    "für Ihr Konto im Shopfloor Board wurde ein neues Passwort angefordert.",
    `Über diesen Link vergeben Sie ein neues Passwort (gültig ${minutes} Minuten, nur einmal nutzbar):`,
    "",
    link,
    "",
    username ? `Ihr Anmeldename: ${username}` : "",
    "",
    "Haben Sie das nicht selbst angefordert, ignorieren Sie diese E-Mail — Ihr bisheriges Passwort bleibt gültig.",
    "",
    "— Shopfloor Board"
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  const body = [
    p(`Hallo ${esc(name)},`),
    p("für Ihr Konto im Shopfloor Board wurde ein neues Passwort angefordert. Über den Knopf vergeben Sie ein neues:"),
    button("Neues Passwort vergeben", link),
    box(`Der Link gilt <strong>${esc(minutes)} Minuten</strong> und funktioniert nur einmal. Danach werden Sie auf allen Geräten abgemeldet und melden sich mit dem neuen Passwort an.`),
    facts([
      ...(username ? [["Anmeldename", username]] : []),
      ["Angefordert am", fmtDate(requestedAt)]
    ]),
    box("Haben Sie das nicht selbst angefordert? Dann ignorieren Sie diese E-Mail — Ihr bisheriges Passwort bleibt gültig.", true),
    `<p style="margin:0 0 16px;font:12px/1.6 ${FONT};color:${C.muted};">Funktioniert der Knopf nicht, kopieren Sie diese Adresse in den Browser:<br>
      <a href="${esc(link)}" style="color:${C.accent};word-break:break-all;">${esc(link)}</a></p>`
  ].join("\n");
  return {
    subject, text,
    html: layout({ title: subject, preheader: `Neues Passwort vergeben — Link gültig ${minutes} Minuten`, heading: "Neues Passwort vergeben", body, lineName }),
    attachments: attachments()
  };
}

// Test-E-Mail aus den Einstellungen bzw. von der Kommandozeile
function testMail({ lineName, host, port, by, sentAt = new Date() }) {
  const subject = "Shopfloor Board: Test-E-Mail";
  const rows = [
    ["Mailserver", host ? `${host}:${port}` : "—"],
    ["Gesendet am", fmtDate(sentAt)],
    ...(by ? [["Ausgelöst von", by]] : [])
  ];
  const text = [
    "Diese Test-E-Mail kommt vom Shopfloor Board. Der E-Mail-Versand funktioniert.",
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "— Shopfloor Board"
  ].join("\n");
  const body = [
    p("diese Nachricht kommt vom Shopfloor Board. Wenn Sie sie lesen, stimmen Mailserver, Anmeldung und Absender."),
    box("&#10003;&nbsp; Der E-Mail-Versand funktioniert. „Passwort vergessen“ verschickt seine Links ab jetzt über diesen Weg."),
    facts(rows)
  ].join("\n");
  return {
    subject, text,
    html: layout({ title: subject, preheader: "Der E-Mail-Versand des Shopfloor Boards funktioniert.", heading: "Test-E-Mail", body: p("Hallo,") + body, lineName }),
    attachments: attachments()
  };
}

module.exports = { passwordReset, testMail, layout, esc };
