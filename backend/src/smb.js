"use strict";
// Kopie der Sicherungen auf eine SMB-Freigabe (Windows-Server, NAS) über smbclient.
// Eingestellt wird in der Oberfläche; das Passwort liegt AES-256-GCM-verschlüsselt in der
// Tabelle meta (die nicht in den Sicherungen steckt). Der Schlüssel kommt aus APP_SECRET.
// An smbclient geht das Passwort nur über eine Datei in /tmp (Rechte 600), nie über die
// Befehlszeile, und die Datei wird sofort wieder gelöscht.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const config = require("./config");
const db = require("./db");
const { HttpError } = require("./http");

const META_KEY = "backup_smb";
const PROTOCOLS = ["auto", "smb3", "smb2"];
const SHARE_RE = /^\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\/[^\/\\:*?"<>|\x00-\x1f]+(\/[^\/\\:*?"<>|\x00-\x1f]+)*$/;
const FILE_RE = config.backupFileRe;
const TIMEOUT_MS = 10 * 60 * 1000;

const secrets = require("./secrets");
const encrypt = (t) => secrets.encrypt("smb", t);
const decrypt = (b) => secrets.decrypt("smb", b);

/* ---------- Einstellungen ---------- */
function normShare(v) {
  let s = String(v || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (s && !s.startsWith("//")) s = "//" + s.replace(/^\/+/, "");
  return s;
}
function cleanField(v, label, max) {
  const s = String(v || "").trim();
  if (s.length > max || /[\r\n\x00]/.test(s)) throw new HttpError(400, `${label} ist ungültig.`);
  return s;
}

async function getRaw(q) {
  const v = await db.getMeta(META_KEY, q);
  return Object.assign({ enabled: false, share: "", user: "", domain: "", protocol: "auto", keep: 30, password: "" }, v || {});
}

function toClient(raw) {
  return {
    enabled: !!raw.enabled,
    share: raw.share,
    user: raw.user,
    domain: raw.domain,
    protocol: raw.protocol,
    keep: raw.keep,
    hasPassword: !!raw.password,
    passwordUnreadable: !!raw.password && decrypt(raw.password) === null
  };
}

async function getConfig() { return toClient(await getRaw()); }

// Werte aus dem Formular prüfen; leeres Passwort = gespeichertes behalten
function merge(raw, body) {
  const next = Object.assign({}, raw);
  if (body.enabled !== undefined) next.enabled = !!body.enabled;
  if (body.share !== undefined) {
    next.share = normShare(body.share);
    if (next.share && !SHARE_RE.test(next.share)) {
      throw new HttpError(400, "Freigabe bitte als //server/freigabe oder //server/freigabe/ordner angeben.");
    }
  }
  if (body.user !== undefined) next.user = cleanField(body.user, "Benutzer", 120);
  if (body.domain !== undefined) next.domain = cleanField(body.domain, "Domäne", 120);
  if (body.protocol !== undefined) {
    if (!PROTOCOLS.includes(body.protocol)) throw new HttpError(400, "Unbekannte SMB-Version.");
    next.protocol = body.protocol;
  }
  if (body.keep !== undefined) next.keep = config.parseInt(body.keep, raw.keep || 30, 1, 365);
  if (body.clearPassword) next.password = "";
  if (typeof body.password === "string" && body.password !== "") {
    if (body.password.length > 256 || /[\r\n\x00]/.test(body.password)) throw new HttpError(400, "Das Passwort ist ungültig.");
    next.password = encrypt(body.password);
  }
  if (next.enabled && !next.share) throw new HttpError(400, "Zum Einschalten bitte eine Freigabe angeben.");
  return next;
}

async function setConfig(body) {
  const before = await getRaw();
  const next = merge(before, body || {});
  await db.setMeta(META_KEY, next);
  const changed = ["enabled", "share", "user", "domain", "protocol", "keep"].filter((k) => before[k] !== next[k]);
  if (before.password !== next.password) changed.push("password");
  return { config: toClient(next), changed };
}

/* ---------- smbclient ---------- */
function splitShare(share) {
  const parts = share.replace(/^\/\//, "").split("/");
  return { service: "//" + parts[0] + "/" + parts[1], dir: parts.slice(2).join("/") };
}

// Häufige Fehlermeldungen von smbclient verständlich machen
function explain(out) {
  const t = String(out || "");
  const map = [
    [/NT_STATUS_LOGON_FAILURE|NT_STATUS_WRONG_PASSWORD|NT_STATUS_NO_SUCH_USER/, "Anmeldung abgelehnt — Benutzer, Passwort oder Domäne prüfen."],
    [/NT_STATUS_ACCOUNT_(LOCKED_OUT|DISABLED)/, "Das Konto an der Freigabe ist gesperrt oder deaktiviert."],
    [/NT_STATUS_BAD_NETWORK_NAME/, "Freigabe nicht gefunden — Name der Freigabe prüfen."],
    [/NT_STATUS_OBJECT_(PATH|NAME)_NOT_FOUND/, "Ordner auf der Freigabe nicht gefunden."],
    [/NT_STATUS_ACCESS_DENIED/, "Keine Berechtigung — der Benutzer braucht Schreib- und Löschrechte im Ordner."],
    [/NT_STATUS_DISK_FULL/, "Auf der Freigabe ist kein Platz mehr."],
    [/NT_STATUS_(HOST_UNREACHABLE|NETWORK_UNREACHABLE|IO_TIMEOUT|CONNECTION_REFUSED|CONNECTION_RESET)/, "Server nicht erreichbar (Netz, Firewall Port 445?)."],
    [/NT_STATUS_UNSUCCESSFUL|Connection to .* failed|NT_STATUS_INVALID_PARAMETER.*resolve|not known/i, "Server nicht erreichbar — Name oder Adresse prüfen."],
    [/NT_STATUS_NOT_SUPPORTED|protocol negotiation failed|NT_STATUS_INVALID_NETWORK_RESPONSE/, "SMB-Version passt nicht — andere Version wählen."],
    [/zeitüberschreitung|timeout/i, "Zeitüberschreitung bei der Verbindung."]
  ];
  for (const [re, msg] of map) if (re.test(t)) return msg;
  const nt = /NT_STATUS_[A-Z_]+/.exec(t);
  return nt ? "Fehler der Freigabe: " + nt[0] : (t.trim().split("\n").pop() || "unbekannter Fehler").slice(0, 200);
}

// smbclient -c "…" ausführen; liefert die Ausgabe oder wirft einen verständlichen Fehler
async function run(raw, commands, { allowFail = false } = {}) {
  if (!raw.share) throw new HttpError(400, "Keine Freigabe eingestellt.");
  const password = raw.password ? decrypt(raw.password) : "";
  if (raw.password && password === null) throw new HttpError(400, "Das gespeicherte Passwort lässt sich nicht mehr entschlüsseln (APP_SECRET geändert?) — bitte neu eingeben.");
  const { service, dir } = splitShare(raw.share);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "smb-"));
  const auth = path.join(tmp, "auth");
  const lines = raw.user ? [`username = ${raw.user}`, `password = ${password}`] : [];
  if (raw.user && raw.domain) lines.push(`domain = ${raw.domain}`);
  await fs.promises.writeFile(auth, lines.join("\n") + "\n", { mode: 0o600 });
  const args = [service, "-s", "/dev/null", "-t", "30",
    "--option=cache directory=" + tmp, "--option=lock directory=" + tmp,
    "--option=state directory=" + tmp, "--option=private dir=" + tmp,
    "--option=client use spnego principal=no"];
  if (raw.user) args.push("-A", auth); else args.push("-N");
  if (raw.protocol === "smb3") args.push("--option=client min protocol=SMB3");
  if (raw.protocol === "smb2") args.push("-m", "SMB2");
  if (dir) args.push("-D", dir);
  args.push("-c", commands.join("; "));
  try {
    const r = await new Promise((resolve) => {
      let out = "";
      let p;
      try {
        p = spawn(config.smbclient, args, { env: { PATH: process.env.PATH, HOME: tmp, LANG: "C" } });
      } catch (e) {
        return resolve({ code: -1, out: e.message });
      }
      const timer = setTimeout(() => { p.kill("SIGKILL"); out += "\nZeitüberschreitung"; }, TIMEOUT_MS);
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: out + "\n" + e.message }); });
      p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
    if (r.code === -1 && /ENOENT/.test(r.out)) throw new HttpError(500, "smbclient ist im Container nicht installiert.");
    const failed = r.code !== 0 || /NT_STATUS_(?!OK)[A-Z_]+/.test(r.out);
    if (failed && !allowFail) throw new HttpError(502, explain(r.out));
    return { out: r.out, failed };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Dateinamen der Sicherungen auf der Freigabe
