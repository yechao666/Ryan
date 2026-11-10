/**
 * Ryan 内置项目记忆 API：检索、上下文简报、手动新增与删除。
 * 记忆按项目隔离；不再依赖外部 Mnemos 服务或 API Key。
 */
import { z } from 'zod';
import type { Router } from '../router.ts';
import { requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import {
  addMemory,
  buildMemoryContext,
  deleteMemory,
  getMemoryBriefMaxChars,
  setMemoryBriefMaxChars,
  listMemories,
  memoryAgentIdOf,
  searchMemories,
} from '../../memory/store.ts';
import { ensureMemoryBrief } from '../../memory/brief.ts';
import { getDreamSettings, getDreamStatus, runDream, updateDreamSettings } from '../../memory/dream.ts';
import { buildMemoryReport } from '../../memory/report.ts';
import { checkUserInput } from '../../security/check.ts';
import type {
  MemoryContextResult,
  MemorySearchResult,
} from '../../../../shared/src/types.ts';

const CONTEXT_BUDGET_TOKENS = 1200;

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(1_000),
  topK: z.coerce.number().int().min(1).max(50).default(8),
});

const contextQuerySchema = z.object({
  q: z.string().max(1_000).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const briefSettingsSchema = z.object({
  maxChars: z.number().int().min(100).max(5000),
});

const reportQuerySchema = z.object({
  period: z.enum(['week', 'month']).default('week'),
  anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const dreamSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
});

const addSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  title: z.string().trim().max(200).optional(),
  category: z.enum(['fact', 'decision', 'progress', 'lesson', 'risk', 'change', 'acceptance', 'assumption', 'dependency', 'note', 'task_result', 'insight']).optional(),
});

export function registerMemoryRoutes(router: Router): void {
  router.get('/api/projects/:id/memory/search', (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    const params = rc.query(searchQuerySchema);
    const result: MemorySearchResult = searchMemories(rc.app.db, project.id, params.q, params.topK);
    rc.json(result);
  });

  router.get('/api/projects/:id/memory/context', (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    const params = rc.query(contextQuerySchema);
    const result: MemoryContextResult = buildMemoryContext(rc.app.db, project.id, params.q ?? '', CONTEXT_BUDGET_TOKENS);
    rc.json(result);
  });

  router.get('/api/projects/:id/memory/brief', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    rc.json(await ensureMemoryBrief(rc.app.db, project.id));
  });

  router.patch('/api/projects/:id/memory/brief', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const input = await rc.body(briefSettingsSchema);
    const maxChars = setMemoryBriefMaxChars(rc.app.db, project.id, input.maxChars);
    rc.json({ maxChars, brief: await ensureMemoryBrief(rc.app.db, project.id, true) });
  });

  router.get('/api/projects/:id/memory/reports', (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    const params = rc.query(reportQuerySchema);
    rc.json(buildMemoryReport(rc.app.db, project.id, params.period, params.anchor));
  });

  router.get('/api/projects/:id/memory/dream', (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    rc.json(getDreamStatus(rc.app.db, project.id));
  });

  router.patch('/api/projects/:id/memory/dream', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const input = await rc.body(dreamSettingsSchema);
    rc.json(updateDreamSettings(rc.app.db, project.id, input));
  });

  router.post('/api/projects/:id/memory/dream/run', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const run = await runDream(rc.app.db, project.id, 'manual');
    if (!run) throw errors.conflict('该项目正在进行复盘总结，请稍后再试');
    rc.json({ run, status: getDreamStatus(rc.app.db, project.id) });
  });

  router.get('/api/projects/:id/memories', (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    const params = rc.query(listQuerySchema);
    const agentId = memoryAgentIdOf(rc.app.db, project.id) ?? '';
    rc.json({ memories: listMemories(rc.app.db, project.id, params.limit), agentId });
  });

  router.post('/api/projects/:id/memories', async (rc) => {
    const person = requirePerson(rc);
    const project = requireProject(rc, rc.params.id, 'contribute');
    const input = await rc.body(addSchema);
    const security = await checkUserInput({
      db: rc.app.db,
      personId: person.id,
      source: 'memory',
      content: input.content,
    });
    if (!security.allowed) {
      throw errors.badRequest(security.blockedMessage ?? '输入未通过安全检查', { reason: security.reason });
    }
    const memory = addMemory(rc.app.db, {
      projectId: project.id,
      content: input.content,
      title: input.title,
      category: input.category ?? 'note',
      source: 'manual',
      createdBy: person.id,
    });
    rc.json(memory, 201);
  });

  router.delete('/api/projects/:id/memories', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const input = await rc.body(z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }));
    let deleted = 0;
    for (const id of [...new Set(input.ids)]) {
      if (deleteMemory(rc.app.db, project.id, id)) deleted += 1;
    }
    rc.json({ deleted });
  });

  router.delete('/api/projects/:id/memories/:memoryId', (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    if (!deleteMemory(rc.app.db, project.id, rc.params.memoryId)) {
      throw errors.notFound('记忆不存在');
    }
    rc.json({ ok: true });
  });
}
