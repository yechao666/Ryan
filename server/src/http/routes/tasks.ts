/**
 * 控制台任务 API + 任务域共享工具（运行时 / 自动化 / Webhook / 调度器复用）。
 *
 * 本模块除路由外还导出：
 * - 任务行 → WorkItem / TaskMessage / TaskEvent 映射
 * - getTaskRow / getWorkItem / listTaskMessages / listTaskEvents
 * - insertTaskMessage / insertTaskEvent（含 task_events 落库）
 * - createTaskRecord（建任务 + task.created 事件 + 活动流）
 */
import { z } from 'zod';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { canViewProject, getProjectRow, type ProjectRow } from '../../lib/access.ts';
import { recordActivity } from '../../lib/activity.ts';
import type { EventBus } from '../../lib/bus.ts';
import type { Db } from '../../db/index.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import type {
  ActivityEvent,
  EventType,
  MessageAuthor,
  TaskEvent,
  TaskMessage,
  TaskSource,
  TaskStatus,
  TaskType,
  WorkItem,
} from '../../../../shared/src/types.ts';
import { TASK_TYPES } from '../../../../shared/src/constants.ts';

// ---------------------------------------------------------------------------
// 行类型与基础工具
// ---------------------------------------------------------------------------

/** 每个任务都是独立的 DSH goal；提示词统一带 /goal 前缀。 */
export function withGoalPrefix(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return '/goal';
  return /^\/goal(?:\s|$)/i.test(trimmed) ? trimmed : `/goal ${trimmed}`;
}

export interface TaskRow {
  id: string;
  project_id: string;
  agent_id: string;
  source: string;
  type: string;
  title: string;
  prompt: string;
  status: string;
  priority: number;
  lease_until: string | null;
  instance_id: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  error: string | null;
  metadata: string;
  dedupe_key: string | null;
  // JOIN / 子查询附加列
  project_name?: string | null;
  project_slug?: string | null;
  project_type?: string | null;
  project_status?: string | null;
  mnemos_project_id?: string | null;
  mnemos_api_key?: string | null;
  agent_name?: string | null;
  agent_capabilities?: string | null;
  agent_owner_person_id?: string | null;
  instance_name?: string | null;
  created_by_name?: string | null;
  message_count?: number | null;
  last_message_at?: string | null;
}

export interface TaskMessageRow {
  id: string;
  task_id: string;
  author_type: string;
  author_id: string | null;
  author_name: string;
  content: string;
  created_at: string;
}

export interface TaskEventRow {
  id: string;
  task_id: string;
  project_id: string;
  instance_id: string | null;
  type: string;
  message: string;
  payload: string;
  created_at: string;
}

type SqlValue = string | number | null;

