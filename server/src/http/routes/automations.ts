/**
 * 自动化 API（会话鉴权）：CRUD、手动运行、运行历史、入站投递记录。
 * 运行 / 调度 / Webhook 共用 createAutomationTask 建任务。
 */
import { z } from 'zod';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { canManageProject, getProjectRow } from '../../lib/access.ts';
import type { EventBus } from '../../lib/bus.ts';
import type { Db } from '../../db/index.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import { isValidCron } from '../../runtime/cron.ts';
import { renderTemplate } from '../../runtime/template.ts';
import { parseJsonObject, parseStringArray } from './tasks.ts';
import { createTaskRecord } from './tasks.ts';
import { checkUserInput } from '../../security/check.ts';
import type {
  Automation,
  AutomationRun,
  AutomationTrigger,
  InboundDelivery,
  WorkItem,
} from '../../../../shared/src/types.ts';

// ---------------------------------------------------------------------------
// 行类型 / SQL
// ---------------------------------------------------------------------------

export interface AutomationRow {
  id: string;
  project_id: string;
  instance_id: string | null;
  prompt_card_ids: string;
  name: string;
  trigger_type: string;
  trigger_config: string;
  prompt_template: string;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
  project_name?: string | null;
  instance_name?: string | null;
}

export const AUTOMATION_SELECT = `
  SELECT a.*, p.name AS project_name, i.name AS instance_name
    FROM automations a
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN dsh_instances i ON i.id = a.instance_id
`;

interface DeliveryRow {
  id: string;
  project_id: string;
  provider: string;
  delivery_id: string;
  event: string;
  status: string;
  task_id: string | null;
  created_at: string;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  task_id: string | null;
  status: string;
  trigger: string;
  created_at: string;
}

function rowsOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function rowOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function getAutomationRow(db: Db, id: string): AutomationRow | null {
  return rowOf<AutomationRow>(db, `${AUTOMATION_SELECT} WHERE a.id = ?`, [id]) ?? null;
}

// ---------------------------------------------------------------------------
// triggerConfig 解析 / 校验
// ---------------------------------------------------------------------------

export function parseTriggerConfig(raw: string | null | undefined): Automation['triggerConfig'] {
  const source = parseJsonObject(raw);
  const config: Automation['triggerConfig'] = {};
  if (Array.isArray(source.events)) {
    const events = source.events.filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (events.length > 0) config.events = events;
  }
  if (typeof source.branch === 'string' && source.branch.length > 0) config.branch = source.branch;
  if (typeof source.schedule === 'string' && source.schedule.length > 0) config.schedule = source.schedule;
  if (typeof source.secret === 'string' && source.secret.length > 0) config.secret = source.secret;
  return config;
}

const triggerConfigSchema = z.object({
  events: z.array(z.string().trim().min(1)).max(50).optional(),
  branch: z.string().trim().max(200).optional(),
  schedule: z.string().trim().max(100).optional(),
  secret: z.string().trim().max(300).optional(),
});

function normalizeTriggerConfig(
  triggerType: AutomationTrigger,
  raw: Automation['triggerConfig'] | undefined,
): Automation['triggerConfig'] {
  const parsed = triggerConfigSchema.parse(raw ?? {});
  if (triggerType === 'manual') {
    const keys = Object.keys(parsed);
    if (keys.length > 0) throw errors.badRequest('手动触发器不接受 triggerConfig');
    return {};
  }
  if (triggerType === 'webhook') {
    if (!parsed.events || parsed.events.length === 0) {
      throw errors.badRequest('Webhook 触发器需要 events 列表');
    }
    if (!parsed.secret) throw errors.badRequest('Webhook 触发器需要 secret');
    const config: Automation['triggerConfig'] = { events: parsed.events, secret: parsed.secret };
    if (parsed.branch) config.branch = parsed.branch;
    return config;
  }
  if (!parsed.schedule) throw errors.badRequest('定时触发器需要 schedule cron 表达式');
  if (!isValidCron(parsed.schedule)) {
    throw errors.badRequest(`cron 表达式不合法：${parsed.schedule}`);
  }
  return { schedule: parsed.schedule };
}

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------

function mapAutomation(row: AutomationRow, canManage: boolean): Automation {
  const stored = parseTriggerConfig(row.trigger_config);
  const triggerConfig: Automation['triggerConfig'] =
    !canManage && stored.secret ? { ...stored, secret: '***' } : stored;
  const automation: Automation = {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? '',
    name: row.name,
    triggerType: row.trigger_type as AutomationTrigger,
    triggerConfig,
    promptTemplate: row.prompt_template,
    promptCardIds: parseStringArray(row.prompt_card_ids),
    enabled: Number(row.enabled) === 1,
    createdAt: row.created_at,
  };
  if (row.instance_id) automation.instanceId = row.instance_id;
  if (row.instance_name) automation.instanceName = row.instance_name;
  if (row.created_by) automation.createdBy = row.created_by;
  if (row.last_run_at) automation.lastRunAt = row.last_run_at;
  if (row.last_run_status) automation.lastRunStatus = row.last_run_status;
  return automation;
}

