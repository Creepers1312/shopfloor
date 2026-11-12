"use strict";
// Verschlüsselung gespeicherter Zugangsdaten (SMB-, SMTP-Passwort) mit AES-256-GCM.
// Schlüssel: APP_SECRET aus der .env (erzeugt deploy.sh), je Zweck abgeleitet.
// Die Tabelle meta, in der die verschlüsselten Werte liegen, steckt nicht in den Sicherungen.
const crypto = require("crypto");
const config = require("./config");
const { HttpError } = require("./http");

function keyFor(purpose) {
  const secret = config.appSecret || config.db.password;
  if (!secret) throw new HttpError(500, "Kein Schlüssel für Zugangsdaten (APP_SECRET) gesetzt — ./deploy.sh ausführen.");
  return crypto.createHash("sha256").update(`shopfloor-${purpose}:` + secret).digest();
}

function encrypt(purpose, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor(purpose), iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

// null = nicht lesbar (anderer Schlüssel) → Passwort muss neu eingegeben werden
function decrypt(purpose, blob) {
  const [v, iv, tag, data] = String(blob || "").split(":");
  if (v !== "v1") return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", keyFor(purpose), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}

module.exports = { encrypt, decrypt };
