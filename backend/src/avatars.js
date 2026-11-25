"use strict";
// Profilbilder: werden im Browser auf ein kleines Quadrat zugeschnitten und als Data-URL geschickt.
// Hier nur strenge Prüfung (Format, Größe, Dateikennung) und Ablage in user_avatars.
const { HttpError } = require("./http");

const MAX_BYTES = 200 * 1024;
const TYPES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP"
};

function parseDataUrl(v) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof v === "string" ? v : "");
  if (!m) throw new HttpError(400, "Bitte ein Bild als JPEG, PNG oder WebP senden.");
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw new HttpError(400, "Das Bild ist leer.");
  if (data.length > MAX_BYTES) throw new HttpError(413, "Das Bild ist zu groß (höchstens 200 KB).");
  if (!TYPES[m[1]](data)) throw new HttpError(400, "Die Datei ist kein gültiges Bild.");
  return { mime: m[1], data };
}

async function set(q, userId, image) {
  const { mime, data } = parseDataUrl(image);
  await q.query(
    `INSERT INTO user_avatars (user_id, mime, data, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`,
    [userId, mime, data]);
  return data.length;
}

async function remove(q, userId) {
  const r = await q.query("DELETE FROM user_avatars WHERE user_id = $1", [userId]);
  return r.rowCount > 0;
}

async function getByUsername(q, username) {
  const r = await q.query(
    `SELECT a.mime, a.data, a.updated_at FROM user_avatars a JOIN users u ON u.id = a.user_id
      WHERE lower(u.username) = lower($1)`, [String(username || "")]);
  return r.rows[0] || null;
}

module.exports = { parseDataUrl, set, remove, getByUsername, MAX_BYTES };