function mapAutomationRun(row: AutomationRunRow): AutomationRun {
  const run: AutomationRun = {
    id: row.id,
    automationId: row.automation_id,
    status: row.status,
    trigger: row.trigger,
    createdAt: row.created_at,
  };
  if (row.task_id) run.taskId = row.task_id;
  return run;
}

function mapDelivery(row: DeliveryRow): InboundDelivery {
  const delivery: InboundDelivery = {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider as InboundDelivery['provider'],
    deliveryId: row.delivery_id,
    event: row.event,
    status: row.status as InboundDelivery['status'],
    createdAt: row.created_at,
  };
  if (row.task_id) delivery.taskId = row.task_id;
  return delivery;
}

function canManage(rc: RequestContext, projectId: string, person: { id: string; isAdmin: boolean }): boolean {
  const project = getProjectRow(rc.app.db, projectId);
  if (!project) return false;
  return canManageProject(rc.app.db, { id: person.id, isAdmin: person.isAdmin }, project);
}

// ---------------------------------------------------------------------------
// 共用的建任务（手动运行 / cron 调度）
// ---------------------------------------------------------------------------

export interface AutomationDispatchOptions {
  /** 触发来源：manual / cron / webhook */
  trigger: string;
  /** 活动流操作者名称 */
  actorName: string;
  /** 模板变量 */
  variables: Record<string, string>;
  createdBy?: string | null;
  /** 触发时刻（ISO）；调度器传入当前 tick 时间，保证「同一分钟只触发一次」可判定。 */
  at?: string;
}

export interface AutomationDispatchResult {
  task: WorkItem;
  runId: string;
}

/** 按自动化配置创建任务 + 运行记录 + 更新 last_run_*（source=automation）。 */
export function createAutomationTask(
  db: Db,
  bus: EventBus,
  row: AutomationRow,
  options: AutomationDispatchOptions,
): AutomationDispatchResult {
  const prompt = renderTemplate(row.prompt_template, options.variables);
  const task = createTaskRecord(db, bus, {
    projectId: row.project_id,
    source: 'automation',
    title: `[自动化] ${row.name}`,
    prompt,
    promptCardIds: parseStringArray(row.prompt_card_ids),
    instanceId: row.instance_id,
    priority: 0,
    createdBy: options.createdBy ?? null,
    metadata: {
      automationId: row.id,
      automationName: row.name,
      trigger: options.trigger,
      variables: options.variables,
    },
    actorName: options.actorName,
    activitySummary: `自动化触发：${row.name}`,
    eventMessage: `自动化触发：${row.name}（${options.trigger}）`,
  });

  const runId = newId('run');
  const at = options.at ?? nowIso();
  db.prepare(
    `INSERT INTO automation_runs (id, automation_id, task_id, status, trigger, created_at)
     VALUES (?, ?, ?, 'success', ?, ?)`,
  ).run(runId, row.id, task.id, options.trigger, at);
  db.prepare(
    'UPDATE automations SET last_run_at = ?, last_run_status = ?, updated_at = ? WHERE id = ?',
  ).run(at, 'success', at, row.id);
  return { task, runId };
}

