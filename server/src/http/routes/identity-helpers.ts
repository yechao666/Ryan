/**
 * 身份 / 权限路由的共享行映射与统计口径。
 *
 * 仅服务于 identity.ts：把 SQLite 的 snake_case 行转换为 shared 契约中的
 * camelCase 视图对象，并统一「实例在线窗口 120s」「项目最近活跃」「智员统计」
 * 等计算方式，避免每个路由重复实现。
 */
import type { Db } from '../../db/index.ts';
import type { Actor, ProjectRow } from '../../lib/access.ts';
import { canViewProject } from '../../lib/access.ts';
import { personFromRow } from '../context.ts';
import type {
  ActivityEvent,
  Agent,
  AgentStatus,
  AgentToken,
  EventType,
  Instance,
  InstanceStatus,
  Person,
  ProjectAgent,
  ProjectMember,
  ProjectSummary,
  ProjectType,
  Team,
  TeamMember,
  TeamRole,
  Visibility,
} from '../../../../shared/src/types.ts';

/** 实例最后一次心跳距现在不超过该窗口即视为在线（毫秒）。 */
export const ONLINE_WINDOW_MS = 300_000;

/** 进行中的任务状态（实例 currentTask 与项目 activeTasks 共用）。 */
export const ACTIVE_TASK_STATUSES = ['queued', 'assigned', 'running', 'waiting_input'] as const;

