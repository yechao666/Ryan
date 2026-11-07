import { join } from 'node:path';
import { ensureDir, loadEnv } from './env.ts';
import { closeDatabase, migrate, openDatabase, tableCount } from './db/index.ts';
import { EventBus } from './lib/bus.ts';
import { Router } from './http/router.ts';
import { createHttpServer } from './http/server.ts';
import { registerRoutes } from './http/routes/index.ts';
import { seedIfEmpty } from './seed/seed.ts';
import { startAutomationScheduler } from './runtime/scheduler.ts';

const env = loadEnv();
ensureDir(env.dataDir);
ensureDir(join(env.dataDir, 'backups'));
const db = openDatabase(env.dbPath);
migrate(db);
const bus = new EventBus();
const app = { db, env, bus, startedAt: new Date().toISOString() };

if (env.demoMode && tableCount(db, 'persons') === 0) {
  seedIfEmpty(db);
}

const router = new Router();
registerRoutes(router, app);
const stopScheduler = startAutomationScheduler(app);
const server = createHttpServer(app, router);
server.listen(env.port, env.host, () => {
  console.log(`[aiwo] listening http://${env.host}:${env.port} (demo=${env.demoMode})`);
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[aiwo] ${signal} received, shutting down`);
  stopScheduler();
  server.close(() => {
    closeDatabase(db);
    process.exit(0);
  });
  setTimeout(() => {
    closeDatabase(db);
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
