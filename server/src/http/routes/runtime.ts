/**
 * Ryan 运行时 API：DSH 服务注册、心跳、领单、进展、完成与运行时事件。
 * 鉴权只用服务 token；任务的执行者固定为创建人 @Ryan。
 */
import { execFile } from 'node:child_process';
import { createReadStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { authenticateInstance, requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { getProjectRow } from '../../lib/access.ts';
import { recordActivity } from '../../lib/activity.ts';
import { tx } from '../../db/index.ts';
import type { Db } from '../../db/index.ts';
import { newId, nowIso, randomToken, sha256 } from '../../lib/ids.ts';
import type {
  ClaimedTask,
  CompleteTaskInput,
  DshInstance,
  PromptCardCategory,
  RuntimeEvent,
  WorkItem,
} from '../../../../shared/src/types.ts';
import {
  getTaskRow,
  getWorkItem,
  insertTaskEvent,
  mapWorkItem,
  parseJsonObject,
  parseStringArray,
  truncateSummary,
  type TaskRow,
} from './tasks.ts';
import { addMemory, buildMemoryContext, getMemoryBriefMaxChars, memoryAgentIdOf, searchMemories, taskMemoryText } from '../../memory/store.ts';
import { ensureMemoryBrief } from '../../memory/brief.ts';
import { memoryWriteIssue } from '../../memory/policy.ts';
import { buildInstance, getInstanceRow } from './identity-helpers.ts';

const LEASE_MS = 3 * 60_000;

function rowOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function rowsOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function noContent(rc: RequestContext): void {
  rc.res.statusCode = 204;
  rc.res.setHeader('x-request-id', rc.requestId);
  rc.res.end();
}

function leaseUntil(): string {
  return new Date(Date.now() + LEASE_MS).toISOString();
}

function requireInstanceTask(db: Db, taskId: string, instanceId: string): TaskRow {
  const task = getTaskRow(db, taskId);
  if (!task) throw errors.notFound('任务不存在');
  if (task.instance_id !== instanceId) throw errors.forbidden('任务不属于当前服务');
  return task;
}

function writeBackTaskMemory(rc: RequestContext, task: TaskRow, input: CompleteTaskInput): void {
  if (input.status !== 'done') return;
  const decisions = (input.decisions ?? []).filter(Boolean);
  const lessons = (input.lessons ?? []).filter(Boolean);
  // 普通任务结果留在任务历史；只有显式决策/经验作为候选记忆进入做梦流程。
  if (decisions.length === 0 && lessons.length === 0) return;
  const project = getProjectRow(rc.app.db, task.project_id);
  if (!project) return;
  const text = taskMemoryText({ decisions, lessons });
  try {
    addMemory(rc.app.db, {
      projectId: project.id,
      content: text,
      title: `任务沉淀：${task.title}`,
      category: lessons.length > 0 ? 'lesson' : 'decision',
      source: 'task',
      status: 'candidate',
      taskId: task.id,
      createdBy: task.created_by,
      metadata: { aiwoTaskId: task.id, projectId: project.id, kind: 'task_candidate' },
    });
  } catch (error) {
    console.warn(`[aiwo] 任务 ${task.id} 候选记忆写回失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function cardsContent(db: Db, ids: string[]): ClaimedTask['promptCards'] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(', ');
  return rowsOf<{ id: string; name: string; category: string; content: string }>(
    db,
    `SELECT id, name, category, content FROM prompt_cards WHERE enabled = 1 AND id IN (${marks})`,
    ids,
  ).map((row) => ({ id: row.id, name: row.name, category: row.category as PromptCardCategory, content: row.content }));
}

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['local', 'remote']).optional(),
  host: z.string().trim().max(200).optional().default(''),
  port: z.number().int().min(1).max(65535).optional(),
  version: z.string().trim().max(80).optional().default(''),
  pluginVersion: z.string().trim().max(80).optional(),
  workspaceRoot: z.string().trim().max(1_000).optional(),
});

const progressSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  payload: z.record(z.unknown()).optional(),
});

const runtimeEventsSchema = z.object({
  events: z.array(z.object({
    type: z.string().trim().min(1).max(60),
    payload: z.record(z.unknown()).optional(),
    at: z.string().optional(),
  })).min(1).max(100),
});

const memorySearchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  topK: z.number().int().min(1).max(20).optional().default(8),
});

const memoryAddSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  title: z.string().trim().max(200).optional(),
  category: z.enum(['fact', 'decision', 'lesson', 'note']).optional(),
});

const memoryContextSchema = z.object({
  query: z.string().trim().max(1_000).optional(),
});

const completeSchema = z.object({
  status: z.enum(['done', 'failed']),
  summary: z.string().trim().min(1).max(20_000),
  decisions: z.array(z.string().max(4_000)).max(100).optional(),
  lessons: z.array(z.string().max(4_000)).max(100).optional(),
  error: z.string().max(20_000).optional(),
  sessionId: z.string().trim().max(200).optional(),
});

function runtimeSummary(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'session': return 'DSH 会话启动';
    case 'tool_call': return `调用工具 ${String(payload.tool ?? 'tool')}`;
    case 'tool_result': return `工具结果 ${String(payload.status ?? '')}`.trim();
    case 'text': return `输出：${String(payload.text ?? '').slice(0, 80)}`;
    case 'thinking': return '模型思考';
    case 'status': return `阶段 ${String(payload.phase ?? '')}`.trim();
    case 'final': return '执行完成';
    case 'error': return `运行错误：${String(payload.message ?? '').slice(0, 80)}`;
    default: return type;
  }
}

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let agentPackagePromise: Promise<string> | null = null;

/** 生成可下载的服务代理包；服务 token 即可拉取，方便远端主机安装。 */
async function buildAgentPackage(): Promise<string> {
  if (agentPackagePromise) return agentPackagePromise;
  agentPackagePromise = (async () => {
    const runDir = join(REPO_ROOT, '.run');
    mkdirSync(runDir, { recursive: true });
    const archive = join(runDir, 'aiwo-instance-agent.tar.gz');
    await execFileAsync('tar', [
      '-czf', archive,
      '-C', join(REPO_ROOT, 'integrations'),
      '--exclude=node_modules',
      '--exclude=test',
      'aiwo-instance',
    ]);
    return archive;
  })().finally(() => {
    agentPackagePromise = null;
  });
  return agentPackagePromise;
}

export function registerRuntimeRoutes(router: Router): void {
  // DSH 插件注册：用户用自己分配的 API Key 领一个服务身份；返回一次性服务 token。
  router.post('/api/runtime/instances/register-key', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(z.object({
      instanceId: z.string().trim().max(80).optional(),
      name: z.string().trim().min(1).max(120),
      kind: z.enum(['local', 'remote']).optional().default('remote'),
      host: z.string().trim().max(200).optional().default(''),
      workspacePath: z.string().trim().max(1_000).optional().default(''),
      workspaceRoot: z.string().trim().max(1_000).optional().default(''),
      version: z.string().trim().max(80).optional().default(''),
      pluginVersion: z.string().trim().max(80).optional().default(''),
    }));
    const now = nowIso();
    let id = input.instanceId ?? '';
    if (id) {
      const existing = getInstanceRow(rc.app.db, id);
      if (!existing || existing.created_by !== person.id) throw errors.notFound('服务不存在');
    } else {
      id = newId('ins');
    }
    const token = `aiwo_ins_${randomToken(32)}`;
    if (input.instanceId) {
      rc.app.db.prepare(
        `UPDATE dsh_instances SET name = ?, kind = ?, host = ?, workspace_path = ?, workspace_root = ?,
                version = ?, plugin_version = ?, token_hash = ?, token_prefix = ?, revoked_at = NULL,
                status = 'unconfigured', updated_at = ? WHERE id = ?`,
      ).run(input.name, input.kind, input.host, input.workspacePath, input.workspaceRoot,
        input.version, input.pluginVersion, sha256(token), token.slice(0, 18), now, id);
    } else {
      rc.app.db.prepare(
        `INSERT INTO dsh_instances
           (id, name, kind, host, port, base_url, workspace_path, workspace_root, version, plugin_version,
            token_hash, token_prefix, status, registered_at, last_seen_at, revoked_at, created_by, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'unconfigured', ?, NULL, NULL, ?, ?, ?, '{}')`,
      ).run(id, input.name, input.kind, input.host, input.workspacePath, input.workspaceRoot,
        input.version, input.pluginVersion, sha256(token), token.slice(0, 18), now, person.id, now, now);
    }
    const row = getInstanceRow(rc.app.db, id);
    if (!row) throw errors.internal('服务注册失败');
    rc.json({ instance: buildInstance(rc.app.db, row), token });
  });

  // 服务注册：token 由 Ryan 管理端预先创建；插件首次上线时更新资源信息。
  router.post('/api/runtime/instances/register', async (rc) => {
    const instance = authenticateInstance(rc);
    const input = await rc.body(registerSchema);
    const now = nowIso();
    const current = getInstanceRow(rc.app.db, instance.id);
    if (!current) throw errors.notFound('服务不存在');
    rc.app.db
      .prepare(
        `UPDATE dsh_instances
            SET name = ?, kind = ?, host = ?, port = ?, version = ?,
                plugin_version = ?, workspace_root = COALESCE(NULLIF(?, ''), workspace_root), status = 'online', registered_at = ?, last_seen_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.name ?? current.name,
        input.kind ?? current.kind,
        input.host || current.host,
        input.port ?? current.port,
        input.version || current.version,
        input.pluginVersion ?? current.plugin_version,
        input.workspaceRoot ?? '',
        current.registered_at,
        now,
        now,
        instance.id,
      );
    const row = getInstanceRow(rc.app.db, instance.id);
    if (!row) throw errors.internal('服务注册后读取失败');
    rc.json({ instance: buildInstance(rc.app.db, row) });
  });

  router.get('/api/runtime/instances/agent-package', async (rc) => {
    authenticateInstance(rc);
    const archive = await buildAgentPackage();
    rc.res.statusCode = 200;
    rc.res.setHeader('content-type', 'application/gzip');
    rc.res.setHeader('content-disposition', 'attachment; filename="aiwo-instance-agent.tar.gz"');
    rc.res.setHeader('x-request-id', rc.requestId);
    createReadStream(archive).pipe(rc.res);
  });

  router.post('/api/runtime/instances/heartbeat', (rc) => {
    const instance = authenticateInstance(rc);
    const pending = rowOf<{ c: number }>(
      rc.app.db,
      `SELECT COUNT(*) AS c FROM work_items w
        JOIN projects p ON p.id = w.project_id
       WHERE p.status = 'active' AND w.status = 'queued'
         AND (
           w.instance_id = ?
           OR (
             w.instance_id IS NULL
             AND (w.allowed_service_ids = '[]'
                  OR EXISTS (SELECT 1 FROM json_each(w.allowed_service_ids) WHERE value = ?))
             AND (
               NOT EXISTS (SELECT 1 FROM instance_projects ip WHERE ip.project_id = w.project_id)
               OR EXISTS (SELECT 1 FROM instance_projects ip WHERE ip.project_id = w.project_id AND ip.instance_id = ?)
             )
           )
         )`,
      [instance.id, instance.id, instance.id],
    );
    const row = getInstanceRow(rc.app.db, instance.id);
    rc.json({ ok: true, instance: row ? buildInstance(rc.app.db, row) : null, pending: Number(pending?.c ?? 0) });
  });

  router.post('/api/runtime/tasks/claim', async (rc) => {
    const instance = authenticateInstance(rc);
    const db = rc.app.db;
    const now = nowIso();
    const claimed = tx(db, () => {
      db.prepare(
        `UPDATE work_items SET status = 'queued', instance_id = NULL, lease_until = NULL
          WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
      ).run(now);
      const busy = rowOf<{ id: string }>(
        db,
        "SELECT id FROM work_items WHERE instance_id = ? AND status IN ('running','waiting_input') LIMIT 1",
        [instance.id],
      );
      if (busy) return null;
      const candidate = rowOf<{ id: string }>(
        db,
        `SELECT w.id FROM work_items w
           JOIN projects p ON p.id = w.project_id
          WHERE p.status = 'active' AND w.status = 'queued'
            AND (
              w.instance_id = ?
              OR (
                w.instance_id IS NULL
                AND (w.allowed_service_ids = '[]'
                     OR EXISTS (SELECT 1 FROM json_each(w.allowed_service_ids) WHERE value = ?))
                AND (
                  NOT EXISTS (SELECT 1 FROM instance_projects ip WHERE ip.project_id = w.project_id)
                  OR EXISTS (SELECT 1 FROM instance_projects ip WHERE ip.project_id = w.project_id AND ip.instance_id = ?)
                )
              )
            )
          ORDER BY w.priority DESC, w.created_at ASC LIMIT 1`,
        [instance.id, instance.id, instance.id],
      );
      if (!candidate) return null;
      db.prepare(
        "UPDATE work_items SET status = 'running', instance_id = ?, started_at = ?, lease_until = ? WHERE id = ? AND status = 'queued'",
      ).run(instance.id, now, leaseUntil(), candidate.id);
      return candidate.id;
    });
    if (!claimed) { noContent(rc); return; }

    const task = getTaskRow(db, claimed);
    if (!task) throw errors.internal('领取后任务读取失败');
    const project = getProjectRow(db, task.project_id);
    if (!project) throw errors.internal('任务项目读取失败');
    const person = task.created_by ? rowOf<{ id: string; name: string }>(db, 'SELECT id, name FROM persons WHERE id = ?', [task.created_by]) : undefined;
    const memoryAgentId = memoryAgentIdOf(db, project.id) ?? '';
    const item = getWorkItem(db, task.id)!;
    const memoryBrief = await ensureMemoryBrief(db, project.id);

    insertTaskEvent(db, {
      taskId: task.id,
      projectId: task.project_id,
      instanceId: instance.id,
      type: 'task.claimed',
      message: `服务 ${instance.name} 接单`,
      payload: { instanceId: instance.id },
    });
    recordActivity(db, rc.app.bus, {
      projectId: task.project_id,
      projectName: project.name,
      type: 'task.claimed',
      actor: item.executorLabel,
      summary: `服务接单：${task.title}`,
      taskId: task.id,
    });

    const claimedTask: ClaimedTask = {
      task: item,
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        prompt: project.prompt,
        repoUrl: project.repo_url ?? undefined,
        type: project.type as ClaimedTask['project']['type'],
        memoryAgentId,
      },
      executor: {
        personId: person?.id,
        name: person?.name ?? '',
        label: item.executorLabel,
      },
      promptCards: cardsContent(db, item.promptCardIds),
      memory: {
        agentId: memoryAgentId,
        enabled: true,
        tools: true,
        brief: memoryBrief.text,
        maxChars: memoryBrief.maxChars,
      },
    };
    rc.json(claimedTask);
  });

  router.get('/api/runtime/tasks/:id/status', (rc) => {
    const instance = authenticateInstance(rc);
    const task = requireInstanceTask(rc.app.db, rc.params.id, instance.id);
    rc.json({ id: task.id, status: task.status, updatedAt: task.finished_at ?? task.started_at ?? task.created_at });
  });

  router.get('/api/runtime/tasks/current', (rc) => {
    const instance = authenticateInstance(rc);
    const task = rowOf<{ id: string; project_id: string; title: string }>(
      rc.app.db,
      "SELECT id, project_id, title FROM work_items WHERE instance_id = ? AND status IN ('running','waiting_input') ORDER BY started_at DESC LIMIT 1",
      [instance.id],
    );
    if (!task) { noContent(rc); return; }
    rc.json({ taskId: task.id, projectId: task.project_id, title: task.title });
  });

  router.post('/api/runtime/tasks/:id/memory/search', async (rc) => {
    const instance = authenticateInstance(rc);
    const task = requireInstanceTask(rc.app.db, rc.params.id, instance.id);
    const input = await rc.body(memorySearchSchema);
    rc.json(searchMemories(rc.app.db, task.project_id, input.query, input.topK));
  });

  router.get('/api/runtime/tasks/:id/memory/context', (rc) => {
    const instance = authenticateInstance(rc);
    const task = requireInstanceTask(rc.app.db, rc.params.id, instance.id);
    const params = rc.query(memoryContextSchema);
    rc.json(buildMemoryContext(rc.app.db, task.project_id, params.query ?? '', 1200));
  });

  router.post('/api/runtime/tasks/:id/memory/add', async (rc) => {
    const instance = authenticateInstance(rc);
    const task = requireInstanceTask(rc.app.db, rc.params.id, instance.id);
    const input = await rc.body(memoryAddSchema);
    const issue = memoryWriteIssue(input.content, input.category);
    if (issue) throw errors.badRequest(issue);
    const memory = addMemory(rc.app.db, {
      projectId: task.project_id,
      content: input.content,
      title: input.title,
      category: input.category ?? 'note',
      source: 'agent',
      status: 'candidate',
      taskId: task.id,
      createdBy: task.created_by,
      metadata: { sourceTaskId: task.id, instanceId: instance.id },
    });
    rc.json(memory, 201);
  });

  router.post('/api/runtime/tasks/:id/progress', async (rc) => {
    const instance = authenticateInstance(rc);
    const db = rc.app.db;
    const task = requireInstanceTask(db, rc.params.id, instance.id);
    const input = await rc.body(progressSchema);
    db.prepare('UPDATE work_items SET lease_until = ? WHERE id = ?').run(leaseUntil(), task.id);
    insertTaskEvent(db, {
      taskId: task.id,
      projectId: task.project_id,
      instanceId: instance.id,
      type: 'task.progress',
      message: input.message,
      payload: input.payload ?? {},
    });
    rc.json({ ok: true });
  });

  router.post('/api/runtime/tasks/:id/messages', (rc) => {
    authenticateInstance(rc);
    throw errors.conflict('Ryan 任务不支持对话，只展示执行过程');
  });

  router.post('/api/runtime/tasks/:id/complete', async (rc) => {
    const instance = authenticateInstance(rc);
    const db = rc.app.db;
    const task = requireInstanceTask(db, rc.params.id, instance.id);
    const input = await rc.body(completeSchema);
    if (['done', 'failed', 'cancelled'].includes(task.status)) throw errors.conflict('任务已结束');
    const now = nowIso();
    db.prepare(
      `UPDATE work_items SET status = ?, finished_at = ?, result = ?, error = ?, lease_until = NULL
        WHERE id = ?`,
    ).run(input.status, now, input.summary, input.error ?? null, task.id);
    insertTaskEvent(db, {
      taskId: task.id,
      projectId: task.project_id,
      instanceId: instance.id,
      type: input.status === 'done' ? 'task.completed' : 'task.failed',
      message: input.status === 'done' ? '任务完成' : (input.error ?? '任务失败'),
      payload: { decisions: input.decisions ?? [], lessons: input.lessons ?? [] },
    });
    recordActivity(db, rc.app.bus, {
      projectId: task.project_id,
      projectName: task.project_name ?? undefined,
      type: input.status === 'done' ? 'task.completed' : 'task.failed',
      actor: (task.executor_name ?? '') + '@Ryan',
      summary: truncateSummary(input.summary),
      taskId: task.id,
    });
    writeBackTaskMemory(rc, task, input);
    const updated = getWorkItem(db, task.id);
    rc.json(updated);
  });

  router.post('/api/runtime/tasks/:id/events', async (rc) => {
    const instance = authenticateInstance(rc);
    const task = requireInstanceTask(rc.app.db, rc.params.id, instance.id);
    const input = await rc.body(runtimeEventsSchema);
    const events: RuntimeEvent[] = [];
    for (const event of input.events) {
      const id = newId('rte');
      const createdAt = event.at && !Number.isNaN(Date.parse(event.at)) ? new Date(event.at).toISOString() : nowIso();
      rc.app.db
        .prepare(
          `INSERT INTO runtime_events (id, task_id, project_id, instance_id, type, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, task.id, task.project_id, instance.id, event.type, JSON.stringify(event.payload ?? {}), createdAt);
      events.push({ id, taskId: task.id, seq: 0, type: event.type, payload: event.payload ?? {}, createdAt });
    }
    rc.json({ ok: true, events });
  });

  router.get('/api/tasks/:id/runtime-events', (rc) => {
    requirePerson(rc);
    const task = getTaskRow(rc.app.db, rc.params.id);
    if (!task) throw errors.notFound('任务不存在');
    requireProject(rc, task.project_id, 'view');
    const after = Number(rc.url.searchParams.get('after') ?? '0');
    const rows = rowsOf<{ seq: number; id: string; task_id: string; type: string; payload: string; created_at: string }>(
      rc.app.db,
      'SELECT seq, id, task_id, type, payload, created_at FROM runtime_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500',
      [task.id, Number.isFinite(after) ? after : 0],
    );
    rc.json(rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      seq: row.seq,
      type: row.type,
      payload: parseJsonObject(row.payload),
      createdAt: row.created_at,
    } satisfies RuntimeEvent)));
  });

  router.get('/api/runtime/me', (rc) => {
    const instance = authenticateInstance(rc);
    const row = getInstanceRow(rc.app.db, instance.id);
    rc.json({ instance: row ? buildInstance(rc.app.db, row) : null });
  });
}
