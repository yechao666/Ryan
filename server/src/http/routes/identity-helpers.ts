import type {
  ActivityEvent,
  DshInstance,
  InstanceStatus,
  Person,
  ProjectMember,
  ProjectSummary,
  Team,
  TeamMember,
} from '../../../../shared/src/types.ts';
import type { Db } from '../../db/index.ts';
import type { Actor, ProjectRow } from '../../lib/access.ts';

export const ONLINE_WINDOW_MS = 300_000;
export const ACTIVE_TASK_STATUSES = ['queued', 'assigned', 'running', 'waiting_input'] as const;

export interface PersonRow {
  id: string;
  email: string;
  name: string;
  title: string;
  avatar_color: string;
  is_admin: number;
  created_at: string;
  last_seen_at: string | null;
}

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  lead_person_id: string | null;
  created_at: string;
}

export interface TeamMemberRow {
  team_id: string;
  person_id: string;
  role: 'lead' | 'member';
  created_at: string;
  name: string;
  email: string;
  avatar_color: string;
}

export interface ProjectMemberRow {
  project_id: string;
  person_id: string;
  role: string;
  added_at: string;
  name: string;
  email: string;
  avatar_color: string;
}

export interface InstanceRow {
  id: string;
  name: string;
  kind: string;
  host: string;
  port: number | null;
  base_url: string | null;
  workspace_path: string;
  version: string;
  plugin_version: string | null;
  token_hash: string;
  token_prefix: string;
  status: string;
  registered_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  metadata: string;
}

export interface ActivityRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  type: string;
  actor: string;
  summary: string;
  task_id: string | null;
  created_at: string;
}

export function countRows(db: Db, sql: string, ...params: Array<string | number | null>): number {
  const row = db.prepare(sql).get(...params) as { c: number | bigint } | undefined;
  return Number(row?.c ?? 0);
}

export function getPersonRow(db: Db, personId: string): PersonRow | null {
  return (db.prepare('SELECT * FROM persons WHERE id = ?').get(personId) as unknown as PersonRow | undefined) ?? null;
}

export function getTeamRow(db: Db, teamId: string): TeamRow | null {
  return (db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as unknown as TeamRow | undefined) ?? null;
}

export function getInstanceRow(db: Db, instanceId: string): InstanceRow | null {
  return (db.prepare('SELECT * FROM dsh_instances WHERE id = ?').get(instanceId) as unknown as InstanceRow | undefined) ?? null;
}

export function nameOfPerson(db: Db, personId: string): string | undefined {
  const row = db.prepare('SELECT name FROM persons WHERE id = ?').get(personId) as unknown as { name: string } | undefined;
  return row?.name;
}

export function computeInstanceStatus(
  row: Pick<InstanceRow, 'status' | 'revoked_at' | 'last_seen_at'>,
  now = Date.now(),
): InstanceStatus {
  if (row.revoked_at) return 'revoked';
  if (row.status === 'unconfigured' || row.status === 'error') return row.status as InstanceStatus;
  const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  if (Number.isFinite(seen) && now - seen <= ONLINE_WINDOW_MS) return 'online';
  return 'offline';
}

export function buildTeam(db: Db, row: TeamRow): Team {
  const lead = row.lead_person_id ? nameOfPerson(db, row.lead_person_id) : undefined;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    leadPersonId: row.lead_person_id ?? undefined,
    leadName: lead,
    memberCount: countRows(db, 'SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?', row.id),
    projectCount: countRows(db, 'SELECT COUNT(*) AS c FROM projects WHERE owner_team_id = ?', row.id),
    createdAt: row.created_at,
  };
}

export function mapTeamMemberRow(row: TeamMemberRow): TeamMember {
  return {
    teamId: row.team_id,
    personId: row.person_id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarColor: row.avatar_color,
    joinedAt: row.created_at,
  };
}

export function buildTeamMember(db: Db, teamId: string, personId: string): TeamMember | null {
  const row = db
    .prepare(
      `SELECT tm.team_id, tm.person_id, tm.role, tm.created_at,
              p.name, p.email, p.avatar_color
         FROM team_members tm JOIN persons p ON p.id = tm.person_id
        WHERE tm.team_id = ? AND tm.person_id = ?`,
    )
    .get(teamId, personId) as unknown as TeamMemberRow | undefined;
  return row ? mapTeamMemberRow(row) : null;
}

export function mapProjectMemberRow(row: ProjectMemberRow): ProjectMember {
  return {
    projectId: row.project_id,
    personId: row.person_id,
    name: row.name,
    email: row.email,
    role: row.role as ProjectMember['role'],
    avatarColor: row.avatar_color,
    addedAt: row.added_at,
  };
}

