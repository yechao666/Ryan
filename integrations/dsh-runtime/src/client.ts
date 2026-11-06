/** Hive `/api/runtime/*` 客户端：只用全局 fetch，超时 10s，错误映射成可读信息。 */
import type { HiveRuntimeConfig } from './config.js';

export interface HiveInstance {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  host: string;
  workspacePath: string;
  version: string;
  status: string;
  lastSeenAt?: string;
}

export interface HiveTaskMessage {
  id: string;
  authorType: 'person' | 'agent' | 'system';
  authorName: string;
  content: string;
  createdAt: string;
}

export interface HiveClaimedTask {
  task: {
    id: string;
    projectId: string;
    projectName: string;
    agentId: string;
    agentName: string;
    source: string;
    title: string;
    prompt: string;
    status: string;
    priority: number;
    metadata: Record<string, unknown>;
    createdAt: string;
  };
  project: { id: string; name: string; slug: string; prompt?: string; repoUrl?: string; type: string };
  agent: { id: string; name: string; memoryAgentId: string; capabilities: string[] };
  memory: { baseUrl: string; projectId: string; apiKey: string; agentId: string; enabled: boolean };
  messages: HiveTaskMessage[];
}

export interface RegisterResult {
  instance: HiveInstance;
  token: string;
}

export interface CompleteInput {
  status: 'done' | 'failed';
  summary: string;
  decisions?: string[];
  lessons?: string[];
  error?: string;
  /** headless 会话 id，用于任务完成后的继续对话。 */
  sessionId?: string;
}

export interface RuntimeEventInput {
  type: string;
  payload?: Record<string, unknown>;
  at?: string;
}


export class HiveApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HiveApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

export class HiveClient {
  constructor(private readonly resolve: () => HiveRuntimeConfig) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const config = this.resolve();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HiveApiError(0, 'NETWORK_ERROR', `无法连接 Hive（${config.baseUrl}）：${message}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const body = payload as { error?: { code?: string; message?: string }; message?: string } | null;
      throw new HiveApiError(
        response.status,
        body?.error?.code ?? 'HTTP_ERROR',
        body?.error?.message ?? body?.message ?? `Hive 请求失败（${response.status}）`,
      );
    }
    return payload as T;
  }

  register(agentToken: string, input: { name: string; host: string; workspacePath: string; version: string }): Promise<RegisterResult> {
    return this.request('/api/runtime/instances/register', { method: 'POST', token: agentToken, body: input });
  }

  heartbeat(instanceToken: string): Promise<{ ok: boolean; instance: { id: string; name: string; lastSeenAt: string }; pending?: { queued: number } }> {
    return this.request('/api/runtime/instances/heartbeat', { method: 'POST', token: instanceToken });
  }

  claim(instanceToken: string): Promise<HiveClaimedTask | null> {
    return this.request('/api/runtime/tasks/claim', { method: 'POST', token: instanceToken });
  }

  progress(instanceToken: string, taskId: string, message: string, payload?: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/progress`, {
      method: 'POST',
      token: instanceToken,
      body: { message, payload },
    });
  }

  sendMessage(instanceToken: string, taskId: string, content: string): Promise<unknown> {
    return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: 'POST',
      token: instanceToken,
      body: { content },
    });
  }

  listMessages(instanceToken: string, taskId: string, since?: string): Promise<HiveTaskMessage[]> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/messages${query}`, { token: instanceToken });
  }

  complete(instanceToken: string, taskId: string, input: CompleteInput): Promise<unknown> {
    return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: 'POST',
      token: instanceToken,
      body: input,
      timeoutMs: 15_000,
    });
  }

  me(instanceToken: string): Promise<unknown> {
    return this.request('/api/runtime/me', { token: instanceToken });
  }

  /** 批量上报 DSH 运行时原始事件（实时日志）。 */
  appendRuntimeEvents(instanceToken: string, taskId: string, events: RuntimeEventInput[]): Promise<unknown> {
    return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/events`, {
      method: 'POST',
      token: instanceToken,
      body: { events },
    });
  }

  /** 直接读 Mnemos 的 `/v1/context`，失败返回 null（任务不应因记忆不可用而失败）。 */
  async fetchMemoryContext(memory: HiveClaimedTask['memory'], query: string, budgetTokens = 1200): Promise<string | null> {
    if (!memory?.enabled || !memory.baseUrl || !memory.apiKey) return null;
    try {
      const response = await fetch(`${memory.baseUrl.replace(/\/+$/, '')}/v1/context`, {
        method: 'POST',
        headers: { authorization: `Bearer ${memory.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: memory.agentId, query, budget_tokens: budgetTokens }),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { prompt?: string };
      return typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt : null;
    } catch {
      return null;
    }
  }
}
