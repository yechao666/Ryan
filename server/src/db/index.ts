import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export type Db = DatabaseSync;
export const SCHEMA_VERSION = 5;

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

export function migrate(db: Db): void {
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  // v2：项目提示词（项目基本面，运行时 claim 时注入 DSH 提示词）。
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as unknown as { name: string }[];
  if (!projectColumns.some((column) => column.name === 'prompt')) {
    db.exec("ALTER TABLE projects ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
  }
  // v4：任务类型（控制台按类型筛选；旧库任务沿用默认值 feature）。
  const workItemColumns = db.prepare('PRAGMA table_info(work_items)').all() as unknown as { name: string }[];
  if (!workItemColumns.some((column) => column.name === 'type')) {
    db.exec("ALTER TABLE work_items ADD COLUMN type TEXT NOT NULL DEFAULT 'feature'");
  }
  // v5：每个任务独立 goal，不可续聊；历史任务补 /goal 前缀。
  db.exec("UPDATE work_items SET prompt = '/goal ' || prompt WHERE prompt <> '' AND prompt <> '/goal' AND prompt NOT LIKE '/goal %'");
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')").run();
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* noop */
    }
    throw error;
  }
}

export function tableCount(db: Db, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function getSchemaVersion(db: Db): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    /* noop */
  }
}
