"use strict";
// Die Oberfläche schickt nie das Klartext-Passwort, sondern SHA-256(Passwort) als Hex.
// Ohne sicheren Kontext (HTTP im LAN statt HTTPS/localhost) kann der Browser kein
// SHA-256 rechnen und schickt "plain:<Passwort>" — das gleichen wir hier an.
// Gespeichert wird zusätzlich gesalzen mit scrypt, nie der Client-Hash selbst.
const crypto = require("crypto");
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

module.exports = { sha256hex, normalizeClientHash, hashPassword, verifyPassword, burn };
