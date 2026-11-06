"use strict";
// Verwaltung auf der Kommandozeile, z. B.:
//   docker compose exec -T api node src/cli.js create-admin "Max Muster" <<< "geheim"
//   docker compose exec api node src/cli.js reset-password "Max Muster"
//   docker compose exec api node src/cli.js list-users
//   docker compose exec api node src/cli.js backup "vor Update"
const readline = require("readline");
const db = require("./db");
const users = require("./users");
const backups = require("./backups");
const { sha256hex } = require("./passwords");

function readPassword(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => { data += d; });
      process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(prompt);
    rl._writeToOutput = () => {};          // Eingabe nicht anzeigen
    rl.question("", (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

async function askNewPassword() {
  const pw = await readPassword("Passwort: ");
  if (pw.length < 4) throw new Error("Das Passwort braucht mindestens 4 Zeichen.");
  if (process.stdin.isTTY) {
    const pw2 = await readPassword("Passwort wiederholen: ");
    if (pw !== pw2) throw new Error("Die Passwörter stimmen nicht überein.");
  }
  // Gleicher Hash wie im Browser: SHA-256 über das Passwort
  return sha256hex(pw);
}

const commands = {
  async "create-admin"(name, role) {
    if (!name) throw new Error("Aufruf: create-admin <Name> [Rolle]");
    const clientHash = await askNewPassword();
    await db.tx(async (c) => {
      await db.lockRevision(c);
      await users.createUser(c, { name, role: role || "Administration", perm: "admin", clientHash });
      await db.bumpRevision(c, ["users"], "cli");
    });
    console.log(`Administrator „${name}“ angelegt.`);
  },

  async "reset-password"(name) {
    if (!name) throw new Error("Aufruf: reset-password <Name>");
    if (!(await users.findByName(db.pool, name))) throw new Error(`Kein Konto „${name}“ gefunden.`);
    const clientHash = await askNewPassword();
    await users.setPassword(db.pool, name, clientHash);
    await db.pool.query("UPDATE users SET disabled = false WHERE lower(name) = lower($1)", [name]);
    console.log(`Passwort für „${name}“ gesetzt (Konto ist aktiv).`);
  },

  async "list-users"() {
    const r = await db.pool.query("SELECT name, role, perm, disabled, last_login, pw_hash IS NOT NULL AS has_pw FROM users ORDER BY position, id");
    if (!r.rows.length) { console.log("(keine Konten)"); return; }
    r.rows.forEach((u) => console.log(
      `${u.name.padEnd(28)} ${u.perm.padEnd(7)} ${u.disabled ? "gesperrt" : "aktiv   "} ${u.has_pw ? "" : "(kein Passwort) "}${u.role}`
    ));
  },

  async "count-users"() {
    console.log(await users.count(db.pool));
  },

  async backup(note) {
    await backups.checkTools();
    const r = await backups.create("manual", note || "per Kommandozeile");
    if (!r.ok) throw new Error("Sicherung fehlgeschlagen: " + r.error);
    console.log(r.filename);
  }
};

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!commands[cmd]) {
    console.error("Befehle: " + Object.keys(commands).join(", "));
    process.exit(2);
  }
  try {
    await db.waitForDb(5);
    await db.migrate();
    await commands[cmd](...args);
    await db.pool.end();
  } catch (err) {
    console.error("Fehler: " + err.message);
    process.exit(1);
  }
})();
