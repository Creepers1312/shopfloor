"use strict";
// E-Mail-Versand („Passwort vergessen“, Test-E-Mails). Eingestellt wird in der Oberfläche
// (Einstellungen → E-Mail-Versand); das Passwort liegt verschlüsselt in meta. Solange dort
// nichts gespeichert ist, gelten die SMTP_*-Werte aus der .env. Ohne Server und Absender ist
// der Versand aus — dann gehen Passwort-Anfragen an die Administration.
const nodemailer = require("nodemailer");
const config = require("./config");
const db = require("./db");
const secrets = require("./secrets");
const { HttpError } = require("./users");

const META_KEY = "mail_server";
const SECURITY = ["starttls", "tls", "none"];
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

let cached = { key: "", transport: null };

function fromEnv() {
  const s = config.smtp;
  // SMTP_FROM darf „Name <adresse>“ sein
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s.from || "");
  return {
    source: "env",
    host: s.host, port: s.port, security: s.security, user: s.user, password: s.password,
    fromName: m ? m[1].replace(/^"|"$/g, "") : "", fromAddress: m ? m[2] : (s.from || ""), replyTo: ""
  };
}

async function getRaw() {
  const v = await db.getMeta(META_KEY);
  return v ? Object.assign({ source: "db" }, v) : null;
}

// Wirksame Einstellungen inkl. entschlüsseltem Passwort (nur intern verwenden)
async function effective() {
  const raw = await getRaw();
  if (!raw) return fromEnv();
  const password = raw.password ? secrets.decrypt("smtp", raw.password) : "";
  return Object.assign({}, raw, { password: password === null ? "" : password, passwordUnreadable: password === null });
}

function fromHeader(c) {
  if (!c.fromAddress) return "";
  return c.fromName ? { name: c.fromName, address: c.fromAddress } : c.fromAddress;
}

async function isConfigured() {
  const c = await effective();
  return !!(c.host && c.fromAddress);
}

function makeTransport(c) {
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === "tls",          // TLS ab Verbindungsbeginn (meist Port 465)
    requireTLS: c.security === "starttls", // STARTTLS erzwingen (meist Port 587)
    ignoreTLS: c.security === "none",
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
}

async function getTransport(c) {
  c = c || await effective();
  if (!c.host || !c.fromAddress) return null;
  const key = JSON.stringify([c.host, c.port, c.security, c.user, c.password]);
  if (cached.key !== key) cached = { key, transport: makeTransport(c) };
  return cached.transport;
}

async function send(message, c) {
  c = c || await effective();
  const t = await getTransport(c);
  if (!t) throw new Error("E-Mail-Versand ist nicht eingerichtet");
  return t.sendMail(Object.assign({ from: fromHeader(c), replyTo: c.replyTo || undefined }, message));
}

async function sendPasswordReset(to, name, link, minutes) {
  const text = [
    `Hallo ${name},`,
    "",
    "für Ihr Konto im Shopfloor Board wurde ein neues Passwort angefordert.",
    `Über diesen Link vergeben Sie ein neues Passwort (gültig ${minutes} Minuten, nur einmal nutzbar):`,
    "",
    link,
    "",
    "Haben Sie das nicht selbst angefordert, ignorieren Sie diese E-Mail — Ihr bisheriges Passwort bleibt gültig.",
    "",
    "— Shopfloor Board"
  ].join("\n");
  await send({ to, subject: "Shopfloor Board: neues Passwort vergeben", text });
}

/* ---------- Einstellungen aus der Oberfläche ---------- */
function toClient(c) {
  return {
    source: c.source,               // "db" = in der Oberfläche gespeichert, "env" = aus der .env
    host: c.host || "", port: c.port || 587, security: c.security || "starttls",
    user: c.user || "", fromName: c.fromName || "", fromAddress: c.fromAddress || "", replyTo: c.replyTo || "",
    hasPassword: !!c.password || !!c.passwordUnreadable,
    passwordUnreadable: !!c.passwordUnreadable,
    enabled: !!(c.host && c.fromAddress)
  };
}

async function getConfig() { return toClient(await effective()); }

function text(v, label, max, re) {
  const s = String(v == null ? "" : v).trim();
  if (s.length > max || /[\r\n\x00]/.test(s) || (s && re && !re.test(s))) throw new HttpError(400, `${label} ist ungültig.`);
  return s;
}