async function listFiles(raw) {
  const { out } = await run(raw, ["ls shopfloor_*.dump"], { allowFail: true });
  if (/NT_STATUS_(?!NO_SUCH_FILE)[A-Z_]+/.test(out)) throw new HttpError(502, explain(out));
  const files = [];
  out.split("\n").forEach((line) => {
    const m = /^\s+(shopfloor_[0-9_-]+_(?:auto|manual)\.dump)\s+[A-Z]*\s+\d+\s/.exec(line);
    if (m) files.push(m[1]);
  });
  return files;
}

async function putFile(raw, localFile, name) {
  if (!FILE_RE.test(name)) throw new HttpError(400, "Ungültiger Dateiname.");
  const part = "." + name + ".part";
  // Erst unter Hilfsnamen hochladen und dann umbenennen — keine halben Dateien unter dem echten Namen
  await run(raw, [`put "${localFile}" "${part}"`, `rename "${part}" "${name}"`]);
}

async function deleteFile(raw, name) {
  if (!FILE_RE.test(name)) throw new HttpError(400, "Ungültiger Dateiname.");
  await run(raw, [`del "${name}"`]);
}

// Verbindung prüfen: anmelden, in den Ordner wechseln, Testdatei schreiben und löschen
async function test(body) {
  const raw = merge(await getRaw(), Object.assign({}, body || {}, { enabled: false }));
  const tmpFile = path.join(os.tmpdir(), "shopfloor-smb-test-" + crypto.randomBytes(4).toString("hex"));
  await fs.promises.writeFile(tmpFile, "Shopfloor Board – Verbindungstest " + new Date().toISOString() + "\n");
  try {
    // Fehlende Ordner unterhalb der Freigabe anlegen (Fehler „existiert schon“ sind egal)
    const { dir } = splitShare(raw.share);
    if (dir) {
      const steps = dir.split("/").map((_, i, a) => `mkdir "${a.slice(0, i + 1).join("/")}"`);
      await run(Object.assign({}, raw, { share: splitShare(raw.share).service }), steps, { allowFail: true });
    }
    const name = ".shopfloor-test-" + crypto.randomBytes(4).toString("hex");
    await run(raw, [`put "${tmpFile}" "${name}"`, `del "${name}"`]);
    const files = await listFiles(raw);
    return { ok: true, files: files.length };
  } finally {
    await fs.promises.unlink(tmpFile).catch(() => {});
  }
}

module.exports = { getRaw, getConfig, setConfig, test, listFiles, putFile, deleteFile };
