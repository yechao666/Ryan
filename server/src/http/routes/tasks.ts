import { z } from 'zod';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { canViewProject, getProjectRow, type ProjectRow } from '../../lib/access.ts';
import { recordActivity } from '../../lib/activity.ts';
import { checkUserInput } from '../../security/check.ts';
import type { EventBus } from '../../lib/bus.ts';
import type { Db } from '../../db/index.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import type {
  ActivityEvent,
  EventType,
  PromptCardCategory,
  TaskEvent,
  TaskSource,
  TaskStatus,
  TaskType,
  WorkItem,
} from '../../../../shared/src/types.ts';
import { TASK_TYPES } from '../../../../shared/src/constants.ts';

export function withGoalPrefix(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return '/goal';
  return /^\/goal(?:\s|$)/i.test(trimmed) ? trimmed : `/goal ${trimmed}`;
}

export interface TaskRow {
  id: string;
  project_id: string;
  source: string;
  type: string;
  title: string;
  prompt: string;
  prompt_card_ids: string;
  status: string;
  priority: number;
  lease_until: string | null;
  instance_id: string | null;
  created_by: string | null;
  executor_person_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  error: string | null;
  metadata: string;
  dedupe_key: string | null;
  project_name?: string | null;
  project_slug?: string | null;
  project_type?: string | null;
  project_status?: string | null;
  mnemos_project_id?: string | null;
  mnemos_api_key?: string | null;
  instance_name?: string | null;
  created_by_name?: string | null;
  executor_name?: string | null;
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
         i.name AS instance_name,
         cp.name AS created_by_name,
         ep.name AS executor_name
    FROM work_items w
    JOIN projects p ON p.id = w.project_id
    LEFT JOIN dsh_instances i ON i.id = w.instance_id
    LEFT JOIN persons cp ON cp.id = w.created_by
    LEFT JOIN persons ep ON ep.id = COALESCE(w.executor_person_id, w.created_by)
`;

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
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

function cardsForTask(db: Db, ids: string[]): WorkItem['promptCards'] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = rowsOf<{ id: string; name: string; category: string }>(
    db,
    `SELECT id, name, category FROM prompt_cards WHERE id IN (${placeholders})`,
    ids,
  );
  return rows.map((row) => ({ id: row.id, name: row.name, category: row.category as PromptCardCategory }));
}

export function executorLabel(name: string | null | undefined): string {
  const value = String(name ?? '').trim();
  return value ? `${value}@Aiwo` : 'Aiwo';
}

export function mapWorkItem(row: TaskRow): WorkItem {
  const ids = parseStringArray(row.prompt_card_ids);
  const personName = row.executor_name ?? row.created_by_name ?? '';
  const item: WorkItem = {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? '',
    executorPersonId: row.executor_person_id ?? row.created_by ?? undefined,
    executorLabel: executorLabel(personName),
    source: row.source as TaskSource,
    type: (row.type ?? 'feature') as TaskType,
    title: row.title,
    prompt: row.prompt,
    promptCardIds: ids,
    promptCards: [],
    status: row.status as TaskStatus,
    priority: Number(row.priority ?? 0),
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata),
    messageCount: 0,
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
  return item;
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
  if (!row) return null;
  const item = mapWorkItem(row);
  item.promptCards = cardsForTask(db, item.promptCardIds);
  return item;
}

export function listTaskEvents(db: Db, taskId: string): TaskEvent[] {
  return rowsOf<TaskEventRow>(
    db,
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC',
    [taskId],
  ).map(mapTaskEvent);
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
  db.prepare(
    `INSERT INTO task_events (id, task_id, project_id, instance_id, type, message, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.projectId,
    input.instanceId ?? null,
    input.type,
    input.message ?? '',
    JSON.stringify(input.payload ?? {}),
    createdAt,
  );
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

export function truncateSummary(text: string, limit = 200): string {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export interface CreateTaskRecordInput {
  projectId: string;
  title: string;
  prompt: string;
  promptCardIds?: string[];
  instanceId?: string | null;
  source?: TaskSource;
  type?: TaskType;
  priority?: number;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
  dedupeKey?: string | null;
  actorName?: string;
  activitySummary?: string;
  eventMessage?: string;
}

export function createTaskRecord(db: Db, bus: EventBus, input: CreateTaskRecordInput): WorkItem {
  const project = rowOf<{ name: string; owner_team_id: string | null }>(
    db,
    'SELECT name, owner_team_id FROM projects WHERE id = ?',
    [input.projectId],
  );
  if (!project) throw errors.notFound('项目不存在');
  const creator = input.createdBy ? rowOf<{ name: string }>(db, 'SELECT name FROM persons WHERE id = ?', [input.createdBy]) : undefined;
  if (input.instanceId) {
    const bound = rowOf<{ ok: number }>(
      db,
      'SELECT 1 AS ok FROM instance_projects WHERE instance_id = ? AND project_id = ?',
      [input.instanceId, input.projectId],
    );
    if (!bound) throw errors.badRequest('该 DSH 实例未绑定当前项目');
  }
  const cardIds = [...new Set(input.promptCardIds ?? [])];
  if (cardIds.length > 0) {
    const placeholders = cardIds.map(() => '?').join(', ');
    const found = rowsOf<{ id: string; scope: string; project_id: string | null; team_id: string | null }>(
      db,
      `SELECT id, scope, project_id, team_id FROM prompt_cards WHERE enabled = 1 AND id IN (${placeholders})`,
      cardIds,
    );
    if (found.length !== cardIds.length) throw errors.badRequest('引用的提示词卡片不存在或已停用');
    if (
      found.some(
        (card) =>
          (card.scope === 'team' && card.team_id !== project.owner_team_id) ||
          (card.scope === 'project' && card.project_id !== input.projectId),
      )
    ) {
      throw errors.badRequest('引用的提示词卡片不在当前项目可用范围内');
    }
  }

  const id = newId('tsk');
  const createdAt = nowIso();
  const source = input.source ?? 'human';
  const type = input.type ?? 'feature';
  const title = input.title.trim();
  const prompt = withGoalPrefix(input.prompt);
  const executorName = creator?.name ?? input.actorName ?? '';
  db.prepare(
    `INSERT INTO work_items
       (id, project_id, source, type, title, prompt, prompt_card_ids, status, priority, lease_until, instance_id,
        created_by, executor_person_id, created_at, started_at, finished_at, result, error, metadata, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.projectId,
    source,
    type,
    title,
    prompt,
    JSON.stringify(cardIds),
    input.priority ?? 0,
    input.instanceId ?? null,
    input.createdBy ?? null,
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
    payload: { source, type, promptCardIds: cardIds },
    createdAt,
  });
  recordActivity(db, bus, {
    projectId: input.projectId,
    projectName: project.name,
    type: 'task.created',
    actor: executorLabel(executorName),
    summary: input.activitySummary ?? `创建任务：${title}`,
    taskId: id,
  });
  const item = getWorkItem(db, id);
  if (!item) throw errors.internal('任务创建后读取失败');
  return item;
}

const TASK_STATUSES = ['queued', 'assigned', 'running', 'waiting_input', 'done', 'failed', 'cancelled'] as const;
const TASK_STATUS_SET = new Set<string>(TASK_STATUSES);
const TASK_TYPE_VALUES = TASK_TYPES.map((item) => item.value) as [TaskType, ...TaskType[]];
const TASK_TYPE_SET = new Set<string>(TASK_TYPE_VALUES);

function parseStatuses(raw: string | undefined): TaskStatus[] {
  if (!raw) return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    if (!TASK_STATUS_SET.has(part)) throw errors.badRequest(`未知任务状态：${part}`);
    return part as TaskStatus;
  });
}

function parseTaskTypes(raw: string | undefined): TaskType[] {
  if (!raw) return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    if (!TASK_TYPE_SET.has(part)) throw errors.badRequest(`未知任务类型：${part}`);
    return part as TaskType;
  });
}

function visibleProjectIds(rc: RequestContext, person: { id: string; isAdmin: boolean }): string[] {
  const projects = rowsOf<ProjectRow>(rc.app.db, 'SELECT * FROM projects');
  return projects.filter((project) => canViewProject(rc.app.db, { id: person.id, isAdmin: person.isAdmin }, project)).map((project) => project.id);
}

interface ActivityRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  type: string;
  actor: string;
  summary: string;
  task_id: string | null;
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
  return event;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

const listQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  mine: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  prompt: z.string().min(1).max(20_000),
  promptCardIds: z.array(z.string().min(1)).max(20).optional(),
  instanceId: z.string().min(1).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  source: z.enum(['human', 'automation', 'webhook', 'api', 'seed']).optional(),
  type: z.enum(TASK_TYPE_VALUES).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const activityQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export function registerTaskRoutes(router: Router): void {
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
      where.push('w.created_by = ?');
      args.push(person.id);
    }
    args.push(params.limit);
    const sql = `${TASK_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY w.priority DESC, w.created_at DESC LIMIT ?`;
    const items = rowsOf<TaskRow>(db, sql, args).map(mapWorkItem);
    for (const item of items) item.promptCards = cardsForTask(db, item.promptCardIds);
    rc.json(items);
  });

  router.get('/api/tasks/:id', (rc) => {
    requirePerson(rc);
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    const project = requireProject(rc, task.project_id, 'view');
    rc.json({
      task: getWorkItem(rc.app.db, task.id),
      events: listTaskEvents(rc.app.db, task.id),
      memory: {
        projectId: project.mnemos_project_id ?? undefined,
        memoryAgentId: project.memory_agent_id ?? undefined,
        configured: Boolean(project.mnemos_project_id && project.mnemos_api_key),
      },
    });
  });

  router.post('/api/projects/:id/tasks', async (rc) => {
    const person = requirePerson(rc);
    const projectId = rc.params.id;
    requireProject(rc, projectId, 'contribute');
    const input = await rc.body(createTaskSchema);
    const security = await checkUserInput({
      db: rc.app.db,
      personId: person.id,
      source: 'task',
      content: `${input.title}\n${input.prompt}`,
    });
    if (!security.allowed) {
      throw errors.badRequest(security.blockedMessage ?? '输入未通过安全检查', { reason: security.reason });
    }
    const task = createTaskRecord(rc.app.db, rc.app.bus, {
      projectId,
      title: input.title,
      prompt: input.prompt,
      promptCardIds: input.promptCardIds,
      instanceId: input.instanceId,
      source: input.source ?? 'human',
      type: input.type,
      priority: input.priority,
      createdBy: person.id,
      metadata: input.metadata,
      actorName: person.name,
    });
    rc.json(task);
  });

  router.post('/api/tasks/:id/messages', (rc) => {
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    requireProject(rc, task.project_id, 'view');
    throw errors.conflict('Aiwo 任务不支持对话，只展示执行过程');
  });

  router.post('/api/tasks/:id/cancel', (rc) => {
    const person = requirePerson(rc);
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    requireProject(rc, task.project_id, 'contribute');
    if (!['queued', 'assigned', 'running', 'waiting_input'].includes(task.status)) {
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
    recordActivity(rc.app.db, rc.app.bus, {
      projectId: task.project_id,
      projectName: task.project_name ?? undefined,
      type: 'task.cancelled',
      actor: executorLabel(task.executor_name ?? person.name),
      summary: `取消任务：${task.title}`,
      taskId: task.id,
    });
    const updated = getWorkItem(rc.app.db, task.id);
    if (!updated) throw errors.internal('取消后读取任务失败');
    rc.json(updated);
  });

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
    args.push(params.limit);
    const sql = `SELECT * FROM activity_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    rc.json(rowsOf<ActivityRow>(db, sql, args).map(mapActivity));
  });
}

export { getProjectRow };
