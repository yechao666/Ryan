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
  'task_messages',
  'work_items',
  'dsh_instances',
  'agent_tokens',
  'project_agents',
  'agents',
  'project_members',
  'projects',
  'team_members',
  'teams',
  'sessions',
  'persons',
  'meta',
];
db.exec('PRAGMA foreign_keys = OFF;');
for (const table of tables) db.exec(`DELETE FROM ${table};`);
db.exec('PRAGMA foreign_keys = ON;');
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')").run();
seedDatabase(db);
db.exec("UPDATE work_items SET prompt = '/goal ' || prompt WHERE prompt <> '' AND prompt <> '/goal' AND prompt NOT LIKE '/goal %'");
console.log(`[hive] seeded ${env.dbPath}`);
console.log(`[hive] demo login: lin.wei@hive.dev / hive-demo`);
