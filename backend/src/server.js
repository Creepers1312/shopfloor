"use strict";
const config = require("./config");
const db = require("./db");
const backups = require("./backups");
const sessions = require("./sessions");
const { createApp, loadDbVersion } = require("./app");

async function main() {
  console.log(`[api] Shopfloor Board API ${config.version} startet …`);
  if (!config.db.password) console.warn("[api] WARNUNG: DB_PASSWORD ist leer.");
  await db.waitForDb();
  await db.migrate();
  await loadDbVersion();
  const tool = await backups.checkTools();
  console.log(`[api] Datenbank bereit · pg_dump: ${tool.ok ? tool.info : "fehlt (" + tool.info + ")"}`);

  await sessions.purgeExpired();
  setInterval(sessions.purgeExpired, 60 * 60 * 1000).unref();
  backups.startScheduler();

  const server = createApp().listen(config.port, () => {
    console.log(`[api] lauscht auf Port ${config.port} · Registrierung: ${config.allowRegister ? "an" : "aus"} · Demo: ${config.allowDemo ? "an" : "aus"}`);
  });

  const shutdown = (sig) => {
    console.log(`[api] ${sig} empfangen — fahre herunter`);
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[api] Start fehlgeschlagen:", err);
  process.exit(1);
});