export interface PersonRow {
  id: string;
  email: string;
  name: string;
  title: string | null;
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
  role: string;
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

export interface AgentRow {
  id: string;
  owner_person_id: string;
  name: string;
  role: string;
  model: string;
  description: string;
  capabilities: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentTokenRow {
  id: string;
  agent_id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ProjectAgentRow {
  id: string;
  project_id: string;
  agent_id: string;
  memory_agent_id: string;
  role: string;
  status: string;
  added_by: string | null;
  added_at: string;
}

export interface InstanceRow {
  id: string;
  agent_id: string;
  name: string;
  host: string;
  workspace_path: string;
  version: string;
  status: string;
  registered_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface ActivityRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  type: string;
  actor: string;
  summary: string;
  task_id: string | null;
  agent_id: string | null;
  created_at: string;
}

/** 统计类查询统一使用 COUNT(*) AS c。 */
export function countRows(db: Db, sql: string, ...params: Array<string | number | null>): number {
  const row = db.prepare(sql).get(...params) as unknown as { c: number | bigint } | undefined;
  return Number(row?.c ?? 0);
}

export function getPersonRow(db: Db, personId: string): PersonRow | null {
  return (db.prepare('SELECT * FROM persons WHERE id = ?').get(personId) as unknown as PersonRow | undefined) ?? null;
}

export function getTeamRow(db: Db, teamId: string): TeamRow | null {
  return (db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as unknown as TeamRow | undefined) ?? null;
}

export function getAgentRow(db: Db, agentId: string): AgentRow | null {
  return (db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as unknown as AgentRow | undefined) ?? null;
}

export function getInstanceRow(db: Db, instanceId: string): InstanceRow | null {
  return (
    (db.prepare('SELECT * FROM dsh_instances WHERE id = ?').get(instanceId) as unknown as InstanceRow | undefined) ??
    null
  );
}

export function getProjectAgentRow(db: Db, projectId: string, agentId: string): ProjectAgentRow | null {
  return (
    (db
      .prepare('SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(projectId, agentId) as unknown as ProjectAgentRow | undefined) ?? null
  );
}

export function getAgentTokenRow(db: Db, agentId: string, tokenId: string): AgentTokenRow | null {
  return (
    (db
      .prepare('SELECT * FROM agent_tokens WHERE id = ? AND agent_id = ?')
      .get(tokenId, agentId) as unknown as AgentTokenRow | undefined) ?? null
  );
}

export function nameOfPerson(db: Db, personId: string): string | undefined {
  const row = db.prepare('SELECT name FROM persons WHERE id = ?').get(personId) as unknown as
    | { name: string }
    | undefined;
  return row?.name;
}

/** 去空白、去重后的能力标签；保持输入顺序。 */
export function normalizeCapabilities(list: string[] | undefined): string[] {
  if (!list) return [];
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))];
}

/** capabilities 存的是 JSON 文本；脏数据回退为空数组。 */
export function parseCapabilities(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    /* 兼容历史脏数据 */
  }
  return [];
}

/** 由心跳时间推导实例状态；revoked_at 优先。 */
export function computeInstanceStatus(
  row: Pick<InstanceRow, 'last_seen_at' | 'revoked_at'>,
  now = Date.now(),
): InstanceStatus {
  if (row.revoked_at) return 'revoked';
  if (!row.last_seen_at) return 'offline';
  const seen = Date.parse(row.last_seen_at);
  if (Number.isFinite(seen) && now - seen <= ONLINE_WINDOW_MS) return 'online';
  return 'offline';
}

export function countOnlineInstances(db: Db, agentId: string, now = Date.now()): number {
  const threshold = new Date(now - ONLINE_WINDOW_MS).toISOString();
  return countRows(
    db,
    `SELECT COUNT(*) AS c FROM dsh_instances
      WHERE agent_id = ? AND revoked_at IS NULL AND last_seen_at IS NOT NULL AND last_seen_at >= ?`,
    agentId,
    threshold,
  );
}

export function buildTeam(db: Db, row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    leadPersonId: row.lead_person_id ?? undefined,
    leadName: row.lead_person_id ? nameOfPerson(db, row.lead_person_id) : undefined,
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
    role: row.role as TeamRole,
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
  const ownerTeam = row.owner_team_id
    ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(row.owner_team_id) as unknown as
        | { name: string }
        | undefined)
    : undefined;
  const lastActivity = db
    .prepare('SELECT MAX(created_at) AS at FROM activity_events WHERE project_id = ?')
    .get(row.id) as unknown as { at: string | null } | undefined;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerTeamId: row.owner_team_id ?? undefined,
    ownerTeamName: ownerTeam?.name,
    ownerPersonId: row.owner_person_id,
    ownerPersonName: nameOfPerson(db, row.owner_person_id) ?? '',
    visibility: row.visibility as Visibility,
    type: row.type as ProjectType,
    prompt: row.prompt ?? '',
    repoUrl: row.repo_url ?? undefined,
    status: row.status === 'archived' ? 'archived' : 'active',
    mnemosProjectId: row.mnemos_project_id ?? undefined,
    mnemosConfigured: Boolean(row.mnemos_api_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    counts: {
      agents: countRows(db, 'SELECT COUNT(*) AS c FROM project_agents WHERE project_id = ?', row.id),
      tasks: countRows(db, 'SELECT COUNT(*) AS c FROM work_items WHERE project_id = ?', row.id),
      activeTasks: countRows(
        db,
        `SELECT COUNT(*) AS c FROM work_items
          WHERE project_id = ? AND status IN (${ACTIVE_TASK_STATUSES.map(() => '?').join(', ')})`,
        row.id,
        ...ACTIVE_TASK_STATUSES,
      ),
      instances: countRows(
        db,
        `SELECT COUNT(*) AS c FROM dsh_instances i
           JOIN project_agents pa ON pa.agent_id = i.agent_id
          WHERE pa.project_id = ? AND i.revoked_at IS NULL`,
        row.id,
      ),
      members: countRows(db, 'SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?', row.id),
    },
    lastActivityAt: lastActivity?.at ?? undefined,
  };
}

/** 智员卡片需要的四项统计。 */
export function buildAgentStats(db: Db, agentId: string, now = Date.now()): Agent['stats'] {
  return {
    projects: countRows(db, 'SELECT COUNT(*) AS c FROM project_agents WHERE agent_id = ?', agentId),
    runningTasks: countRows(db, "SELECT COUNT(*) AS c FROM work_items WHERE agent_id = ? AND status = 'running'", agentId),
    queuedTasks: countRows(db, "SELECT COUNT(*) AS c FROM work_items WHERE agent_id = ? AND status = 'queued'", agentId),
    onlineInstances: countOnlineInstances(db, agentId, now),
  };
}

