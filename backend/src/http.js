"use strict";
// Gemeinsame Bausteine für die API-Routen: Fehlerklasse, Rechteprüfung, async-Hilfe
const { verifyPassword, burn, fromPlain } = require("./passwords");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Fehler aus async-Handlern an den Fehler-Handler weiterreichen
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireUser(req) {
  if (!req.user) {
    throw new HttpError(401, req.sessionExpired ? "Sitzung abgelaufen — bitte erneut anmelden." : "Bitte zuerst anmelden.");
  }
}
function requireEdit(req) {
  requireUser(req);
  if (!["admin", "manager", "editor"].includes(req.user.perm)) {
    throw new HttpError(403, "Nur Leserechte — Änderung nicht gespeichert.");
  }
}
function requireAdmin(req) {
  requireUser(req);
  if (req.user.perm !== "admin") throw new HttpError(403, "Nur für Administratoren.");
}
// Teamleitung und Administration: Stammdaten und Benutzerverwaltung
function requireManager(req) {
  requireUser(req);
  if (req.user.perm !== "admin" && req.user.perm !== "manager") {
    throw new HttpError(403, "Nur für Teamleitung und Administration.");
  }
}
// Die Teamleitung darf Administrator-Konten weder ändern noch vergeben
function guardAdminAccount(req, targetPerm, newPerm) {
  if (req.user.perm === "admin") return;
  if (targetPerm === "admin") throw new HttpError(403, "Administrator-Konten können nur Administratoren ändern.");
  if (newPerm === "admin") throw new HttpError(403, "Die Berechtigung „Administrator“ können nur Administratoren vergeben.");
}

function publicUser(u) {
  return u ? { name: u.name, username: u.username || "", role: u.role, perm: u.perm, demo: !!u.demo } : null;
}

// Passwort eines Kontos prüfen; ohne Konto/Hash trotzdem gleich lange rechnen (kein Timing-Hinweis)
async function passwordMatches(row, plain) {
  const h = fromPlain(plain);
  return row && row.pw_hash && h ? verifyPassword(h, row.pw_hash) : burn(h);
}

module.exports = { HttpError, wrap, requireUser, requireEdit, requireAdmin, requireManager, guardAdminAccount, publicUser, passwordMatches };
