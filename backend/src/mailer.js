"use strict";
// E-Mail-Versand (nur für „Passwort vergessen“). Zugangsdaten kommen aus der Umgebung
// (.env → docker-compose.yml), nie aus der Datenbank. Ohne SMTP_HOST/SMTP_FROM ist der
// Versand aus — dann gehen Passwort-Anfragen an die Administration.
const nodemailer = require("nodemailer");
const config = require("./config");

let transport = null;

function configured() {
  return !!(config.smtp.host && config.smtp.from);
}

function getTransport() {
  if (!configured()) return null;
  if (transport) return transport;
  const s = config.smtp;
  transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "tls",          // TLS ab Verbindungsbeginn (meist Port 465)
    requireTLS: s.security === "starttls", // STARTTLS erzwingen (meist Port 587)
    ignoreTLS: s.security === "none",
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  return transport;
}

async function sendPasswordReset(to, name, link, minutes) {
  const t = getTransport();
  if (!t) throw new Error("E-Mail-Versand ist nicht eingerichtet");
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
  await t.sendMail({
    from: config.smtp.from,
    to,
    subject: "Shopfloor Board: neues Passwort vergeben",
    text
  });
}

// Verbindung zum Mailserver prüfen (Kommandozeile: node src/cli.js mail-test <adresse>)
async function verify() {
  const t = getTransport();
  if (!t) throw new Error("SMTP_HOST und SMTP_FROM sind nicht gesetzt");
  await t.verify();
}

module.exports = { configured, sendPasswordReset, verify, getTransport };
