"use strict";
// Verwaltung auf der Kommandozeile, z. B.:
//   docker compose exec -T api node src/cli.js create-admin "Max Muster" [Rolle] [Anmeldename] [E-Mail] <<< "geheim"
//   docker compose exec api node src/cli.js mail-test it@firma.de
//   docker compose exec api node src/cli.js reset-password "Max Muster"
//   docker compose exec api node src/cli.js list-users
//   docker compose exec api node src/cli.js backup "vor Update"
const readline = require("readline");
const db = require("./db");
const users = require("./users");
const backups = require("./backups");
const sessions = require("./sessions");
const audit = require("./audit");
const { sha256hex, passwordProblem } = require("./passwords");

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

async function askNewPassword(name) {
  const pw = await readPassword("Passwort: ");
  const problem = passwordProblem(pw, name);
  if (problem) throw new Error(problem);
  if (process.stdin.isTTY) {
    const pw2 = await readPassword("Passwort wiederholen: ");
    if (pw !== pw2) throw new Error("Die Passwörter stimmen nicht überein.");
  }
  // Gespeicherte Form wie bei der Anmeldung: scrypt über SHA-256(Passwort)
  return sha256hex(pw);
}

const commands = {
  async "create-admin"(name, role, username, email) {
    if (!name) throw new Error("Aufruf: create-admin <Name> [Rolle] [Anmeldename] [E-Mail]");
    const clientHash = await askNewPassword(name);
    const row = await db.tx(async (c) => {
      await db.lockRevision(c);
      const created = await users.createUser(c, { name, username: username || undefined, email: email || undefined,
        role: role || "Administration", perm: "admin", clientHash });
      await db.bumpRevision(c, ["users"], "cli");
      return created;
    });
    await audit.log(null, "user.create", { name, perm: "admin", user: "Kommandozeile" });
    console.log(`Administrator „${name}“ angelegt (Anmeldename: ${row.username}).`);
  },

  async "reset-password"(name) {
    if (!name) throw new Error("Aufruf: reset-password <Name>");
    if (!(await users.findByName(db.pool, name))) throw new Error(`Kein Konto „${name}“ gefunden.`);
    const clientHash = await askNewPassword(name);
    await users.setPassword(db.pool, name, clientHash);
    await db.pool.query("UPDATE users SET disabled = false WHERE lower(name) = lower($1)", [name]);
    await db.pool.query("DELETE FROM reset_requests WHERE lower(user_name) = lower($1)", [name]);
    const ended = await sessions.destroyForUser(name, null);
    await audit.log(null, "user.password", { name, sessionsEnded: ended, user: "Kommandozeile" });
    console.log(`Passwort für „${name}“ gesetzt (Konto ist aktiv, ${ended} Sitzung(en) beendet).`);
  },

  async "list-users"() {
    const r = await db.pool.query("SELECT name, username, email, role, perm, disabled, last_login, pw_hash IS NOT NULL AS has_pw FROM users ORDER BY position, id");
    if (!r.rows.length) { console.log("(keine Konten)"); return; }
    r.rows.forEach((u) => console.log(
      `${u.name.padEnd(26)} ${String(u.username || "").padEnd(20)} ${String(u.email || "-").padEnd(30)} ${u.perm.padEnd(7)} ${u.disabled ? "gesperrt" : "aktiv   "} ${u.has_pw ? "" : "(kein Passwort) "}${u.role}`
    ));
  },

  // SMTP-Verbindung prüfen und optional eine Test-E-Mail senden
  async "mail-test"(to) {
    const mailer = require("./mailer");
    await mailer.verify();
    console.log("Verbindung zum Mailserver erfolgreich.");
    if (to) {
      await mailer.getTransport().sendMail({ from: require("./config").smtp.from, to,
        subject: "Shopfloor Board: Test-E-Mail", text: "Der E-Mail-Versand des Shopfloor Boards funktioniert." });
      console.log(`Test-E-Mail an ${to} gesendet.`);
    }
  },

  // Letzte Einträge des Sicherheitsprotokolls
  async audit(limit) {
    const entries = await audit.list({ limit: limit || 50 });
    if (!entries.length) { console.log("(keine Einträge)"); return; }
    entries.reverse().forEach((e) => {
      const t = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
      console.log(`${t}  ${String(e.user || "-").padEnd(20)} ${String(e.ip || "").padEnd(16)} ${e.action}${e.count > 1 ? " ×" + e.count : ""}  ${JSON.stringify(e.detail)}`);
    });
  },

  async "count-users"() {
    console.log(await users.count(db.pool));
  },

  async backup(note) {
    await backups.checkTools();
    const r = await backups.create("manual", note || "per Kommandozeile");
    if (!r.ok) throw new Error("Sicherung fehlgeschlagen: " + r.error);
    console.log(r.filename);
    await backups.syncSmb().catch(() => {});
  },

  // Verbindung zur SMB-Freigabe prüfen und fehlende Sicherungen kopieren (./deploy.sh smb)
  async "smb-sync"() {
    const st = await backups.smbStatus();
    if (!st.share) throw new Error("Keine Freigabe eingestellt (Einstellungen → Datenbank & Sicherung).");
    const t = await require("./smb").test({});
    console.log(`Verbindung zu ${st.share}: ok (${t.files} Sicherung(en) auf der Freigabe)`);
    if (!st.enabled) { console.log("Kopie ist ausgeschaltet — nichts kopiert."); return; }
    const r = await backups.syncSmb();
    if (!r.ok) throw new Error(r.error);
    console.log(`${r.copied} Sicherung(en) kopiert, ${r.removed} alte entfernt.`);
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
