import { z } from 'zod';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { canContributeProject, canViewProject, getProjectRow, type ProjectRow } from '../../lib/access.ts';
import { recordActivity } from '../../lib/activity.ts';
import { checkUserInput } from '../../security/check.ts';
import { generateTaskTitle } from '../../tasks/title.ts';
import { getDefaultServiceId } from '../../settings/system.ts';
import { memoryAgentIdOf } from '../../memory/store.ts';
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
import { parseMentions } from '../../mentions.ts';
import { createTaskNotification } from '../../lib/notifications.ts';

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
  handoff_person_id: string | null;
  handoff_prompt_card_ids: string;
  handoff_note: string;
  notify_person_ids: string;
  status: string;
  priority: number;
  lease_until: string | null;
  instance_id: string | null;
  allowed_service_ids: string;
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
  instance_name?: string | null;
  created_by_name?: string | null;
  executor_name?: string | null;
  handoff_person_name?: string | null;
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
         i.name AS instance_name,
         cp.name AS created_by_name,
         ep.name AS executor_name,
         hp.name AS handoff_person_name
    FROM work_items w
    JOIN projects p ON p.id = w.project_id
    LEFT JOIN dsh_instances i ON i.id = w.instance_id
    LEFT JOIN persons cp ON cp.id = w.created_by
    LEFT JOIN persons ep ON ep.id = COALESCE(w.executor_person_id, w.created_by)
    LEFT JOIN persons hp ON hp.id = w.handoff_person_id
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

/**
 * 自动注入提示卡：按卡片范围匹配任务创建人 / 项目 / 项目归属团队 / 组织。
 * 个人卡跟随当前创建人，项目卡跟随项目，团队卡跟随项目所属团队，公共卡面向所有任务。
 */
export function autoInjectCardIds(db: Db, projectId: string, createdBy: string | null | undefined): string[] {
  if (!createdBy) return [];
  return rowsOf<{ id: string }>(
    db,
    `SELECT c.id FROM prompt_cards c
      WHERE c.enabled = 1 AND c.auto_inject = 1 AND (
        c.scope = 'org'
        OR (c.scope = 'person' AND c.person_id = ?)
        OR (c.scope = 'project' AND c.project_id = ?)
        OR (c.scope = 'team' AND c.team_id = (SELECT owner_team_id FROM projects WHERE id = ?))
      )
      ORDER BY c.updated_at ASC`,
    [createdBy, projectId, projectId],
  ).map((row) => row.id);
}

