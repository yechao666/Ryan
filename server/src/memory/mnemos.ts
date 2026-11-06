/**
 * Mnemos 记忆服务客户端（HTTP `/v1`，Bearer API Key）。
 *
 * 契约要点：
 * - 搜索 `POST /v1/memories/search`（响应为 snake_case，字段 `memory` / `took_ms`）
 * - 简报 `POST /v1/context`（响应 snake_case：`prompt` / `token_estimate` / `citations`）
 * - 写入 `POST /v1/memories`（响应 camelCase：`results[]`）
 * 由于不同端点命名风格不一致，这里统一做防御式映射；失败抛 MnemosError（带 status）。
 */
import type { Db } from '../db/index.ts';
import type { ProjectRow } from '../lib/access.ts';
import type { MemoryHit } from '../../../shared/src/types.ts';

export interface MnemosConfig {
  /** 例如 http://127.0.0.1:4380（不含尾斜杠） */
  baseUrl: string;
  /** 项目在 Mnemos 中的 projectId */
  projectId: string;
  apiKey: string;
}

export class MnemosError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'MNEMOS_ERROR') {
    super(message);
    this.name = 'MnemosError';
    this.status = status;
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 5_000;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(raw: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberOf(raw: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function objectOf(raw: JsonObject, key: string): JsonObject | undefined {
  const value = raw[key];
  return isObject(value) ? value : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

async function postJson(
  config: MnemosConfig,
  path: string,
  body: JsonObject,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonObject> {
  const url = `${normalizeBaseUrl(config.baseUrl)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const message = timedOut
      ? `记忆服务请求超时（${timeoutMs}ms）`
      : `记忆服务不可用：${error instanceof Error ? error.message : String(error)}`;
    throw new MnemosError(0, message, 'MNEMOS_UNAVAILABLE');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorBody = isObject(payload) && isObject(payload.error) ? payload.error : undefined;
    const message =
      (errorBody && stringOf(errorBody, 'message')) || `记忆服务返回 ${response.status}`;
    const code = (errorBody && stringOf(errorBody, 'code')) || 'MNEMOS_ERROR';
    throw new MnemosError(response.status, message, code);
  }

  return isObject(payload) ? payload : {};
}

export interface MnemosSearchOptions {
  query: string;
  agentId?: string;
  topK?: number;
}

export interface MnemosContextOptions {
  agentId?: string;
  query?: string;
  budgetTokens?: number;
}

export interface MnemosAddOptions {
  text: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/** 语义搜索记忆。 */
export async function search(config: MnemosConfig, options: MnemosSearchOptions): Promise<JsonObject> {
  return postJson(config, '/v1/memories/search', {
    query: options.query,
    agent_id: options.agentId,
    top_k: options.topK,
    include_signals: true,
  });
}

/** 拉取项目上下文简报（可直接注入 system prompt）。 */
export async function context(config: MnemosConfig, options: MnemosContextOptions): Promise<JsonObject> {
  return postJson(config, '/v1/context', {
    agent_id: options.agentId,
    query: options.query,
    budget_tokens: options.budgetTokens,
  });
}

/** 写入项目共享记忆（原文入库，不做事实抽取）。 */
export async function add(config: MnemosConfig, options: MnemosAddOptions): Promise<JsonObject> {
  return postJson(config, '/v1/memories', {
    text: options.text,
    agent_id: options.agentId,
    visibility: 'project',
    metadata: options.metadata ?? {},
    infer: false,
  });
}

/** 把搜索响应映射为前端 MemoryHit[]（兼容 snake_case / camelCase 两种命名）。 */
export function toMemoryHits(raw: JsonObject): MemoryHit[] {
  const results = Array.isArray(raw.results) ? raw.results : [];
  const hits: MemoryHit[] = [];
  for (const item of results) {
    if (!isObject(item)) continue;
    const id = stringOf(item, 'id');
    if (!id) continue;
    const signals = objectOf(item, 'signals');
    const hit: MemoryHit = {
      id,
      content: stringOf(item, 'content', 'memory', 'text') ?? '',
      score: numberOf(item, 'score') ?? 0,
      category: stringOf(item, 'category') ?? 'fact',
      visibility: stringOf(item, 'visibility') ?? 'project',
      createdAt: stringOf(item, 'created_at', 'createdAt') ?? new Date().toISOString(),
    };
    const agentId = stringOf(item, 'agent_id', 'agentId');
    if (agentId) hit.agentId = agentId;
    const taskId = stringOf(item, 'task_id', 'taskId');
    if (taskId) hit.taskId = taskId;
    if (signals) {
      const numeric: Record<string, number> = {};
      for (const [key, value] of Object.entries(signals)) {
        if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value;
      }
      hit.signals = numeric;
    }
    hits.push(hit);
  }
  return hits;
}

/** 响应里的耗时（毫秒）：优先服务端上报值，否则用本地计时。 */
export function tookMsOf(raw: JsonObject, startedAt: number): number {
  const reported = numberOf(raw, 'took_ms', 'tookMs');
  return Math.round(reported ?? Date.now() - startedAt);
}

/** 项目是否配置了 Mnemos（projectId + apiKey 都齐全）。 */
export function memoryConfigFor(env: { mnemosBaseUrl: string }, project: ProjectRow): MnemosConfig | null {
  if (!project.mnemos_project_id || !project.mnemos_api_key) return null;
  return {
    baseUrl: env.mnemosBaseUrl,
    projectId: project.mnemos_project_id,
    apiKey: project.mnemos_api_key,
  };
}

export interface MemoryAgentResolution {
  memoryAgentId: string | null;
  error?: string;
}

/**
 * 平台 Agent id → Mnemos memory_agent_id。
 * 未显式指定时取项目内第一个 active 绑定。
 */
export function resolveMemoryAgent(db: Db, projectId: string, agentId?: string): MemoryAgentResolution {
  if (agentId) {
    const row = db
      .prepare('SELECT memory_agent_id FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(projectId, agentId) as unknown as { memory_agent_id: string } | undefined;
    if (!row) return { memoryAgentId: null, error: '该智员未绑定到此项目' };
    return { memoryAgentId: row.memory_agent_id };
  }
  const row = db
    .prepare(
      `SELECT memory_agent_id FROM project_agents
        WHERE project_id = ? AND status = 'active'
        ORDER BY added_at ASC, memory_agent_id ASC
        LIMIT 1`,
    )
    .get(projectId) as unknown as { memory_agent_id: string } | undefined;
  if (!row) return { memoryAgentId: null, error: '项目未绑定可用智员，无法确定记忆身份' };
  return { memoryAgentId: row.memory_agent_id };
}

/** 某 Agent 在该项目的 memory_agent_id（不做 active 校验，供运行时写回使用）。 */
export function memoryAgentIdOf(db: Db, projectId: string, agentId: string): string | null {
  const row = db
    .prepare('SELECT memory_agent_id FROM project_agents WHERE project_id = ? AND agent_id = ?')
    .get(projectId, agentId) as unknown as { memory_agent_id: string } | undefined;
  return row?.memory_agent_id ?? null;
}

/** 任务完成写回的记忆正文（固定模板）。 */
export function taskMemoryText(input: {
  title: string;
  summary: string;
  decisions?: string[];
  lessons?: string[];
}): string {
  const decisions = input.decisions ?? [];
  const lessons = input.lessons ?? [];
  return `任务：${input.title}\n结论：${input.summary}\n决策：${decisions.join('；')}\n经验：${lessons.join('；')}`;
}
