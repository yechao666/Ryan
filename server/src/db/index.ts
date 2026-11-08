import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../lib/password.ts';
import { DEMO_PASSWORD } from '../../../shared/src/constants.ts';

const here = dirname(fileURLToPath(import.meta.url));
export type Db = DatabaseSync;
export const SCHEMA_VERSION = 15;

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
  db.exec('PRAGMA foreign_keys = ON;');
  // v1 -> v2：项目显式工作区目录；旧库补列，避免要求重建数据。
  const columns = db.prepare('PRAGMA table_info(projects)').all() as unknown as { name: string }[];
  if (!columns.some((column) => column.name === 'workspace_path')) {
    db.exec('ALTER TABLE projects ADD COLUMN workspace_path TEXT');
  }
  const taskColumns = db.prepare('PRAGMA table_info(work_items)').all() as unknown as { name: string }[];
  if (!taskColumns.some((column) => column.name === 'allowed_service_ids')) {
    db.exec("ALTER TABLE work_items ADD COLUMN allowed_service_ids TEXT NOT NULL DEFAULT '[]'");
  }
  const personColumns = db.prepare('PRAGMA table_info(persons)').all() as unknown as { name: string }[];
  if (!personColumns.some((column) => column.name === 'password_set')) {
    db.exec('ALTER TABLE persons ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1');
  }
  const instanceColumns = db.prepare('PRAGMA table_info(dsh_instances)').all() as unknown as { name: string }[];
  if (!instanceColumns.some((column) => column.name === 'workspace_root')) {
    db.exec("ALTER TABLE dsh_instances ADD COLUMN workspace_root TEXT NOT NULL DEFAULT ''");
  }
  const cardColumns = db.prepare('PRAGMA table_info(prompt_cards)').all() as unknown as { name: string }[];
  if (!cardColumns.some((column) => column.name === 'person_id')) {
    db.exec('ALTER TABLE prompt_cards ADD COLUMN person_id TEXT');
  }
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as unknown as { name: string }[];
  if (!projectColumns.some((column) => column.name === 'memory_dream_enabled')) {
    db.exec('ALTER TABLE projects ADD COLUMN memory_dream_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!projectColumns.some((column) => column.name === 'memory_dream_interval_minutes')) {
    db.exec('ALTER TABLE projects ADD COLUMN memory_dream_interval_minutes INTEGER NOT NULL DEFAULT 1440');
  }
  if (!projectColumns.some((column) => column.name === 'memory_dream_last_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN memory_dream_last_at TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'memory_brief_max_chars')) {
    db.exec('ALTER TABLE projects ADD COLUMN memory_brief_max_chars INTEGER NOT NULL DEFAULT 500');
  }
  const memoryColumns = db.prepare('PRAGMA table_info(project_memories)').all() as unknown as { name: string }[];
  if (!memoryColumns.some((column) => column.name === 'dreamed_at')) {
    db.exec('ALTER TABLE project_memories ADD COLUMN dreamed_at TEXT');
  }
  if (!memoryColumns.some((column) => column.name === 'status')) {
    db.exec("ALTER TABLE project_memories ADD COLUMN status TEXT NOT NULL DEFAULT 'durable'");
    // 旧的任务结果记录属于任务历史，不是持久项目知识：一次性归档。
    db.exec("UPDATE project_memories SET status = 'archived' WHERE source = 'task'");
  }
  // v10 -> v11：品牌从 Aiwo 切换为 Ryan，演示账号域名与密码同步迁移。
  const legacyPersons = db
    .prepare("SELECT id, email FROM persons WHERE email LIKE '%@aiwo.dev'")
    .all() as unknown as { id: string; email: string }[];
  const demoLocals = new Set(['lin.wei', 'chen.hao', 'zhou.ye', 'su.yan']);
  for (const person of legacyPersons) {
    const [local, domain] = person.email.split('@');
    const email = `${local}@ryan.dev`;
    const collision = db.prepare('SELECT id FROM persons WHERE email = ? AND id <> ?').get(email, person.id);
    if (!collision) db.prepare('UPDATE persons SET email = ? WHERE id = ?').run(email, person.id);
    if (domain === 'aiwo.dev' && demoLocals.has(local ?? '')) {
      db.prepare('UPDATE persons SET password_hash = ?, password_set = 1 WHERE id = ?').run(hashPassword(DEMO_PASSWORD), person.id);
    }
  }
  // v11 -> v12：清理演示/历史数据中的旧品牌文案。
  const legacyTextColumns: [string, string[]][] = [
    ['projects', ['name', 'description', 'prompt']],
    ['teams', ['name', 'description']],
    ['project_memories', ['title', 'content']],
    ['prompt_cards', ['name', 'description', 'content']],
    ['work_items', ['title', 'prompt', 'result', 'error']],
    ['task_events', ['message', 'payload']],
    ['automations', ['name', 'prompt_template']],
    ['activity_events', ['actor', 'summary']],
    ['runtime_events', ['payload']],
    ['memory_briefs', ['text']],
    ['memory_dream_runs', ['summary', 'error']],
  ];
  for (const [table, columns] of legacyTextColumns) {
    for (const column of columns) {
      db.exec(`UPDATE ${table} SET ${column} = replace(${column}, 'Aiwo', 'Ryan') WHERE ${column} LIKE '%Aiwo%'`);
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
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