// ---------------------------------------------------------------------------
// 请求 schema
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  instanceId: z.string().min(1).optional(),
  promptCardIds: z.array(z.string().min(1)).max(20).optional(),
  triggerType: z.enum(['manual', 'webhook', 'cron']),
  triggerConfig: triggerConfigSchema.optional(),
  promptTemplate: z.string().min(1).max(20_000),
  enabled: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  instanceId: z.string().min(1).nullable().optional(),
  promptCardIds: z.array(z.string().min(1)).max(20).optional(),
  triggerType: z.enum(['manual', 'webhook', 'cron']).optional(),
  triggerConfig: triggerConfigSchema.optional(),
  promptTemplate: z.string().min(1).max(20_000).optional(),
  enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function registerAutomationRoutes(router: Router): void {
  // GET /api/projects/:id/automations —— 项目自动化列表（非 manage 隐藏 secret）
  router.get('/api/projects/:id/automations', (rc) => {
    const person = requirePerson(rc);
    const project = requireProject(rc, rc.params.id, 'view');
    const manage = canManageProject(rc.app.db, { id: person.id, isAdmin: person.isAdmin }, project);
    const rows = rowsOf<AutomationRow>(
      rc.app.db,
      `${AUTOMATION_SELECT} WHERE a.project_id = ? ORDER BY a.created_at DESC`,
      [project.id],
    );
    rc.json(rows.map((row) => mapAutomation(row, manage)));
  });

  // POST /api/projects/:id/automations —— 创建自动化（需 contribute）
  router.post('/api/projects/:id/automations', async (rc) => {
    const person = requirePerson(rc);
    const project = requireProject(rc, rc.params.id, 'contribute');
    const input = await rc.body(createSchema);
    const security = await checkUserInput({
      db: rc.app.db,
      personId: person.id,
      source: 'automation',
      content: `${input.name}\n${input.promptTemplate}`,
    });
    if (!security.allowed) throw errors.badRequest(security.blockedMessage ?? '输入未通过安全检查');

    const triggerConfig = normalizeTriggerConfig(input.triggerType, input.triggerConfig);
    const id = newId('aut');
    const now = nowIso();
    rc.app.db
      .prepare(
        `INSERT INTO automations
           (id, project_id, instance_id, name, trigger_type, trigger_config, prompt_template,
            prompt_card_ids, enabled, created_by, created_at, updated_at, last_run_at, last_run_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        project.id,
        input.instanceId ?? null,
        input.name,
        input.triggerType,
        JSON.stringify(triggerConfig),
        input.promptTemplate,
        JSON.stringify(input.promptCardIds ?? []),
        input.enabled === false ? 0 : 1,
        person.id,
        now,
        now,
      );

    const row = getAutomationRow(rc.app.db, id);
    if (!row) throw errors.internal('自动化创建后读取失败');
    rc.json(mapAutomation(row, canManage(rc, project.id, person)));
  });

  // PATCH /api/automations/:id —— 部分更新（enabled 切换等）
  router.patch('/api/automations/:id', async (rc) => {
    const person = requirePerson(rc);
    const row = getAutomationRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('自动化不存在');
    requireProject(rc, row.project_id, 'contribute');
    const input = await rc.body(patchSchema);
    if (input.promptTemplate || input.name) {
      const security = await checkUserInput({
        db: rc.app.db,
        personId: person.id,
        source: 'automation',
        content: `${input.name ?? row.name}\n${input.promptTemplate ?? row.prompt_template}`,
      });
      if (!security.allowed) throw errors.badRequest(security.blockedMessage ?? '输入未通过安全检查');
    }

    const nextType = (input.triggerType ?? row.trigger_type) as AutomationTrigger;
    const typeChanged = input.triggerType !== undefined && input.triggerType !== row.trigger_type;
    // 只有触发类型 / 配置发生变化时才校验并重写 trigger_config；
    // 仅切换 enabled 等字段时保留原配置（避免历史坏配置导致无法停用）。
    let nextConfigJson = row.trigger_config;
    if (input.triggerType !== undefined || input.triggerConfig !== undefined) {
      // 切换触发类型时不再合并旧配置（如 webhook→manual 应清空），同类型时做部分合并。
      const baseConfig = typeChanged ? undefined : parseTriggerConfig(row.trigger_config);
      const mergedConfig =
        input.triggerConfig !== undefined
          ? { ...(baseConfig ?? {}), ...input.triggerConfig }
          : baseConfig;
      nextConfigJson = JSON.stringify(normalizeTriggerConfig(nextType, mergedConfig));
    }

    rc.app.db
      .prepare(
        `UPDATE automations
            SET name = ?, instance_id = ?, trigger_type = ?, trigger_config = ?,
                prompt_template = ?, prompt_card_ids = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.name ?? row.name,
        input.instanceId === undefined ? row.instance_id : input.instanceId,
        nextType,
        nextConfigJson,
        input.promptTemplate ?? row.prompt_template,
        JSON.stringify(input.promptCardIds ?? parseStringArray(row.prompt_card_ids)),
        input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
        nowIso(),
        row.id,
      );

    const updated = getAutomationRow(rc.app.db, row.id);
    if (!updated) throw errors.internal('自动化更新后读取失败');
    rc.json(mapAutomation(updated, canManage(rc, row.project_id, person)));
  });

  // DELETE /api/automations/:id —— 删除自动化
  router.delete('/api/automations/:id', (rc) => {
    const person = requirePerson(rc);
    const row = getAutomationRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('自动化不存在');
    requireProject(rc, row.project_id, 'contribute');
    rc.app.db.prepare('DELETE FROM automations WHERE id = ?').run(row.id);
    rc.json({ ok: true });
  });

  // POST /api/automations/:id/run —— 手动触发
  router.post('/api/automations/:id/run', (rc) => {
    const person = requirePerson(rc);
    const row = getAutomationRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('自动化不存在');
    const project = requireProject(rc, row.project_id, 'contribute');
    const config = parseTriggerConfig(row.trigger_config);

    const { task } = createAutomationTask(rc.app.db, rc.app.bus, row, {
      trigger: 'manual',
      actorName: person.name,
      createdBy: person.id,
      variables: {
        project: project.name,
        event: 'manual',
        title: row.name,
        url: '',
        actor: person.name,
        branch: config.branch ?? '',
      },
    });
    rc.json({ task });
  });

  // GET /api/automations/:id/runs —— 运行历史
  router.get('/api/automations/:id/runs', (rc) => {
    requirePerson(rc);
    const row = getAutomationRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('自动化不存在');
    requireProject(rc, row.project_id, 'view');
    const runs = rowsOf<AutomationRunRow>(
      rc.app.db,
      'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
      [row.id],
    );
    rc.json(runs.map(mapAutomationRun));
  });

  // GET /api/projects/:id/deliveries —— 入站 Webhook 投递记录
  router.get('/api/projects/:id/deliveries', (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id, 'view');
    const deliveries = rowsOf<DeliveryRow>(
      rc.app.db,
      'SELECT * FROM inbound_deliveries WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
      [project.id],
    );
    rc.json(deliveries.map(mapDelivery));
  });
}
