import { loadEnv } from '../env.ts';
import { openDatabase, migrate } from '../db/index.ts';
import { seedDatabase } from './seed.ts';

const env = loadEnv();
const db = openDatabase(env.dbPath);
migrate(db);

const tables = [
  'runtime_events',
  'activity_events',
  'inbound_deliveries',
  'automation_runs',
  'automations',
  'task_events',
  'work_items',
  'instance_projects',
  'dsh_instances',
  'prompt_cards',
  'project_members',
  'projects',
  'team_members',
  'teams',
  'sessions',
  'security_checks',
  'system_settings',
  'persons',
  'meta',
];
db.exec('PRAGMA foreign_keys = OFF;');
for (const table of tables) db.exec(`DELETE FROM ${table};`);
db.exec('PRAGMA foreign_keys = ON;');
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '12')").run();
seedDatabase(db);
console.log(`[aiwo] seeded ${env.dbPath}`);
console.log(`[aiwo] demo login: lin.wei@ryan.dev / ryan-demo`);
