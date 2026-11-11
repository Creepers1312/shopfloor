"use strict";
// Wird beim Bauen des Web-Images ausgeführt: berechnet die SHA-256-Hashes aller Inline-Skripte
// in index.html und schreibt daraus die Content-Security-Policy für Nginx.
// So laufen genau die mitgelieferten Skripte — eingeschleuster Code (XSS) wird blockiert,
// ohne dass bei jeder Änderung an index.html jemand Hashes von Hand pflegen muss.
//   node csp-hashes.js index.html shopfloor-csp.conf
const fs = require("fs");
const crypto = require("crypto");

const [, , input, output] = process.argv;
const html = fs.readFileSync(input, "utf8");
const hashes = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) {
  hashes.push("'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'");
}
if (!hashes.length) throw new Error("Keine Inline-Skripte in " + input + " gefunden");
if (/<script\s+[^>]*>/i.test(html.replace(/<script>/g, ""))) {
  throw new Error("Skript-Tags mit Attributen werden nicht unterstützt — bitte als <script> ohne Attribute einbinden");
}

const policy = [
  "default-src 'self'",
  "script-src 'self' " + hashes.join(" "),
  // Inline-Styles (style-Attribute, SVG) sind in der App üblich und ungefährlich
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join("; ");

fs.writeFileSync(output, `# erzeugt von csp-hashes.js — nicht von Hand ändern\nadd_header Content-Security-Policy "${policy}" always;\n`);
console.log(`CSP mit ${hashes.length} Skript-Hash(es) geschrieben: ${output}`);