// Formularwerte prüfen und mit dem bisherigen Stand zusammenführen (leeres Passwort = behalten)
async function merge(body) {
  const cur = await getRaw();
  const base = cur || Object.assign({}, fromEnv(), { password: "" });
  const next = {
    host: body.host !== undefined ? text(body.host, "Mailserver", 253, HOST_RE) : base.host,
    port: body.port !== undefined ? config.parseInt(body.port, 587, 1, 65535) : base.port,
    security: body.security !== undefined ? String(body.security).toLowerCase() : base.security,
    user: body.user !== undefined ? text(body.user, "Benutzer", 200) : base.user,
    fromName: body.fromName !== undefined ? text(body.fromName, "Absendername", 120).replace(/[<>"]/g, "") : base.fromName,
    fromAddress: body.fromAddress !== undefined ? text(body.fromAddress, "Absenderadresse", 254, EMAIL_RE) : base.fromAddress,
    replyTo: body.replyTo !== undefined ? text(body.replyTo, "Antwort-Adresse", 254, EMAIL_RE) : base.replyTo,
    password: cur ? cur.password : (base.password && base.source === "env" ? secrets.encrypt("smtp", base.password) : "")
  };
  if (!SECURITY.includes(next.security)) throw new HttpError(400, "Unbekannte Verschlüsselung.");
  if (next.host && !next.fromAddress) throw new HttpError(400, "Bitte eine Absenderadresse angeben.");
  if (body.clearPassword) next.password = "";
  if (typeof body.password === "string" && body.password !== "") {
    if (body.password.length > 256 || /[\r\n\x00]/.test(body.password)) throw new HttpError(400, "Das Passwort ist ungültig.");
    next.password = secrets.encrypt("smtp", body.password);
  }
  return { cur, next };
}

async function setConfig(body) {
  const { cur, next } = await merge(body || {});
  await db.setMeta(META_KEY, next);
  const before = cur || {};
  const changed = ["host", "port", "security", "user", "fromName", "fromAddress", "replyTo"].filter((k) => before[k] !== next[k]);
  if (before.password !== next.password) changed.push("password");
  return { config: await getConfig(), changed };
}

// Verständliche Meldungen für häufige Fehler
function explain(err) {
  const m = String((err && (err.response || err.message)) || err);
  const code = err && err.code;
  if (code === "EAUTH" || /535|authentication/i.test(m)) return "Anmeldung am Mailserver abgelehnt — Benutzer und Passwort prüfen.";
  if (code === "EDNS" || /ENOTFOUND|EAI_AGAIN/.test(m)) return "Mailserver nicht gefunden — Name prüfen.";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(m)) return "Verbindung abgelehnt — Port prüfen (587 STARTTLS, 465 TLS, 25 ohne).";
  if (code === "ETIMEDOUT" || code === "ESOCKET" && /timeout/i.test(m) || /timed? ?out/i.test(m)) return "Zeitüberschreitung — Server nicht erreichbar (Firewall, Port?).";
  if (/wrong version number|SSL routines|ssl3_get_record/i.test(m)) return "Verschlüsselung passt nicht zum Port — z. B. 465 mit TLS, 587 mit STARTTLS.";
  if (/STARTTLS/i.test(m)) return "Der Server bietet kein STARTTLS an — andere Verschlüsselung wählen.";
  if (/certificate|self.signed|UNABLE_TO_VERIFY/i.test(m)) return "Das Zertifikat des Mailservers ist nicht vertrauenswürdig.";
  if (/5\d\d/.test(m) && /sender|from|relay/i.test(m)) return "Der Server lehnt Absender oder Empfänger ab: " + m.slice(0, 160);
  return m.slice(0, 200);
}

// Verbindung prüfen (mit Formularwerten, ohne zu speichern) und optional eine Test-E-Mail senden
async function test(body, to) {
  const { next } = await merge(body || {});
  if (!next.host) throw new HttpError(400, "Bitte zuerst den Mailserver angeben.");
  const c = Object.assign({}, next, { password: next.password ? secrets.decrypt("smtp", next.password) || "" : "" });
  const t = makeTransport(c);
  try {
    await t.verify();
    const sent = [];
    if (to && to.length) {
      if (!c.fromAddress) throw new HttpError(400, "Bitte eine Absenderadresse angeben.");
      await t.sendMail({
        from: fromHeader(c), replyTo: c.replyTo || undefined, to,
        subject: "Shopfloor Board: Test-E-Mail",
        text: "Diese Test-E-Mail kommt vom Shopfloor Board. Der E-Mail-Versand funktioniert.\n\n— Shopfloor Board"
      });
      sent.push(...to);
    }
    return { ok: true, sent };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return { ok: false, error: explain(e) };
  } finally {
    t.close();
  }
}

// Kommandozeile: node src/cli.js mail-test <adresse>
async function verify() {
  const t = await getTransport();
  if (!t) throw new Error("Kein Mailserver und Absender eingestellt (Oberfläche oder SMTP_HOST/SMTP_FROM)");
  try { await t.verify(); } catch (e) { throw new Error(explain(e)); }
}

module.exports = { isConfigured, sendPasswordReset, send, verify, getConfig, setConfig, test, effective, EMAIL_RE };