export const TASK_SELECT = `
  SELECT w.*,
         p.name AS project_name,
         p.slug AS project_slug,
         p.type AS project_type,
         p.status AS project_status,
         p.mnemos_project_id AS mnemos_project_id,
         p.mnemos_api_key AS mnemos_api_key,
         a.name AS agent_name,
         a.capabilities AS agent_capabilities,
         a.owner_person_id AS agent_owner_person_id,
         i.name AS instance_name,
         cp.name AS created_by_name,
         (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = w.id) AS message_count,
         (SELECT MAX(m.created_at) FROM task_messages m WHERE m.task_id = w.id) AS last_message_at
    FROM work_items w
    JOIN projects p ON p.id = w.project_id
    JOIN agents a ON a.id = w.agent_id
    LEFT JOIN dsh_instances i ON i.id = w.instance_id
    LEFT JOIN persons cp ON cp.id = w.created_by
`;

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function rowsOf<T>(db: Db, sql: string, params: SqlValue[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function rowOf<T>(db: Db, sql: string, params: SqlValue[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function mapWorkItem(row: TaskRow): WorkItem {
  const item: WorkItem = {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? '',
    agentId: row.agent_id,
    agentName: row.agent_name ?? '',
    source: row.source as TaskSource,
    type: (row.type ?? 'feature') as TaskType,
    title: row.title,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    priority: Number(row.priority ?? 0),
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata),
    messageCount: Number(row.message_count ?? 0),
  };
  if (row.lease_until) item.leaseUntil = row.lease_until;
  if (row.instance_id) item.instanceId = row.instance_id;
  if (row.instance_name) item.instanceName = row.instance_name;
  if (row.created_by) item.createdBy = row.created_by;
  if (row.created_by_name) item.createdByName = row.created_by_name;
  if (row.started_at) item.startedAt = row.started_at;
  if (row.finished_at) item.finishedAt = row.finished_at;
  if (row.result) item.result = row.result;
  if (row.error) item.error = row.error;
  if (row.last_message_at) item.lastMessageAt = row.last_message_at;
  return item;
}

export function mapTaskMessage(row: TaskMessageRow): TaskMessage {
  const message: TaskMessage = {
    id: row.id,
    taskId: row.task_id,
    authorType: row.author_type as MessageAuthor,
    authorName: row.author_name,
    content: row.content,
    createdAt: row.created_at,
  };
  if (row.author_id) message.authorId = row.author_id;
  return message;
}

export function mapTaskEvent(row: TaskEventRow): TaskEvent {
  const event: TaskEvent = {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    type: row.type,
    message: row.message,
    payload: parseJsonObject(row.payload),
    createdAt: row.created_at,
  };
  if (row.instance_id) event.instanceId = row.instance_id;
  return event;
}

export function getTaskRow(db: Db, id: string): TaskRow | null {
  return rowOf<TaskRow>(db, `${TASK_SELECT} WHERE w.id = ?`, [id]) ?? null;
}

export function getWorkItem(db: Db, id: string): WorkItem | null {
  const row = getTaskRow(db, id);
  return row ? mapWorkItem(row) : null;
}

export function listTaskMessages(db: Db, taskId: string, since?: string): TaskMessage[] {
  const sql = since
    ? 'SELECT * FROM task_messages WHERE task_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC'
    : 'SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC, id ASC';
  const params: SqlValue[] = since ? [taskId, since] : [taskId];
  return rowsOf<TaskMessageRow>(db, sql, params).map(mapTaskMessage);
}

export function listTaskEvents(db: Db, taskId: string): TaskEvent[] {
  return rowsOf<TaskEventRow>(
    db,
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC',
    [taskId],
  ).map(mapTaskEvent);
}

export interface InsertTaskMessageInput {
  taskId: string;
  authorType: MessageAuthor;
  authorId?: string | null;
  authorName: string;
  content: string;
  createdAt?: string;
}

export function insertTaskMessage(db: Db, input: InsertTaskMessageInput): TaskMessage {
  const id = newId('msg');
  const createdAt = input.createdAt ?? nowIso();
  db.prepare(
    `INSERT INTO task_messages (id, task_id, author_type, author_id, author_name, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.taskId, input.authorType, input.authorId ?? null, input.authorName, input.content, createdAt);
  return {
    id,
    taskId: input.taskId,
    authorType: input.authorType,
    authorName: input.authorName,
    content: input.content,
    createdAt,
    ...(input.authorId ? { authorId: input.authorId } : {}),
  };
}

export interface InsertTaskEventInput {
  taskId: string;
  projectId: string;
  instanceId?: string | null;
  type: string;
  message?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export function insertTaskEvent(db: Db, input: InsertTaskEventInput): TaskEvent {
  const id = newId('evt');
  const createdAt = input.createdAt ?? nowIso();
  const payload = JSON.stringify(input.payload ?? {});
  db.prepare(
    `INSERT INTO task_events (id, task_id, project_id, instance_id, type, message, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.taskId, input.projectId, input.instanceId ?? null, input.type, input.message ?? '', payload, createdAt);
  return {
    id,
    taskId: input.taskId,
    projectId: input.projectId,
    type: input.type,
    message: input.message ?? '',
    payload: input.payload ?? {},
    createdAt,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
  };
}

/** 活动流摘要：最多 200 字，超出加省略号。 */
export function truncateSummary(text: string, limit = 200): string {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// 建任务（控制台 / 自动化 / Webhook / 调度器共用）
// ---------------------------------------------------------------------------

export interface CreateTaskRecordInput {
  projectId: string;
  agentId: string;
  title: string;
  prompt: string;
  source?: TaskSource;
  type?: TaskType;
  priority?: number;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
  dedupeKey?: string | null;
  /** 活动流里的操作者名称，缺省用智员名。 */
  actorName?: string;
  /** 活动流摘要，缺省「创建任务：标题」。 */
  activitySummary?: string;
  /** task_events 里的消息，缺省「创建任务：标题」。 */
  eventMessage?: string;
}

export function createTaskRecord(db: Db, bus: EventBus, input: CreateTaskRecordInput): WorkItem {
  const project = rowOf<{ name: string }>(db, 'SELECT name FROM projects WHERE id = ?', [input.projectId]);
  if (!project) throw errors.notFound('项目不存在');
  const agent = rowOf<{ name: string }>(db, 'SELECT name FROM agents WHERE id = ?', [input.agentId]);

  const id = newId('tsk');
  const createdAt = nowIso();
  const source = input.source ?? 'human';
  const type = input.type ?? 'feature';
  const title = input.title.trim();
  const prompt = withGoalPrefix(input.prompt);
  db.prepare(
    `INSERT INTO work_items
       (id, project_id, agent_id, source, type, title, prompt, status, priority, lease_until, instance_id,
        created_by, created_at, started_at, finished_at, result, error, metadata, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.agentId,
    source,
    type,
    title,
    prompt,
    input.priority ?? 0,
    input.createdBy ?? null,
    createdAt,
    JSON.stringify(input.metadata ?? {}),
    input.dedupeKey ?? null,
  );

  insertTaskEvent(db, {
    taskId: id,
    projectId: input.projectId,
    type: 'task.created',
    message: input.eventMessage ?? `创建任务：${title}`,
    payload: { source, type },
    createdAt,
  });
  recordActivity(db, bus, {
    projectId: input.projectId,
    projectName: project.name,
    type: 'task.created',
    actor: input.actorName ?? agent?.name ?? '系统',
    summary: input.activitySummary ?? `创建任务：${title}`,
    taskId: id,
    agentId: input.agentId,
  });

  const item = getWorkItem(db, id);
  if (!item) throw errors.internal('任务创建后读取失败');
  return item;
}

// ---------------------------------------------------------------------------
// 查询工具
// ---------------------------------------------------------------------------

const TASK_STATUSES = [
  'queued',
  'assigned',
  'running',
  'waiting_input',
  'done',
  'failed',
  'cancelled',
] as const;

const TASK_STATUS_SET = new Set<string>(TASK_STATUSES);

function parseStatuses(raw: string | undefined): TaskStatus[] {
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const result: TaskStatus[] = [];
  for (const part of parts) {
    if (!TASK_STATUS_SET.has(part)) throw errors.badRequest(`未知任务状态：${part}`);
    if (!result.includes(part as TaskStatus)) result.push(part as TaskStatus);
  }
  return result;
}

const TASK_TYPE_VALUES = TASK_TYPES.map((item) => item.value) as [TaskType, ...TaskType[]];
const TASK_TYPE_SET = new Set<string>(TASK_TYPE_VALUES);

function parseTaskTypes(raw: string | undefined): TaskType[] {
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const result: TaskType[] = [];
  for (const part of parts) {
    if (!TASK_TYPE_SET.has(part)) throw errors.badRequest(`未知任务类型：${part}`);
    if (!result.includes(part as TaskType)) result.push(part as TaskType);
  }
  return result;
}

function visibleProjectIds(rc: RequestContext, person: { id: string; isAdmin: boolean }): string[] {
  const projects = rowsOf<ProjectRow>(rc.app.db, 'SELECT * FROM projects');
  const actor = { id: person.id, isAdmin: person.isAdmin };
  return projects
    .filter((project) => canViewProject(rc.app.db, actor, project))
    .map((project) => project.id);
}

interface ActivityRow {
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

function mapActivity(row: ActivityRow): ActivityEvent {
  const event: ActivityEvent = {
    id: row.id,
    type: row.type as EventType,
    actor: row.actor,
    summary: row.summary,
    createdAt: row.created_at,
  };
  if (row.project_id) event.projectId = row.project_id;
  if (row.project_name) event.projectName = row.project_name;
  if (row.task_id) event.taskId = row.task_id;
  if (row.agent_id) event.agentId = row.agent_id;
  return event;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// ---------------------------------------------------------------------------
// 请求 schema
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  mine: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const createTaskSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  prompt: z.string().min(1).max(20_000),
  priority: z.number().int().min(-100).max(100).optional(),
  source: z.enum(['human', 'automation', 'webhook', 'api', 'seed']).optional(),
  type: z.enum(TASK_TYPE_VALUES).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const messageSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
});

const activityQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function registerTaskRoutes(router: Router): void {
  // GET /api/tasks —— 当前人可见项目的任务列表
  router.get('/api/tasks', (rc) => {
    const person = requirePerson(rc);
    const params = rc.query(listQuerySchema);
    const statuses = parseStatuses(params.status);
    const types = parseTaskTypes(params.type);
    const mine = params.mine === '1' || params.mine === 'true';
    const db = rc.app.db;

    const where: string[] = [];
    const args: SqlValue[] = [];

    if (params.projectId) {
      requireProject(rc, params.projectId, 'view');
      where.push('w.project_id = ?');
      args.push(params.projectId);
    } else if (!person.isAdmin) {
      const ids = visibleProjectIds(rc, person);
      if (ids.length === 0) {
        rc.json([]);
        return;
      }
      where.push(`w.project_id IN (${placeholders(ids.length)})`);
      args.push(...ids);
    }

    if (statuses.length === 1) {
      where.push('w.status = ?');
      args.push(statuses[0]!);
    } else if (statuses.length > 1) {
      where.push(`w.status IN (${placeholders(statuses.length)})`);
      args.push(...statuses);
    }

    if (types.length === 1) {
      where.push('w.type = ?');
      args.push(types[0]!);
    } else if (types.length > 1) {
      where.push(`w.type IN (${placeholders(types.length)})`);
      args.push(...types);
    }

    if (mine) {
      where.push('(w.created_by = ? OR a.owner_person_id = ?)');
      args.push(person.id, person.id);
    }

    const sql = `${TASK_SELECT}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY w.priority DESC, w.created_at DESC
      LIMIT ?`;
    args.push(params.limit);

    const items = rowsOf<TaskRow>(db, sql, args).map(mapWorkItem);
    rc.json(items);
  });

  // GET /api/tasks/:id —— 任务详情（消息 / 事件 / 记忆配置）
  router.get('/api/tasks/:id', (rc) => {
    requirePerson(rc);
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    const project = requireProject(rc, task.project_id, 'view');
    const binding = rowOf<{ memory_agent_id: string }>(
      rc.app.db,
      'SELECT memory_agent_id FROM project_agents WHERE project_id = ? AND agent_id = ?',
      [task.project_id, task.agent_id],
    );
    rc.json({
      task: mapWorkItem(task),
      messages: listTaskMessages(rc.app.db, task.id),
      events: listTaskEvents(rc.app.db, task.id),
      memory: {
        projectId: project.mnemos_project_id ?? undefined,
        agentMemoryId: binding?.memory_agent_id ?? undefined,
        configured: Boolean(project.mnemos_project_id && project.mnemos_api_key),
      },
    });
  });

  // POST /api/projects/:id/tasks —— 创建任务（需 contribute）
  router.post('/api/projects/:id/tasks', async (rc) => {
    const person = requirePerson(rc);
    const projectId = rc.params.id;
    requireProject(rc, projectId, 'contribute');
    const input = await rc.body(createTaskSchema);

    const bound = rowOf<{ ok: number }>(
      rc.app.db,
      "SELECT 1 AS ok FROM project_agents WHERE project_id = ? AND agent_id = ? AND status = 'active'",
      [projectId, input.agentId],
    );
    if (!bound) throw errors.badRequest('该智员未与项目建立有效绑定');

    const task = createTaskRecord(rc.app.db, rc.app.bus, {
      projectId,
      agentId: input.agentId,
      title: input.title,
      prompt: input.prompt,
      source: input.source ?? 'human',
      type: input.type,
      priority: input.priority,
      createdBy: person.id,
      metadata: input.metadata,
      actorName: person.name,
      activitySummary: `创建任务：${input.title}`,
    });
    rc.json(task);
  });

  // POST /api/tasks/:id/messages —— 任务只展示执行过程，不接受任何对话消息。
  router.post('/api/tasks/:id/messages', (rc) => {
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    requireProject(rc, task.project_id, 'view');
    throw errors.conflict('任务仅展示执行过程，不支持对话；如需新工作请新建任务');
  });

  // POST /api/tasks/:id/cancel —— 取消任务（需 contribute）
  router.post('/api/tasks/:id/cancel', (rc) => {
    const person = requirePerson(rc);
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    requireProject(rc, task.project_id, 'contribute');

    const cancellable = new Set(['queued', 'assigned', 'running', 'waiting_input']);
    if (!cancellable.has(task.status)) {
      throw errors.conflict('当前状态的任务不可取消');
    }
    const now = nowIso();
    rc.app.db
      .prepare("UPDATE work_items SET status = 'cancelled', finished_at = ?, lease_until = NULL WHERE id = ?")
      .run(now, task.id);
    insertTaskEvent(rc.app.db, {
      taskId: task.id,
      projectId: task.project_id,
      instanceId: task.instance_id,
      type: 'task.cancelled',
      message: '任务已取消',
      payload: { previousStatus: task.status },
      createdAt: now,
    });
    // EventType 联合类型未包含 cancelled，这里按活动流扩展类型记录。
    recordActivity(rc.app.db, rc.app.bus, {
      projectId: task.project_id,
      projectName: task.project_name ?? undefined,
      type: 'task.cancelled' as EventType,
      actor: person.name,
      summary: `取消任务：${task.title}`,
      taskId: task.id,
      agentId: task.agent_id,
    });

    const updated = getWorkItem(rc.app.db, task.id);
    if (!updated) throw errors.internal('取消后读取任务失败');
    rc.json(updated);
  });

  // GET /api/activity —— 活动流（仅可见项目）
  router.get('/api/activity', (rc) => {
    const person = requirePerson(rc);
    const params = rc.query(activityQuerySchema);
    const db = rc.app.db;
    const where: string[] = [];
    const args: SqlValue[] = [];

    if (params.projectId) {
      requireProject(rc, params.projectId, 'view');
      where.push('project_id = ?');
      args.push(params.projectId);
    } else if (!person.isAdmin) {
      const ids = visibleProjectIds(rc, person);
      if (ids.length === 0) {
        rc.json([]);
        return;
      }
      where.push(`project_id IN (${placeholders(ids.length)})`);
      args.push(...ids);
    }

    const sql = `SELECT * FROM activity_events
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`;
    args.push(params.limit);

    rc.json(rowsOf<ActivityRow>(db, sql, args).map(mapActivity));
  });
}

export { getProjectRow };
