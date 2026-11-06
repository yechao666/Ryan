import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '../../shared/src/constants.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..');
export const APP_ROOT = resolve(SERVER_ROOT, '..');

export interface Env {
  nodeEnv: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  webDist: string;
  demoMode: boolean;
  sessionTtlHours: number;
  mnemosBaseUrl: string;
  webhookMaxBytes: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const dataDir = process.env.HIVE_DATA_DIR ?? join(APP_ROOT, 'data');
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    host: process.env.HIVE_HOST ?? '127.0.0.1',
    port: num(process.env.HIVE_PORT ?? process.env.PORT, DEFAULT_SERVER_PORT),
    dataDir,
    dbPath: process.env.HIVE_DB_PATH ?? join(dataDir, 'hive.db'),
    webDist: process.env.HIVE_WEB_DIST ?? join(APP_ROOT, 'web', 'dist'),
    demoMode: process.env.HIVE_DEMO !== '0',
    sessionTtlHours: num(process.env.HIVE_SESSION_TTL_HOURS, 72),
    mnemosBaseUrl: process.env.MNEMOS_BASE_URL ?? 'http://127.0.0.1:4380',
    webhookMaxBytes: num(process.env.HIVE_WEBHOOK_MAX_BYTES, 1_048_576),
    ...overrides,
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
