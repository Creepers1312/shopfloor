"use strict";
// Die Oberfläche schickt das Passwort über die (HTTPS-)Verbindung; nur so kann der Server
// Mindestlänge und Regeln prüfen. Gespeichert wird scrypt mit Salt über SHA-256(Passwort) —
// dieselbe Form wie zuvor, damit vorhandene Hashes gültig bleiben. Das Klartext-Passwort
// wird nirgends gespeichert oder protokolliert.
const crypto = require("crypto");
const config = require("./config");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

const N = 16384, R = 8, P = 1, KEYLEN = 32;

function sha256hex(txt) {
  return crypto.createHash("sha256").update(String(txt), "utf8").digest("hex");
}

function normalizeClientHash(h) {
  if (typeof h !== "string" || !h) return null;
  if (h.startsWith("plain:")) {
    const pw = h.slice(6);
    return pw ? sha256hex(pw) : null;
  }
  if (/^[0-9a-f]{64}$/i.test(h)) return h.toLowerCase();
  return null;
}

async function hashPassword(clientHash) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(clientHash, salt, KEYLEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(clientHash, stored) {
  if (!clientHash || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(clientHash, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p)
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Für Konten ohne Passwort: Laufzeit angleichen, damit man Namen nicht erraten kann
const DUMMY = hashPassword(sha256hex("dummy"));
async function burn(clientHash) {
  await verifyPassword(clientHash || "x", await DUMMY);
  return false;
}

// Neues Passwort prüfen; liefert eine Fehlermeldung oder null
function passwordProblem(pw, name) {
  if (typeof pw !== "string" || !pw) return "Bitte ein Passwort angeben.";
  if (pw.length < config.passwordMinLength) return `Das Passwort braucht mindestens ${config.passwordMinLength} Zeichen.`;
  if (pw.length > 200) return "Das Passwort ist zu lang (max. 200 Zeichen).";
  if (name && pw.trim().toLowerCase() === String(name).trim().toLowerCase()) return "Das Passwort darf nicht dem Namen entsprechen.";
  if (/^(.)\1+$/.test(pw)) return "Das Passwort darf nicht aus einem einzigen wiederholten Zeichen bestehen.";
  return null;
}
// Passwort aus einer Anfrage in die gespeicherte Form bringen (SHA-256-Hex)
function fromPlain(pw) { return typeof pw === "string" && pw ? sha256hex(pw) : null; }

module.exports = { sha256hex, normalizeClientHash, hashPassword, verifyPassword, burn, passwordProblem, fromPlain };