export function buildProjectSummary(db: Db, row: ProjectRow): ProjectSummary {
  const owner = nameOfPerson(db, row.owner_person_id);
  const team = row.owner_team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(row.owner_team_id) as unknown as { name: string } | undefined : undefined;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerTeamId: row.owner_team_id ?? undefined,
    ownerTeamName: team?.name,
    ownerPersonId: row.owner_person_id,
    ownerPersonName: owner ?? '',
    visibility: row.visibility as ProjectSummary['visibility'],
    type: row.type as ProjectSummary['type'],
    prompt: row.prompt,
    repoUrl: row.repo_url ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    status: row.status as ProjectSummary['status'],
    mnemosProjectId: row.mnemos_project_id ?? undefined,
    mnemosConfigured: Boolean(row.mnemos_project_id && row.mnemos_api_key),
    memoryAgentId: row.memory_agent_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    counts: {
      promptCards: countRows(
        db,
        "SELECT COUNT(*) AS c FROM prompt_cards WHERE enabled = 1 AND (scope = 'org' OR (scope = 'team' AND team_id = ?) OR (scope = 'project' AND project_id = ?))",
        row.owner_team_id,
        row.id,
      ),
      tasks: countRows(db, 'SELECT COUNT(*) AS c FROM work_items WHERE project_id = ?', row.id),
      activeTasks: countRows(
        db,
        "SELECT COUNT(*) AS c FROM work_items WHERE project_id = ? AND status IN ('queued','assigned','running','waiting_input')",
        row.id,
      ),
      instances: countRows(db, "SELECT COUNT(*) AS c FROM dsh_instances WHERE revoked_at IS NULL"),
      members: countRows(db, 'SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?', row.id),
    },
    lastActivityAt:
      (db.prepare('SELECT MAX(created_at) AS t FROM activity_events WHERE project_id = ?').get(row.id) as unknown as { t: string | null } | undefined)?.t ?? undefined,
  };
}

export function buildInstance(db: Db, row: InstanceRow, now = Date.now()): DshInstance {
  const current = db
    .prepare(
      `SELECT w.id, w.title, p.name AS project_name
         FROM work_items w JOIN projects p ON p.id = w.project_id
        WHERE w.instance_id = ? AND w.status IN ('running','waiting_input')
        ORDER BY w.started_at DESC LIMIT 1`,
    )
    .get(row.id) as unknown as { id: string; title: string; project_name: string } | undefined;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DshInstance['kind'],
    host: row.host,
    port: row.port ?? undefined,
    baseUrl: row.base_url ?? undefined,
    version: row.version,
    pluginVersion: row.plugin_version ?? undefined,
    status: computeInstanceStatus(row, now),
    lastSeenAt: row.last_seen_at ?? undefined,
    registeredAt: row.registered_at,
    revokedAt: row.revoked_at ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    currentTask: current ? { id: current.id, title: current.title, projectName: current.project_name } : undefined,
    hasToken: Boolean(row.token_hash),
  };
}

export function mapActivityRow(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    type: row.type as ActivityEvent['type'],
    actor: row.actor,
    summary: row.summary,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  };
}

export function listMyTeams(db: Db, personId: string): Team[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM teams t
        WHERE t.lead_person_id = ?
           OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.person_id = ?)
        ORDER BY t.created_at DESC`,
    )
    .all(personId, personId) as unknown as TeamRow[];
  return rows.map((row) => buildTeam(db, row));
}

export function listAllTeams(db: Db): Team[] {
  return (db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all() as unknown as TeamRow[]).map((row) => buildTeam(db, row));
}

export function listTeamsForPerson(db: Db, person: Person): Team[] {
  return person.isAdmin ? listAllTeams(db) : listMyTeams(db, person.id);
}

export function sortProjectsByActivity(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt));
}

export function listVisibleProjects(db: Db, actor: Actor): ProjectSummary[] {
  const rows = actor.isAdmin
    ? (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRow[])
    : (db
        .prepare(
          `SELECT DISTINCT p.* FROM projects p
             LEFT JOIN project_members pm ON pm.project_id = p.id
             LEFT JOIN team_members tm ON tm.team_id = p.owner_team_id
            WHERE p.visibility = 'public'
               OR p.owner_person_id = ?
               OR pm.person_id = ?
               OR (p.visibility = 'team' AND tm.person_id = ?)
            ORDER BY p.updated_at DESC`,
        )
        .all(actor.id, actor.id, actor.id) as unknown as ProjectRow[]);
  return sortProjectsByActivity(rows.map((row) => buildProjectSummary(db, row)));
}

export function listInstancesForOwner(db: Db, _ownerPersonId: string | null, now = Date.now()): DshInstance[] {
  return (db.prepare('SELECT * FROM dsh_instances ORDER BY created_at DESC').all() as unknown as InstanceRow[]).map((row) =>
    buildInstance(db, row, now),
  );
}

export function slugify(value: string, fallback: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || fallback;
}

export function uniqueSlug(db: Db, table: 'teams' | 'projects', base: string, excludeId = ''): string {
  const normalized = base.slice(0, 48) || 'item';
  let slug = normalized;
  let suffix = 2;
  const exists = db.prepare(`SELECT 1 AS x FROM ${table} WHERE slug = ? AND id <> ?`);
  while (exists.get(slug, excludeId)) {
    slug = `${normalized}-${suffix}`;
    suffix += 1;
    if (suffix > 200) {
      slug = `${normalized}-${Date.now().toString(36)}`;
      break;
    }
  }
  return slug;
}
