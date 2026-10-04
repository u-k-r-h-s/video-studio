import { createApp } from "./app";
import { loadConfig } from "./config";
import { createContainer } from "./container";
import { createLogger, setLogLevel } from "./lib/logger";

const config = loadConfig();
setLogLevel(config.logLevel);
const log = createLogger("server");

const c = createContainer(config);
await c.store.init();
await c.store.recoverInterrupted();

const app = createApp({ deps: c, allowedOrigins: config.server.allowedOrigins, port: config.server.port });
const server = app.listen(config.server.port, config.server.host, () => {
  log.info(`API listening on http://${config.server.host}:${config.server.port}`);
  log.info(`projects directory: ${config.projectsDir}`);
  void c.health.check().then((h) => {
    for (const [name, d] of Object.entries(h.services)) log[d.status === "ready" ? "info" : "warn"](`${name}: ${d.status} - ${d.message}`);
  });
});

// Never leave a heavy model resident when the server stops.
const shutdown = async (signal: string) => {
  log.info(`${signal}: shutting down`);
  server.close();
  await c.gate.unloadOllama().catch(() => {});
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