export function buildAgent(db: Db, row: AgentRow, now = Date.now()): Agent {
  return {
    id: row.id,
    ownerPersonId: row.owner_person_id,
    ownerName: nameOfPerson(db, row.owner_person_id) ?? '',
    name: row.name,
    role: row.role,
    model: row.model,
    description: row.description,
    capabilities: parseCapabilities(row.capabilities),
    status: row.status as AgentStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: buildAgentStats(db, row.id, now),
  };
}

export function buildAgentToken(row: AgentTokenRow): AgentToken {
  return {
    id: row.id,
    agentId: row.agent_id,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

export function buildProjectAgent(db: Db, row: ProjectAgentRow, now = Date.now()): ProjectAgent {
  const agent = db
    .prepare(
      `SELECT a.id, a.name, a.role, a.model, a.capabilities, p.name AS owner_name
         FROM agents a JOIN persons p ON p.id = a.owner_person_id
        WHERE a.id = ?`,
    )
    .get(row.agent_id) as unknown as
    | { id: string; name: string; role: string; model: string; capabilities: string; owner_name: string }
    | undefined;
  if (!agent) throw new Error('关联智员数据缺失');
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    memoryAgentId: row.memory_agent_id,
    role: row.role,
    status: row.status === 'active' ? 'active' : 'paused',
    addedBy: row.added_by ? nameOfPerson(db, row.added_by) : undefined,
    addedAt: row.added_at,
    agent: {
      name: agent.name,
      role: agent.role,
      model: agent.model,
      ownerName: agent.owner_name,
      capabilities: parseCapabilities(agent.capabilities),
    },
    onlineInstances: countOnlineInstances(db, row.agent_id, now),
  };
}

export function buildInstance(db: Db, row: InstanceRow, now = Date.now()): Instance {
  const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.agent_id) as unknown as
    | { name: string }
    | undefined;
  const task = db
    .prepare(
      `SELECT w.id, w.title, p.name AS project_name
         FROM work_items w JOIN projects p ON p.id = w.project_id
        WHERE w.instance_id = ? AND w.status IN ('running', 'waiting_input')
        ORDER BY COALESCE(w.started_at, w.created_at) DESC
        LIMIT 1`,
    )
    .get(row.id) as unknown as { id: string; title: string; project_name: string } | undefined;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: agent?.name ?? '',
    name: row.name,
    host: row.host,
    workspacePath: row.workspace_path,
    version: row.version,
    status: computeInstanceStatus(row, now),
    lastSeenAt: row.last_seen_at ?? undefined,
    registeredAt: row.registered_at,
    revokedAt: row.revoked_at ?? undefined,
    currentTask: task ? { id: task.id, title: task.title, projectName: task.project_name } : undefined,
  };
}

export function mapActivityRow(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    type: row.type as EventType,
    actor: row.actor,
    summary: row.summary,
    taskId: row.task_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    createdAt: row.created_at,
  };
}

