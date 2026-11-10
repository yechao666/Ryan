/**
 * Ryan 运行时 API：智能体注册、心跳、领单、进展、完成与运行时事件。
 * 鉴权只用智能体 token；任务的执行者固定为创建人 @Ryan。
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
  autoInjectCardIds,
  createTaskRecord,
  getTaskRow,
  getWorkItem,
  insertTaskEvent,
  mapWorkItem,
  parseJsonObject,
  parseStringArray,
  truncateSummary,
  type TaskRow,
} from './tasks.ts';
import { addMemory, buildMemoryContext, getMemoryBriefMaxChars, memoryAgentIdOf, searchMemories } from '../../memory/store.ts';
import { ensureMemoryBrief } from '../../memory/brief.ts';
import { memoryWriteIssue } from '../../memory/policy.ts';
import { buildInstance, getInstanceRow } from './identity-helpers.ts';
import { projectContextText } from '../../projects/context.ts';
import { createTaskNotification } from '../../lib/notifications.ts';

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
  if (task.instance_id !== instanceId) throw errors.forbidden('任务不属于当前智能体');
  return task;
}

function writeBackTaskMemory(rc: RequestContext, task: TaskRow, input: CompleteTaskInput): void {
  if (input.status !== 'done') return;
  const project = getProjectRow(rc.app.db, task.project_id);
  if (!project) return;
  const buckets: Array<{ category: string; label: string; items: string[] }> = [
    { category: 'risk', label: '风险与阻塞', items: input.risks ?? [] },
    { category: 'change', label: '变更', items: input.changes ?? [] },
    { category: 'acceptance', label: '验收与质量', items: input.acceptance ?? [] },
    { category: 'assumption', label: '假设与待确认', items: input.assumptions ?? [] },
    { category: 'dependency', label: '依赖与承诺', items: input.dependencies ?? [] },
    { category: 'decision', label: '重要决策', items: input.decisions ?? [] },
    { category: 'progress', label: '关键进展', items: input.progress ?? [] },
    { category: 'lesson', label: '经验教训', items: input.lessons ?? [] },
  ];
  // 普通任务结果留在任务历史；只有显式过程记录作为候选进入复盘流程。
  for (const bucket of buckets) {
    for (const raw of bucket.items) {
      const content = String(raw ?? '').trim();
      if (!content) continue;
      try {
        addMemory(rc.app.db, {
          projectId: project.id,
          content,
          title: `任务沉淀：${task.title} · ${bucket.label}`,
          category: bucket.category,
          source: 'task',
          status: 'candidate',
          taskId: task.id,
          createdBy: task.created_by,
          metadata: { aiwoTaskId: task.id, projectId: project.id, kind: 'task_candidate', recordType: bucket.category },
        });
      } catch (error) {
        console.warn(`[aiwo] 任务 ${task.id} 候选记忆写回失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
  progress: z.array(z.string().max(4_000)).max(100).optional(),
  risks: z.array(z.string().max(4_000)).max(100).optional(),
  changes: z.array(z.string().max(4_000)).max(100).optional(),
  acceptance: z.array(z.string().max(4_000)).max(100).optional(),
  assumptions: z.array(z.string().max(4_000)).max(100).optional(),
  dependencies: z.array(z.string().max(4_000)).max(100).optional(),
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

/** 生成可下载的智能体代理包；智能体 token 即可拉取，方便远端主机安装。 */
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
  // DSH 插件注册：用户用自己分配的 API Key 领一个智能体身份；返回一次性智能体 token。
  router.post('/api/runtime/instances/register-key', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(z.object({
      instanceId: z.string().trim().max(80).optional(),
      name: z.string().trim().min(1).max(120),
      agentType: z.enum(['dsh', 'claude']).optional().default('dsh'),
      kind: z.enum(['local', 'remote']).optional().default('remote'),
      host: z.string().trim().max(200).optional().default(''),
      workspacePath: z.string().trim().max(1_000).optional().default(''),
      workspaceRoot: z.string().trim().max(1_000).optional().default(''),
      version: z.string().trim().max(80).optional().default(''),
      pluginVersion: z.string().trim().max(80).optional().default(''),
      capabilities: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    }));
    const now = nowIso();
    let id = input.instanceId ?? '';
    if (id) {
      const existing = getInstanceRow(rc.app.db, id);
      if (!existing || existing.created_by !== person.id) throw errors.notFound('智能体不存在');
    } else {
      id = newId('ins');
    }
    const token = `aiwo_ins_${randomToken(32)}`;
    if (input.instanceId) {
      rc.app.db.prepare(
        `UPDATE dsh_instances SET name = ?, kind = ?, host = ?, workspace_path = ?, workspace_root = ?,
                version = ?, plugin_version = ?, capabilities = ?, token_hash = ?, token_prefix = ?, revoked_at = NULL,
                status = 'unconfigured', updated_at = ? WHERE id = ?`,
      ).run(input.name, input.kind, input.host, input.workspacePath, input.workspaceRoot,
        input.version, input.pluginVersion, JSON.stringify(input.capabilities ?? []), sha256(token), token.slice(0, 18), now, id);
    } else {
      rc.app.db.prepare(
        `INSERT INTO dsh_instances
           (id, name, agent_type, kind, host, port, base_url, workspace_path, workspace_root, version, plugin_version, capabilities,
            token_hash, token_prefix, status, registered_at, last_seen_at, revoked_at, created_by, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'unconfigured', ?, NULL, NULL, ?, ?, ?, '{}')`,
      ).run(id, input.name, input.agentType, input.kind, input.host, input.workspacePath, input.workspaceRoot,
        input.version, input.pluginVersion, JSON.stringify(input.capabilities ?? []), sha256(token), token.slice(0, 18), now, person.id, now, now);
    }
    const row = getInstanceRow(rc.app.db, id);
    if (!row) throw errors.internal('智能体注册失败');
    rc.json({ instance: buildInstance(rc.app.db, row), token });
  });

  // 智能体注册：token 由 Ryan 管理端预先创建；插件首次上线时更新资源信息。
  router.post('/api/runtime/instances/register', async (rc) => {
    const instance = authenticateInstance(rc);
    const input = await rc.body(registerSchema);
    const now = nowIso();
    const current = getInstanceRow(rc.app.db, instance.id);
    if (!current) throw errors.notFound('智能体不存在');
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
    if (!row) throw errors.internal('智能体注册后读取失败');
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
      message: `智能体 ${instance.name} 接单`,
      payload: { instanceId: instance.id },
    });
    recordActivity(db, rc.app.bus, {
      projectId: task.project_id,
      projectName: project.name,
      type: 'task.claimed',
      actor: item.executorLabel,
      summary: `智能体接单：${task.title}`,
      taskId: task.id,
    });

    const claimedTask: ClaimedTask = {
      task: item,
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        prompt: [project.prompt, projectContextText(db, project.id)].filter(Boolean).join('\n\n'),
        repoUrl: project.repo_url ?? undefined,
        type: project.type as ClaimedTask['project']['type'],
        memoryAgentId,
      },
      executor: {
        personId: person?.id,
        name: person?.name ?? '',
        label: item.executorLabel,
      },
      promptCards: cardsContent(db, [...new Set([...item.promptCardIds, ...autoInjectCardIds(db, item.projectId, item.createdBy)])]),
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
      payload: { decisions: input.decisions ?? [], progress: input.progress ?? [], lessons: input.lessons ?? [], risks: input.risks ?? [], changes: input.changes ?? [], acceptance: input.acceptance ?? [], assumptions: input.assumptions ?? [], dependencies: input.dependencies ?? [] },
    });
    recordActivity(db, rc.app.bus, {
      projectId: task.project_id,
      projectName: task.project_name ?? undefined,
      type: input.status === 'done' ? 'task.completed' : 'task.failed',
      actor: (task.executor_name ?? '') + '@Ryan',
      summary: truncateSummary(input.summary),
      taskId: task.id,
    });
    if (input.status === 'done') {
      const meta = parseJsonObject(task.metadata);
      const mentions = Array.isArray(meta.mentions)
        ? meta.mentions.filter((item): item is { kind: string; id: string; name: string; when: string } =>
            Boolean(item) && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).kind === 'string')
        : [];
      for (const mention of mentions) {
        if (mention.kind === 'person' && mention.when === 'completion') {
          createTaskNotification(db, {
            personId: mention.id,
            taskId: task.id,
            projectId: task.project_id,
            type: 'task.mention.completed',
            title: `任务已完成：${task.title}`,
            body: `任务「${task.title}」已完成，原任务中提到了你。\n${truncateSummary(input.summary)}`,
          });
        }
        if (mention.kind === 'agent' && mention.when === 'completion') {
          const owner = db.prepare('SELECT owner_person_id FROM projects WHERE id = ?').get(task.project_id) as unknown as { owner_person_id: string } | undefined;
          const createdBy = task.created_by ?? owner?.owner_person_id;
          if (!createdBy) continue;
          try {
            const followup = createTaskRecord(db, rc.app.bus, {
              projectId: task.project_id,
              source: 'api',
              type: task.type as never,
              title: `@${mention.name} 接力：${task.title}`,
              prompt: [
                `[自然语言接力，交给 ${mention.name}]`,
                `上一任务 #${task.id}「${task.title}」已完成。`,
                '',
                '上一任务要求：',
                task.prompt.replace(/^\/goal\s*/i, ''),
                '',
                '上一任务执行结果：',
                input.summary,
                '',
                '请根据以上上下文完成后续工作。',
              ].join('\n'),
              instanceId: mention.id,
              createdBy,
              priority: task.priority,
              metadata: { naturalHandoffFromTaskId: task.id, naturalHandoffAgentId: mention.id, skipMentions: true },
              skipMentions: true,
              activitySummary: `任务接力给 ${mention.name}：${task.title}`,
              eventMessage: `创建接力任务：${task.title}`,
            });
            insertTaskEvent(db, {
              taskId: task.id,
              projectId: task.project_id,
              type: 'task.handoff',
              message: `已按自然语言接力给 ${mention.name}`,
              payload: { handoffTaskId: followup.id, handoffAgentId: mention.id },
            });
            recordActivity(db, rc.app.bus, {
              projectId: task.project_id,
              projectName: task.project_name ?? undefined,
              type: 'task.created',
              actor: (task.executor_name ?? '') + '@Ryan',
              summary: `任务接力给 ${mention.name}：${task.title}`,
              taskId: followup.id,
            });
          } catch (error) {
            insertTaskEvent(db, {
              taskId: task.id,
              projectId: task.project_id,
              type: 'task.handoff_failed',
              message: `接力给 ${mention.name} 失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
    }
    if (input.status === 'done' && task.handoff_person_id) {
      try {
        const handoffTask = createTaskRecord(db, rc.app.bus, {
          projectId: task.project_id,
          source: 'api',
          type: task.type as never,
          title: `接力：${task.title}`,
          prompt: [
            '[接力任务]',
            `上一任务 #${task.id}「${task.title}」已完成。`,
            task.handoff_note ? `交接说明：${task.handoff_note}` : '',
            '',
            '上一任务执行结果：',
            input.summary,
          ].filter(Boolean).join('\n'),
          promptCardIds: parseStringArray(task.handoff_prompt_card_ids),
          createdBy: task.handoff_person_id,
          priority: task.priority,
          metadata: {
            handoffFromTaskId: task.id,
            handoffFromTitle: task.title,
            handoffNotifyPersonIds: parseStringArray(task.notify_person_ids),
          },
          activitySummary: `任务接力：${task.title}`,
          eventMessage: `创建接力任务：${task.title}`,
        });
        insertTaskEvent(db, {
          taskId: task.id,
          projectId: task.project_id,
          type: 'task.handoff',
          message: `已转交给 ${task.handoff_person_name ?? task.handoff_person_id}`,
          payload: {
            handoffTaskId: handoffTask.id,
            handoffPersonId: task.handoff_person_id,
            notifyPersonIds: parseStringArray(task.notify_person_ids),
          },
        });
        recordActivity(db, rc.app.bus, {
          projectId: task.project_id,
          projectName: task.project_name ?? undefined,
          type: 'task.created',
          actor: (task.executor_name ?? '') + '@Ryan',
          summary: `任务接力：${task.title} → ${task.handoff_person_name ?? task.handoff_person_id}`,
          taskId: handoffTask.id,
        });
      } catch (error) {
        insertTaskEvent(db, {
          taskId: task.id,
          projectId: task.project_id,
          type: 'task.handoff_failed',
          message: `接力任务创建失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (input.status === 'done') {
      const notifyIds = parseStringArray(task.notify_person_ids);
      for (const notifyPersonId of notifyIds) {
        db.prepare(
          `INSERT INTO task_notifications (id, person_id, task_id, project_id, type, title, body, read_at, created_at)
           VALUES (?, ?, ?, ?, 'task.completed', ?, ?, NULL, ?)`,
        ).run(
          newId('ntf'),
          notifyPersonId,
          task.id,
          task.project_id,
          task.handoff_person_id ? `任务完成，已接力：${task.title}` : `任务完成：${task.title}`,
          task.handoff_person_id
            ? `任务「${task.title}」已完成，接力给 ${task.handoff_person_name ?? task.handoff_person_id}。`
            : `任务「${task.title}」已完成。\n${truncateSummary(input.summary)}`,
          nowIso(),
        );
      }
    }
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
