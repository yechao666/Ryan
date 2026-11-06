/**
 * 运行时 API：DSH 实例的注册、心跳、领单、进展、消息与完成写回。
 * 鉴权只用 Bearer Agent token / Instance token（不使用会话）。
 */
import { z } from 'zod';
import type { Router } from '../router.ts';
import type { CurrentAgent, RequestContext } from '../context.ts';
import { authenticateAgent, authenticateInstance, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { getProjectRow } from '../../lib/access.ts';
import { recordActivity } from '../../lib/activity.ts';
import { tx } from '../../db/index.ts';
import type { Db } from '../../db/index.ts';
import { newId, nowIso, randomToken, sha256 } from '../../lib/ids.ts';
import type {
  CompleteTaskInput,
  Instance,
  InstanceStatus,
  ProjectType,
  RuntimeEvent,
  TaskMessage,
  WorkItem,
} from '../../../../shared/src/types.ts';
import {
  getTaskRow,
  insertTaskEvent,
  insertTaskMessage,
  listTaskMessages,
  mapWorkItem,
  parseJsonObject,
  parseStringArray,
  truncateSummary,
  type TaskRow,
} from './tasks.ts';
import {
  add as mnemosAdd,
  memoryAgentIdOf,
  memoryConfigFor,
  taskMemoryText,
} from '../../memory/mnemos.ts';

const LEASE_MS = 3 * 60_000;

// ---------------------------------------------------------------------------
// 行类型与工具
// ---------------------------------------------------------------------------

interface InstanceRow {
  id: string;
  agent_id: string;
  token_hash: string;
  name: string;
  host: string;
  workspace_path: string;
  version: string;
  status: string;
  registered_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

function rowOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function rowsOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function functionAgent(rc: RequestContext): CurrentAgent {
  if (!rc.agent) throw errors.unauthorized();
  return rc.agent;
}

function mapInstance(
  row: InstanceRow,
  agentName: string,
  currentTask?: Instance['currentTask'],
): Instance {
  const instance: Instance = {
    id: row.id,
    agentId: row.agent_id,
    agentName,
    name: row.name,
    host: row.host,
    workspacePath: row.workspace_path,
    version: row.version,
    status: row.status as InstanceStatus,
    registeredAt: row.registered_at,
  };
  if (row.last_seen_at) instance.lastSeenAt = row.last_seen_at;
  if (row.revoked_at) instance.revokedAt = row.revoked_at;
  if (currentTask) instance.currentTask = currentTask;
  return instance;
}

function getInstanceRow(db: Db, id: string): InstanceRow | null {
  return rowOf<InstanceRow>(db, 'SELECT * FROM dsh_instances WHERE id = ?', [id]) ?? null;
}

function noContent(rc: RequestContext): void {
  rc.res.statusCode = 204;
  rc.res.setHeader('x-request-id', rc.requestId);
  rc.res.end();
}

function leaseUntil(): string {
  return new Date(Date.now() + LEASE_MS).toISOString();
}

/** 校验任务存在且属于该实例。 */
function requireInstanceTask(db: Db, taskId: string, instanceId: string): TaskRow {
  const task = getTaskRow(db, taskId);
  if (!task) throw errors.notFound('任务不存在');
  if (task.instance_id !== instanceId) throw errors.forbidden('任务不属于当前实例');
  return task;
}

/** 任务消息：活动任务要求同一实例；已完成任务允许同一 Agent 的任意实例续聊。 */
function requireMessageTask(db: Db, taskId: string, agentId: string, instanceId: string): TaskRow {
  const task = getTaskRow(db, taskId);
  if (!task) throw errors.notFound('任务不存在');
  if (task.agent_id !== agentId) throw errors.forbidden('任务不属于当前智员');
  if (['done', 'failed', 'cancelled'].includes(task.status)) {
    throw errors.conflict('任务已结束，不支持继续对话');
  }
  if (task.instance_id !== instanceId) {
    throw errors.forbidden('任务不属于当前实例');
  }
  return task;
}

function currentTaskOf(db: Db, instanceId: string): Instance['currentTask'] | undefined {
  const row = rowOf<{ id: string; title: string; project_name: string }>(
    db,
    `SELECT w.id, w.title, p.name AS project_name
       FROM work_items w JOIN projects p ON p.id = w.project_id
      WHERE w.instance_id = ? AND w.status IN ('running', 'waiting_input')
      ORDER BY w.started_at DESC LIMIT 1`,
    [instanceId],
  );
  return row ? { id: row.id, title: row.title, projectName: row.project_name } : undefined;
}

/** 完成写回：调用 Mnemos 写入项目共享记忆；失败只 warn，绝不影响任务结果。 */
async function writeBackTaskMemory(
  rc: RequestContext,
  task: TaskRow,
  input: CompleteTaskInput,
): Promise<void> {
  const project = getProjectRow(rc.app.db, task.project_id);
  if (!project) return;
  const config = memoryConfigFor(rc.app.env, project);
  if (!config) return;
  const memoryAgentId = memoryAgentIdOf(rc.app.db, project.id, task.agent_id);
  if (!memoryAgentId) {
    console.warn(`[hive] 任务 ${task.id} 记忆写回跳过：项目未绑定记忆身份`);
    return;
  }
  const text = taskMemoryText({
    title: task.title,
    summary: input.summary,
    decisions: input.decisions,
    lessons: input.lessons,
  });
  try {
    await mnemosAdd(config, {
      text,
      agentId: memoryAgentId,
      metadata: { hiveTaskId: task.id, projectId: project.id, agentId: task.agent_id },
    });
  } catch (error) {
    console.warn(
      `[hive] 任务 ${task.id} 记忆写回失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 请求 schema
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().max(200).optional().default(''),
  workspacePath: z.string().trim().max(500).optional().default(''),
  version: z.string().trim().max(80).optional().default(''),
});

const progressSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  payload: z.record(z.unknown()).optional(),
});

const messageSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
});

const runtimeEventsSchema = z.object({
  events: z
    .array(
      z.object({
        type: z.string().trim().min(1).max(60),
        payload: z.record(z.unknown()).optional(),
        at: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
});

const completeSchema = z.object({
  status: z.enum(['done', 'failed']),
  summary: z.string().trim().min(1).max(20_000),
  decisions: z.array(z.string().max(4_000)).max(100).optional(),
  lessons: z.array(z.string().max(4_000)).max(100).optional(),
  error: z.string().max(20_000).optional(),
  sessionId: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------


function runtimeSummary(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'session':
      return 'DSH 会话启动';
    case 'tool_call':
      return `调用工具 ${String(payload.tool ?? 'tool')}`;
    case 'tool_result':
      return `工具结果 ${String(payload.status ?? '')}`.trim();
    case 'text':
      return `输出：${String(payload.text ?? '').slice(0, 80)}`;
    case 'thinking':
      return '模型思考';
    case 'status':
      return `阶段 ${String(payload.phase ?? '')}`.trim();
    case 'final':
      return '执行完成';
    case 'error':
      return `运行错误：${String(payload.message ?? '').slice(0, 80)}`;
    default:
      return type;
  }
}

export function registerRuntimeRoutes(router: Router): void {
  // POST /api/runtime/instances/register —— 用 Agent token 注册实例
  router.post('/api/runtime/instances/register', async (rc) => {
    const agent = authenticateAgent(rc);
    const input = await rc.body(registerSchema);
    const db = rc.app.db;
    const id = newId('ins');
    const token = `hive_inst_${randomToken(24)}`;
    const now = nowIso();
    db.prepare(
      `INSERT INTO dsh_instances
         (id, agent_id, token_hash, name, host, workspace_path, version, status, registered_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
    ).run(id, agent.id, sha256(token), input.name, input.host, input.workspacePath, input.version, now, now);

    recordActivity(db, rc.app.bus, {
      type: 'instance.online',
      actor: agent.name,
      summary: `实例 ${input.name} 上线`,
      agentId: agent.id,
    });

    const row = getInstanceRow(db, id);
    if (!row) throw errors.internal('实例注册后读取失败');
    rc.json({ instance: mapInstance(row, agent.name), token }, 201);
  });

  // POST /api/runtime/instances/heartbeat —— 实例心跳
  router.post('/api/runtime/instances/heartbeat', (rc) => {
    const instance = authenticateInstance(rc);
    const db = rc.app.db;
    const now = nowIso();
    db.prepare("UPDATE dsh_instances SET last_seen_at = ?, status = 'online' WHERE id = ?").run(now, instance.id);
    const pending = rowOf<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c
         FROM work_items w JOIN projects p ON p.id = w.project_id
        WHERE w.agent_id = ? AND w.status = 'queued' AND p.status = 'active'`,
      [rc.agent?.id ?? instance.agentId],
    );
    rc.json({
      ok: true,
      instance: { id: instance.id, name: instance.name, lastSeenAt: now },
      pending: { queued: Number(pending?.c ?? 0) },
    });
  });

  // POST /api/runtime/tasks/claim —— 领一个任务；无任务返回 204
  router.post('/api/runtime/tasks/claim', (rc) => {
    const instance = authenticateInstance(rc);
    const agent = functionAgent(rc);
    const db = rc.app.db;
    const now = nowIso();

    // 先回收租约过期的任务（running 且 lease 已过期 → 重新排队）
    db.prepare(
      `UPDATE work_items
          SET status = 'queued', instance_id = NULL, lease_until = NULL
        WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
    ).run(now);

    // 同一实例同时只允许 1 个 running 任务
    const running = rowOf<{ id: string }>(
      db,
      "SELECT id FROM work_items WHERE instance_id = ? AND status = 'running' LIMIT 1",
      [instance.id],
    );
    if (running) {
      noContent(rc);
      return;
    }

    const lease = leaseUntil();
    const claimedId = tx(db, () => {
      const candidate = rowOf<{ id: string }>(
        db,
        `SELECT w.id FROM work_items w JOIN projects p ON p.id = w.project_id
          WHERE w.agent_id = ? AND w.status = 'queued' AND p.status = 'active'
          ORDER BY w.priority DESC, w.created_at ASC
          LIMIT 1`,
        [agent.id],
      );
      if (!candidate) return null;
      const changed = db
        .prepare(
          `UPDATE work_items
              SET status = 'running', instance_id = ?, started_at = ?, lease_until = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .run(instance.id, now, lease, candidate.id);
      return Number(changed.changes) === 1 ? candidate.id : null;
    });

    if (!claimedId) {
      noContent(rc);
      return;
    }

    const task = getTaskRow(db, claimedId);
    if (!task) {
      noContent(rc);
      return;
    }

    insertTaskEvent(db, {
      taskId: task.id,
      projectId: task.project_id,
      instanceId: instance.id,
      type: 'task.claimed',
      message: `实例 ${instance.name} 接单`,
      payload: { instanceId: instance.id, agentId: agent.id },
    });
    recordActivity(db, rc.app.bus, {
      projectId: task.project_id,
      projectName: task.project_name ?? undefined,
      type: 'task.claimed',
      actor: agent.name,
      summary: `接单：${task.title}`,
      taskId: task.id,
      agentId: agent.id,
    });

    const project = getProjectRow(db, task.project_id);
    const binding = rowOf<{ memory_agent_id: string }>(
      db,
      'SELECT memory_agent_id FROM project_agents WHERE project_id = ? AND agent_id = ?',
      [task.project_id, task.agent_id],
    );
    const agentRow = rowOf<{ capabilities: string }>(db, 'SELECT capabilities FROM agents WHERE id = ?', [agent.id]);
    const memoryAgentId = binding?.memory_agent_id ?? '';
    const memoryConfig = project ? memoryConfigFor(rc.app.env, project) : null;

    rc.json({
      task: mapWorkItem(task),
      project: {
        id: project?.id ?? task.project_id,
        name: project?.name ?? task.project_name ?? '',
        slug: project?.slug ?? task.project_slug ?? '',
        prompt: project?.prompt ?? '',
        repoUrl: project?.repo_url ?? undefined,
        type: (project?.type ?? task.project_type ?? 'manual') as ProjectType,
      },
      agent: {
        id: agent.id,
        name: agent.name,
        memoryAgentId,
        capabilities: parseStringArray(agentRow?.capabilities),
      },
      memory: {
        baseUrl: rc.app.env.mnemosBaseUrl,
        projectId: memoryConfig?.projectId ?? project?.mnemos_project_id ?? '',
        apiKey: memoryConfig?.apiKey ?? project?.mnemos_api_key ?? '',
        agentId: memoryAgentId,
        enabled: Boolean(memoryConfig),
      },
      messages: listTaskMessages(db, task.id),
    });
  });

  // POST /api/runtime/tasks/:id/progress —— 上报进展并续租
  router.post('/api/runtime/tasks/:id/progress', async (rc) => {
    const instance = authenticateInstance(rc);
    const agent = functionAgent(rc);
    const db = rc.app.db;
    const task = requireInstanceTask(db, rc.params.id, instance.id);
    const input = await rc.body(progressSchema);

    const event = insertTaskEvent(db, {
      taskId: task.id,
      projectId: task.project_id,
      instanceId: instance.id,
      type: 'task.progress',
      message: input.message,
      payload: input.payload ?? {},
    });
    db.prepare('UPDATE work_items SET lease_until = ? WHERE id = ?').run(leaseUntil(), task.id);
    recordActivity(db, rc.app.bus, {
      projectId: task.project_id,
      projectName: task.project_name ?? undefined,
      type: 'task.progress',
      actor: agent.name,
      summary: truncateSummary(input.message),
      taskId: task.id,
      agentId: agent.id,
    });

    rc.json({ ok: true, event });
  });

  // POST /api/runtime/tasks/:id/messages —— 任务只展示执行过程，不接受智员留言。
  router.post('/api/runtime/tasks/:id/messages', async (rc) => {
    authenticateInstance(rc);
    functionAgent(rc);
    throw errors.conflict('任务仅展示执行过程，不支持对话');
  });

  // GET /api/runtime/tasks/:id/messages?since=ISO —— 拉取任务消息
  router.get('/api/runtime/tasks/:id/messages', (rc) => {
    const instance = authenticateInstance(rc);
    const agent = functionAgent(rc);
    const db = rc.app.db;
    const task = requireMessageTask(db, rc.params.id, agent.id, instance.id);
    const since = rc.url.searchParams.get('since') ?? undefined;
    if (since !== undefined) {
      if (!since.trim() || Number.isNaN(Date.parse(since))) {
        throw errors.badRequest('since 必须是合法的 ISO 时间');
      }
    }
    const messages: TaskMessage[] = listTaskMessages(db, task.id, since);
    rc.json(messages);
  });

  // POST /api/runtime/tasks/:id/complete —— 完成任务 / 标记失败 + 记忆写回
  router.post('/api/runtime/tasks/:id/complete', async (rc) => {
    const instance = authenticateInstance(rc);
    const agent = functionAgent(rc);
    const db = rc.app.db;
    const task = requireInstanceTask(db, rc.params.id, instance.id);
    const input = await rc.body(completeSchema);

    if (!['queued', 'assigned', 'running', 'waiting_input'].includes(task.status)) {
      throw errors.conflict('任务已结束，不能重复完成');
    }

    const now = nowIso();
    const result = input.status === 'done' ? input.summary : null;
    const errorText = input.status === 'failed' ? input.error?.trim() || input.summary : null;
    const metadata = parseJsonObject(task.metadata);
    if (input.sessionId) metadata.hiveHeadlessSessionId = input.sessionId;
    db.prepare(
      `UPDATE work_items
          SET status = ?, finished_at = ?, result = ?, error = ?, lease_until = NULL, metadata = ?
        WHERE id = ?`,
    ).run(input.status, now, result, errorText, JSON.stringify(metadata), task.id);

    insertTaskMessage(db, {
      taskId: task.id,
      authorType: 'agent',
      authorId: agent.id,
      authorName: agent.name,
      content: input.summary,
    });
    insertTaskEvent(db, {
      taskId: task.id,
      projectId: task.project_id,
      instanceId: instance.id,
      type: input.status === 'done' ? 'task.completed' : 'task.failed',
      message: input.summary,
      payload: { decisions: input.decisions ?? [], lessons: input.lessons ?? [], error: input.error ?? null },
      createdAt: now,
    });
    recordActivity(db, rc.app.bus, {
      projectId: task.project_id,
      projectName: task.project_name ?? undefined,
      type: input.status === 'done' ? 'task.completed' : 'task.failed',
      actor: agent.name,
      summary:
        input.status === 'done'
          ? `完成任务：${task.title}`
          : `任务失败：${errorText || task.title}`,
      taskId: task.id,
      agentId: agent.id,
    });

    const updatedRow = getTaskRow(db, task.id);
    if (!updatedRow) throw errors.internal('完成后读取任务失败');

    // 记忆写回放在任务状态落库之后；失败只 warn，不回滚。
    await writeBackTaskMemory(rc, task, input);

    const updated: WorkItem = mapWorkItem(updatedRow);
    rc.json(updated);
  });

  // GET /api/runtime/conversations —— 已废弃：任务为一次性 goal，不再续聊。
  // 保留空响应以兼容旧版 DSH 插件；新版插件不再轮询此接口。
  router.get('/api/runtime/conversations', (rc) => {
    authenticateInstance(rc);
    rc.json({ items: [] });
  });

  // POST /api/runtime/tasks/:id/events —— 批量上报 DSH 运行时事件（实时日志）
  router.post('/api/runtime/tasks/:id/events', async (rc) => {
    const instance = authenticateInstance(rc);
    const agent = functionAgent(rc);
    const db = rc.app.db;
    const task = requireInstanceTask(db, rc.params.id, instance.id);
    const input = await rc.body(runtimeEventsSchema);
    const now = nowIso();
    const created: RuntimeEvent[] = [];
    for (const event of input.events) {
      const id = newId('rte');
      let payload = event.payload ?? {};
      let payloadJson = JSON.stringify(payload);
      if (payloadJson.length > 16_000) {
        payload = { truncated: true, preview: payloadJson.slice(0, 15_000) };
        payloadJson = JSON.stringify(payload);
      }
      const result = db
        .prepare(
          `INSERT INTO runtime_events (id, task_id, project_id, instance_id, type, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, task.id, task.project_id, instance.id, event.type, payloadJson, event.at ?? now);
      const runtime: RuntimeEvent = {
        id,
        taskId: task.id,
        seq: Number(result.lastInsertRowid),
        type: event.type,
        payload,
        createdAt: event.at ?? now,
      };
      created.push(runtime);
      rc.app.bus.publish({
        id: newId('act'),
        type: 'task.runtime',
        projectId: task.project_id,
        projectName: task.project_name ?? undefined,
        taskId: task.id,
        agentId: agent.id,
        actor: agent.name,
        summary: runtimeSummary(event.type, payload),
        at: runtime.createdAt,
        runtime,
      });
    }
    rc.json({ ok: true, accepted: created.length, events: created }, 202);
  });

  // GET /api/tasks/:id/runtime-events —— 控制台读取运行时日志（SSE 断线兜底）
  router.get('/api/tasks/:id/runtime-events', (rc) => {
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    requireProject(rc, task.project_id, 'view');
    const after = Number(rc.url.searchParams.get('after') ?? 0);
    const rows = rc.app.db
      .prepare(
        `SELECT seq, id, task_id, type, payload, created_at
           FROM runtime_events
          WHERE task_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT 500`,
      )
      .all(task.id, Number.isFinite(after) ? after : 0) as unknown as {
      seq: number;
      id: string;
      task_id: string;
      type: string;
      payload: string;
      created_at: string;
    }[];
    rc.json(
      rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        seq: Number(row.seq),
        type: row.type,
        payload: parseJsonObject(row.payload),
        createdAt: row.created_at,
      })),
    );
  });

  // GET /api/runtime/me —— 实例自述：身份 + 绑定项目
  router.get('/api/runtime/me', (rc) => {
    const instance = authenticateInstance(rc);
    const agent = functionAgent(rc);
    const db = rc.app.db;
    const instanceRow = getInstanceRow(db, instance.id);
    if (!instanceRow) throw errors.notFound('实例不存在');
    const projects = rowsOf<{
      id: string;
      name: string;
      slug: string;
      memory_agent_id: string;
      repo_url: string | null;
      type: string;
    }>(
      db,
      `SELECT p.id, p.name, p.slug, pa.memory_agent_id, p.repo_url, p.type
         FROM project_agents pa JOIN projects p ON p.id = pa.project_id
        WHERE pa.agent_id = ? AND pa.status = 'active' AND p.status = 'active'
        ORDER BY p.name ASC`,
      [agent.id],
    );

    rc.json({
      instance: mapInstance(instanceRow, agent.name, currentTaskOf(db, instance.id)),
      agent: { id: agent.id, name: agent.name },
      projects: projects.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        memoryAgentId: row.memory_agent_id,
        repoUrl: row.repo_url ?? undefined,
        type: row.type,
      })),
    });
  });
}