/** 我加入的团队 + 我作为 lead 的团队（不受 admin 身份放大，仪表盘也用它）。 */
export function listMyTeams(db: Db, personId: string): Team[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM teams t
        WHERE t.lead_person_id = ?
           OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.person_id = ?)
        ORDER BY t.created_at DESC, t.name ASC`,
    )
    .all(personId, personId) as unknown as TeamRow[];
  return rows.map((row) => buildTeam(db, row));
}

export function listAllTeams(db: Db): Team[] {
  const rows = db.prepare('SELECT * FROM teams ORDER BY created_at DESC, name ASC').all() as unknown as TeamRow[];
  return rows.map((row) => buildTeam(db, row));
}

/** GET /api/teams 口径：admin 全部，其他人为我加入/负责的团队。 */
export function listTeamsForPerson(db: Db, person: Person): Team[] {
  return person.isAdmin ? listAllTeams(db) : listMyTeams(db, person.id);
}

/** 项目列表排序：最近活动优先，其次更新时间。 */
export function sortProjectsByActivity(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) =>
    (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt),
  );
}

/** 当前人可查看的项目（权限判断与 shared 契约一致）。 */
export function listVisibleProjects(db: Db, actor: Actor): ProjectSummary[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC')
    .all() as unknown as ProjectRow[];
  return sortProjectsByActivity(
    rows.filter((row) => canViewProject(db, actor, row)).map((row) => buildProjectSummary(db, row)),
  );
}

/** ownerPersonId 为 null 时返回全部智员（仅 admin 使用）。 */
export function listAgentsForOwner(db: Db, ownerPersonId: string | null, now = Date.now()): Agent[] {
  const rows = ownerPersonId
    ? (db
        .prepare('SELECT * FROM agents WHERE owner_person_id = ? ORDER BY created_at DESC')
        .all(ownerPersonId) as unknown as AgentRow[])
    : (db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as unknown as AgentRow[]);
  return rows.map((row) => buildAgent(db, row, now));
}

/** ownerPersonId 为 null 时返回全部实例（仅 admin 使用）。 */
export function listInstancesForOwner(db: Db, ownerPersonId: string | null, now = Date.now()): Instance[] {
  const rows = ownerPersonId
    ? (db
        .prepare(
          `SELECT i.* FROM dsh_instances i JOIN agents a ON a.id = i.agent_id
            WHERE a.owner_person_id = ?
            ORDER BY COALESCE(i.last_seen_at, i.registered_at) DESC, i.registered_at DESC`,
        )
        .all(ownerPersonId) as unknown as InstanceRow[])
    : (db
        .prepare(
          `SELECT i.* FROM dsh_instances i JOIN agents a ON a.id = i.agent_id
            ORDER BY COALESCE(i.last_seen_at, i.registered_at) DESC, i.registered_at DESC`,
        )
        .all() as unknown as InstanceRow[]);
  return rows.map((row) => buildInstance(db, row, now));
}

export function listInstancesForAgent(db: Db, agentId: string, now = Date.now()): Instance[] {
  const rows = db
    .prepare(
      `SELECT * FROM dsh_instances WHERE agent_id = ?
        ORDER BY COALESCE(last_seen_at, registered_at) DESC, registered_at DESC`,
    )
    .all(agentId) as unknown as InstanceRow[];
  return rows.map((row) => buildInstance(db, row, now));
}

export function listProjectAgents(db: Db, projectId: string, now = Date.now()): ProjectAgent[] {
  const rows = db
    .prepare('SELECT * FROM project_agents WHERE project_id = ? ORDER BY added_at DESC')
    .all(projectId) as unknown as ProjectAgentRow[];
  return rows.map((row) => buildProjectAgent(db, row, now));
}

export function listAgentBindings(db: Db, agentId: string, now = Date.now()): ProjectAgent[] {
  const rows = db
    .prepare('SELECT * FROM project_agents WHERE agent_id = ? ORDER BY added_at DESC')
    .all(agentId) as unknown as ProjectAgentRow[];
  return rows.map((row) => buildProjectAgent(db, row, now));
}

export function listAgentTokens(db: Db, agentId: string): AgentToken[] {
  const rows = db
    .prepare('SELECT * FROM agent_tokens WHERE agent_id = ? ORDER BY created_at DESC')
    .all(agentId) as unknown as AgentTokenRow[];
  return rows.map(buildAgentToken);
}

/**
 * 生成 URL 友好 slug：小写、非字母数字折叠为连字符。
 * 中文等无法转写的名称回退到 fallback，再由 uniqueSlug 追加唯一后缀。
 */
export function slugify(value: string, fallback: string): string {
  const ascii = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = ascii.slice(0, 48).replace(/-+$/g, '');
  return trimmed || fallback;
}

/** 在指定表内生成唯一 slug，冲突时追加 -2、-3… */
export function uniqueSlug(db: Db, table: 'teams' | 'projects', base: string, excludeId?: string): string {
  const statement = excludeId
    ? db.prepare(`SELECT 1 AS ok FROM ${table} WHERE slug = ? AND id <> ?`)
    : db.prepare(`SELECT 1 AS ok FROM ${table} WHERE slug = ?`);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const hit = excludeId ? statement.get(candidate, excludeId) : statement.get(candidate);
    if (!hit) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 项目内智员的默认记忆标识：prj_<slug 下划线化>__<agentId>。 */
export function defaultMemoryAgentId(projectSlug: string, agentId: string): string {
  return `prj_${projectSlug.replace(/-/g, '_')}__${agentId}`;
}