function serviceNamesForTask(db: Db, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return rowsOf<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM dsh_instances WHERE id IN (${placeholders}) ORDER BY name ASC`,
    ids,
  ).map((row) => row.name);
}

export function executorLabel(name: string | null | undefined): string {
  const value = String(name ?? '').trim();
  return value ? `${value}@Ryan` : 'Ryan';
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
    ...(row.handoff_person_id ? { handoffPersonId: row.handoff_person_id } : {}),
    ...(row.handoff_person_name ? { handoffPersonName: row.handoff_person_name } : {}),
    ...(parseStringArray(row.handoff_prompt_card_ids).length ? { handoffPromptCardIds: parseStringArray(row.handoff_prompt_card_ids) } : {}),
    ...(row.handoff_note ? { handoffNote: row.handoff_note } : {}),
    ...(parseStringArray(row.notify_person_ids).length ? { notifyPersonIds: parseStringArray(row.notify_person_ids) } : {}),
    status: row.status as TaskStatus,
    priority: Number(row.priority ?? 0),
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata),
    messageCount: 0,
  };
  if (row.lease_until) item.leaseUntil = row.lease_until;
  if (row.instance_id) item.instanceId = row.instance_id;
  if (row.instance_name) item.instanceName = row.instance_name;
  const allowedServiceIds = parseStringArray(row.allowed_service_ids);
  if (allowedServiceIds.length) item.allowedServiceIds = allowedServiceIds;
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
  if (item.allowedServiceIds?.length) item.allowedServiceNames = serviceNamesForTask(db, item.allowedServiceIds);
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
  handoffPersonId?: string | null;
  handoffPromptCardIds?: string[];
  handoffNote?: string;
  notifyPersonIds?: string[];
  instanceId?: string | null;
  instanceIds?: string[];
  source?: TaskSource;
  type?: TaskType;
  priority?: number;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
  dedupeKey?: string | null;
  actorName?: string;
  activitySummary?: string;
  eventMessage?: string;
  /** 内部接力任务不再解析原始文本中的 @，避免递归接力。 */
  skipMentions?: boolean;
}

const SERVICE_ONLINE_MS = 5 * 60_000;

function projectServiceIds(db: Db, projectId: string): string[] {
  return rowsOf<{ id: string }>(
    db,
    `SELECT i.id FROM instance_projects ip JOIN dsh_instances i ON i.id = ip.instance_id
      WHERE ip.project_id = ? AND i.revoked_at IS NULL ORDER BY i.id ASC`,
    [projectId],
  ).map((row) => row.id);
}

function onlineServiceIds(db: Db, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const cutoff = new Date(Date.now() - SERVICE_ONLINE_MS).toISOString();
  return rowsOf<{ id: string }>(
    db,
    `SELECT id FROM dsh_instances WHERE id IN (${placeholders}) AND revoked_at IS NULL
       AND last_seen_at IS NOT NULL AND last_seen_at >= ? ORDER BY id ASC`,
    [...ids, cutoff],
  ).map((row) => row.id);
}

/** 项目内轮询选择智能体；在线候选按 ID 稳定排序，cursor 存在 meta 里。 */
function fairPickService(db: Db, projectId: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const key = `service_cursor:${projectId}`;
  const row = rowOf<{ value: string }>(db, 'SELECT value FROM meta WHERE key = ?', [key]);
  const cursor = Number.parseInt(row?.value ?? '0', 10) || 0;
  const chosen = candidates[cursor % candidates.length]!;
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(cursor + 1));
  return chosen;
}

export function createTaskRecord(db: Db, bus: EventBus, input: CreateTaskRecordInput): WorkItem {
  const project = getProjectRow(db, input.projectId);
  if (!project) throw errors.notFound('项目不存在');
  // Ryan 的执行者永远是人员：自动化/Webhook 没有显式创建人时落到项目负责人。
  const effectiveCreatedBy = input.createdBy ?? project.owner_person_id ?? null;
  if (!effectiveCreatedBy) throw errors.conflict('项目没有负责人，无法确定 人员@Ryan 执行者');
  const creator = rowOf<{ name: string }>(db, 'SELECT name FROM persons WHERE id = ?', [effectiveCreatedBy]);
  if (!creator) throw errors.conflict('任务创建人不存在，无法确定 人员@Ryan 执行者');
  const mentions = input.skipMentions ? [] : parseMentions(db, input.prompt);
  const immediateAgentIds = mentions.filter((mention) => mention.kind === 'agent' && mention.when === 'now').map((mention) => mention.id);
  const completionMentions = mentions.filter((mention) => mention.when === 'completion');
  const boundServiceIds = projectServiceIds(db, input.projectId);
  const requestedServices = [...new Set(input.instanceIds ?? (input.instanceId ? [input.instanceId] : []))];
  const explicitServices = requestedServices.length > 0 ? requestedServices : [...new Set(immediateAgentIds)];
  for (const serviceId of explicitServices) {
    const service = rowOf<{ ok: number }>(
      db,
      'SELECT 1 AS ok FROM dsh_instances WHERE id = ? AND revoked_at IS NULL',
      [serviceId],
    );
    if (!service) throw errors.badRequest(`智能体不存在或已吊销：${serviceId}`);
    if (boundServiceIds.length > 0 && !boundServiceIds.includes(serviceId)) {
      throw errors.badRequest(`智能体 ${serviceId} 未绑定当前项目`);
    }
  }
  // 有项目绑定：只在绑定智能体中轮询；无绑定：优先默认智能体，未设置则共享池。
  const configuredDefault = boundServiceIds.length === 0 ? getDefaultServiceId(db) : undefined;
  const defaultServiceId = configuredDefault
    ? (rowOf<{ id: string }>(db, 'SELECT id FROM dsh_instances WHERE id = ? AND revoked_at IS NULL', [configuredDefault])?.id ?? null)
    : null;
  const allowedServiceIds = explicitServices.length > 0
    ? explicitServices
    : boundServiceIds.length > 0
      ? boundServiceIds
      : defaultServiceId ? [defaultServiceId] : [];
  let scheduledServiceId: string | null = null;
  if (explicitServices.length === 1) {
    scheduledServiceId = explicitServices[0]!;
  } else if (allowedServiceIds.length > 0) {
    scheduledServiceId = fairPickService(db, input.projectId, onlineServiceIds(db, allowedServiceIds));
  }
  const explicitCardIds = [...new Set(input.promptCardIds ?? [])];
  const handoffCardIds = [...new Set(input.handoffPromptCardIds ?? [])];
  const validationCardIds = [...new Set([...explicitCardIds, ...handoffCardIds])];
  if (validationCardIds.length > 0) {
    const placeholders = validationCardIds.map(() => '?').join(', ');
    const found = rowsOf<{ id: string; scope: string; project_id: string | null; team_id: string | null; person_id: string | null }>(
      db,
      `SELECT id, scope, project_id, team_id, person_id FROM prompt_cards WHERE enabled = 1 AND id IN (${placeholders})`,
      validationCardIds,
    );
    if (found.length !== validationCardIds.length) throw errors.badRequest('引用的提示卡不存在或已停用');
    if (
      found.some(
        (card) =>
          (card.scope === 'team' && card.team_id !== project.owner_team_id) ||
          (card.scope === 'project' && card.project_id !== input.projectId) ||
          (card.scope === 'person' && card.person_id !== effectiveCreatedBy),
      )
    ) {
      throw errors.badRequest('引用的提示卡不在当前项目可用范围内');
    }
  }
  const handoffPersonId = input.handoffPersonId ?? null;
  if (handoffPersonId) {
    const handoffPerson = rowOf<{ id: string; is_admin: number; name: string }>(db, 'SELECT id, is_admin, name FROM persons WHERE id = ?', [handoffPersonId]);
    if (!handoffPerson) throw errors.badRequest('接力人员不存在');
    if (!canContributeProject(db, { id: handoffPerson.id, isAdmin: Number(handoffPerson.is_admin) === 1 }, project)) {
      throw errors.badRequest('接力人员没有该项目任务权限');
    }
  }
  const notifyPersonIds = [...new Set([...(input.notifyPersonIds ?? []), ...(handoffPersonId ? [handoffPersonId] : [])])];
  for (const personId of notifyPersonIds) {
    if (!rowOf<{ id: string }>(db, 'SELECT id FROM persons WHERE id = ?', [personId])) throw errors.badRequest('通知人员不存在');
  }
  const cardIds = [...new Set([...explicitCardIds, ...autoInjectCardIds(db, input.projectId, effectiveCreatedBy)])];

  const id = newId('tsk');
  const createdAt = nowIso();
  const source = input.source ?? 'human';
  const type = input.type ?? 'feature';
  const title = input.title.trim();
  const prompt = withGoalPrefix(input.prompt);
  const executorName = creator.name;
  db.prepare(
    `INSERT INTO work_items
       (id, project_id, source, type, title, prompt, prompt_card_ids, handoff_person_id, handoff_prompt_card_ids, handoff_note, notify_person_ids, status, priority, lease_until, instance_id,
        allowed_service_ids, created_by, executor_person_id, created_at, started_at, finished_at, result, error, metadata, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.projectId,
    source,
    type,
    title,
    prompt,
    JSON.stringify(cardIds),
    handoffPersonId,
    JSON.stringify(handoffCardIds),
    input.handoffNote ?? '',
    JSON.stringify(notifyPersonIds),
    input.priority ?? 0,
    scheduledServiceId,
    JSON.stringify(allowedServiceIds),
    effectiveCreatedBy,
    effectiveCreatedBy,
    createdAt,
    JSON.stringify({
      ...(input.metadata ?? {}),
      ...(mentions.length ? { mentions: mentions.map((mention) => ({ kind: mention.kind, id: mention.id, name: mention.name, when: mention.when })) } : {}),
    }),
    input.dedupeKey ?? null,
  );

  insertTaskEvent(db, {
    taskId: id,
    projectId: input.projectId,
    type: 'task.created',
    message: input.eventMessage ?? `创建任务：${title}`,
    payload: { source, type, promptCardIds: cardIds, allowedServiceIds, instanceId: scheduledServiceId },
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
  for (const mention of mentions.filter((entry) => entry.kind === 'person' && entry.when === 'now')) {
    createTaskNotification(db, {
      personId: mention.id,
      taskId: id,
      projectId: input.projectId,
      type: 'task.mention',
      title: `任务提及：${title}`,
      body: `${executorLabel(creator.name)} 在任务中提到了你。`,
    });
  }
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
  title: z.string().trim().max(300).optional(),
  prompt: z.string().min(1).max(20_000),
  promptCardIds: z.array(z.string().min(1)).max(20).optional(),
  handoffPersonId: z.string().min(1).optional(),
  handoffPromptCardIds: z.array(z.string().min(1)).max(20).optional(),
  handoffNote: z.string().max(4_000).optional(),
  notifyPersonIds: z.array(z.string().min(1)).max(20).optional(),
  instanceId: z.string().min(1).optional(),
  instanceIds: z.array(z.string().min(1)).max(50).optional(),
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
    for (const item of items) {
      item.promptCards = cardsForTask(db, item.promptCardIds);
      if (item.allowedServiceIds?.length) item.allowedServiceNames = serviceNamesForTask(db, item.allowedServiceIds);
    }
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
        projectId: project.id,
        memoryAgentId: memoryAgentIdOf(rc.app.db, project.id) ?? undefined,
        configured: true,
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
    const title = input.title?.trim() || await generateTaskTitle(input.prompt);
    const task = createTaskRecord(rc.app.db, rc.app.bus, {
      projectId,
      title,
      prompt: input.prompt,
      promptCardIds: input.promptCardIds,
      handoffPersonId: input.handoffPersonId,
      handoffPromptCardIds: input.handoffPromptCardIds,
      handoffNote: input.handoffNote,
      notifyPersonIds: input.notifyPersonIds,
      instanceId: input.instanceId,
      instanceIds: input.instanceIds,
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
    throw errors.conflict('Ryan 任务不支持对话，只展示执行过程');
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
