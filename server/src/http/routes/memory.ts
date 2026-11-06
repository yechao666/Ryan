/**
 * 项目记忆 API（会话鉴权）：语义搜索 + 上下文简报。
 * 未配置 Mnemos 时返回 configured:false 而不是 500；记忆服务异常通过 error 字段透出。
 */
import { z } from 'zod';
import type { Router } from '../router.ts';
import { requireProject } from '../auth.ts';
import {
  context as mnemosContext,
  memoryConfigFor,
  resolveMemoryAgent,
  search as mnemosSearch,
  tookMsOf,
  toMemoryHits,
} from '../../memory/mnemos.ts';
import type {
  MemoryContextResult,
  MemorySearchResult,
} from '../../../../shared/src/types.ts';

const CONTEXT_BUDGET_TOKENS = 1200;

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(1_000),
  agentId: z.string().min(1).optional(),
  topK: z.coerce.number().int().min(1).max(50).default(8),
});

const contextQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  q: z.string().max(1_000).optional(),
});

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerMemoryRoutes(router: Router): void {
  // GET /api/projects/:id/memory/search?q=&agentId=&topK=
  router.get('/api/projects/:id/memory/search', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    const params = rc.query(searchQuerySchema);
    const config = memoryConfigFor(rc.app.env, project);
    if (!config) {
      const result: MemorySearchResult = { hits: [], tookMs: 0, configured: false };
      rc.json(result);
      return;
    }

    const resolution = resolveMemoryAgent(rc.app.db, project.id, params.agentId);
    if (!resolution.memoryAgentId) {
      const result: MemorySearchResult = {
        hits: [],
        tookMs: 0,
        configured: true,
        error: resolution.error ?? '无法确定记忆身份',
      };
      rc.json(result);
      return;
    }

    const startedAt = Date.now();
    try {
      const raw = await mnemosSearch(config, {
        query: params.q,
        agentId: resolution.memoryAgentId,
        topK: params.topK,
      });
      const result: MemorySearchResult = {
        hits: toMemoryHits(raw),
        tookMs: tookMsOf(raw, startedAt),
        configured: true,
      };
      rc.json(result);
    } catch (error) {
      const result: MemorySearchResult = {
        hits: [],
        tookMs: Math.round(Date.now() - startedAt),
        configured: true,
        error: errorMessage(error),
      };
      rc.json(result);
    }
  });

  // GET /api/projects/:id/memory/context?agentId=&q=
  router.get('/api/projects/:id/memory/context', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    const params = rc.query(contextQuerySchema);
    const config = memoryConfigFor(rc.app.env, project);
    if (!config) {
      const result: MemoryContextResult = {
        prompt: '',
        tokenEstimate: 0,
        citations: [],
        configured: false,
      };
      rc.json(result);
      return;
    }

    const resolution = resolveMemoryAgent(rc.app.db, project.id, params.agentId);
    if (!resolution.memoryAgentId) {
      const result: MemoryContextResult = {
        prompt: '',
        tokenEstimate: 0,
        citations: [],
        configured: true,
        error: resolution.error ?? '无法确定记忆身份',
      };
      rc.json(result);
      return;
    }

    try {
      const raw = await mnemosContext(config, {
        agentId: resolution.memoryAgentId,
        query: params.q ?? '',
        budgetTokens: CONTEXT_BUDGET_TOKENS,
      });
      const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
      const tokenEstimate =
        typeof raw.token_estimate === 'number'
          ? raw.token_estimate
          : typeof raw.tokenEstimate === 'number'
            ? raw.tokenEstimate
            : 0;
      const citations = Array.isArray(raw.citations)
        ? raw.citations.filter((item): item is string => typeof item === 'string')
        : [];
      const result: MemoryContextResult = {
        prompt,
        tokenEstimate,
        citations,
        configured: true,
      };
      rc.json(result);
    } catch (error) {
      // Agent 未在 Mnemos 注册时服务端返回 404：按 configured:true + error 返回，不 500。
      const result: MemoryContextResult = {
        prompt: '',
        tokenEstimate: 0,
        citations: [],
        configured: true,
        error: errorMessage(error),
      };
      rc.json(result);
    }
  });
}
