-- Hive schema v1：数字员工工作平台
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  avatar_color  TEXT NOT NULL DEFAULT 'violet',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  description    TEXT NOT NULL DEFAULT '',
  lead_person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_person ON team_members(person_id);

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  owner_team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  owner_person_id   TEXT NOT NULL REFERENCES persons(id),
  visibility        TEXT NOT NULL DEFAULT 'team',
  type              TEXT NOT NULL DEFAULT 'manual',
  prompt            TEXT NOT NULL DEFAULT '',
  repo_url          TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  mnemos_project_id TEXT,
  mnemos_api_key    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(owner_team_id);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_person_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'developer',
  added_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, person_id)
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  owner_person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'assistant',
  model         TEXT NOT NULL DEFAULT 'deepseek-chat',
  description   TEXT NOT NULL DEFAULT '',
  capabilities  TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_person_id);

CREATE TABLE IF NOT EXISTS project_agents (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  memory_agent_id  TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'developer',
  status           TEXT NOT NULL DEFAULT 'active',
  added_by         TEXT REFERENCES persons(id) ON DELETE SET NULL,
  added_at         TEXT NOT NULL,
  UNIQUE (project_id, agent_id),
  UNIQUE (project_id, memory_agent_id)
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  host           TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL DEFAULT '',
  version        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'online',
  registered_at  TEXT NOT NULL,
  last_seen_at   TEXT,
  revoked_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_instances_agent ON dsh_instances(agent_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS work_items (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source         TEXT NOT NULL DEFAULT 'human',
  type           TEXT NOT NULL DEFAULT 'feature',
  title          TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  priority       INTEGER NOT NULL DEFAULT 0,
  lease_until    TEXT,
  instance_id    TEXT,
  created_by     TEXT REFERENCES persons(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  result         TEXT,
  error          TEXT,
  metadata       TEXT NOT NULL DEFAULT '{}',
  dedupe_key     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON work_items(project_id, status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON work_items(agent_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON work_items(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON work_items(project_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_messages (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id   TEXT,
  author_name TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON task_messages(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL,
  instance_id TEXT,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_project ON task_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  trigger_type    TEXT NOT NULL DEFAULT 'manual',
  trigger_config  TEXT NOT NULL DEFAULT '{}',
  prompt_template TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT REFERENCES persons(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_run_at     TEXT,
  last_run_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_automations_project ON automations(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id       TEXT,
  status        TEXT NOT NULL,
  trigger       TEXT NOT NULL DEFAULT 'manual',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_deliveries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event       TEXT NOT NULL,
  status      TEXT NOT NULL,
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, provider, delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_project ON inbound_deliveries(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  task_id     TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL,
  instance_id TEXT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_events_task ON runtime_events(task_id, seq);

CREATE TABLE IF NOT EXISTS activity_events (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  project_name TEXT,
  type         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  task_id      TEXT,
  agent_id     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events(created_at DESC);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '5');
