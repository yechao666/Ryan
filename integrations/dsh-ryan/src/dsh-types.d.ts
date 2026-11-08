/**
 * DSH 宿主的本地最小类型声明。
 *
 * 插件刻意不在运行时 import `@deepseek-ai/cordis` / `dsh-agent` / `dsh-session`
 * 等 harness bundle 包：profile 里被提升的副本会劈裂模块级 Symbol，导致宿主服务
 * 失效。所有服务都通过 `ctx.get(name)` 结构化取得，类型在这里声明。
 */

export interface Disposable {
  (): void;
}

export interface Context {
  get<T = unknown>(name: string, strict?: boolean): T | undefined;
  inject(names: string[], callback: (ctx: Context) => void): void;
  effect(fn: () => void | Disposable, label?: string): void;
  on(event: string, listener: (...args: any[]) => void): Disposable;
  fiber?: unknown;
}

export interface SettingsService {
  configure?: (policy: { auto?: boolean }, owner?: unknown) => Disposable;
}

export interface AgentLike {
  id?: string;
  status?: 'idle' | 'running' | string;
  session: SessionLike;
  followup(message: unknown): void;
  steer?(message: unknown): void;
  cancel?(cause: unknown, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

export interface SessionLike {
  seq: number;
  eventAt(index: number): SessionEventLike | undefined;
}

export interface SessionEventLike {
  type: string;
  seq: number;
  data?: any;
}

export interface AgentsService {
  create(options: {
    sessionId: string;
    meta?: { cwd?: string };
    agentOptions?: { provider?: string; model?: string };
    setup?: (agentCtx: unknown, agent: AgentLike) => void | Promise<void>;
  }): Promise<{ agent: AgentLike }>;
  get?(id: string): AgentLike | undefined;
}

export interface SessionsService {
  flush(session: SessionLike): Promise<void>;
}

export interface AgentDefaultModelService {
  currentSelection?: () => { provider: string; model: string };
}

export interface FsService {
  resolve(path: string): Promise<unknown>;
  processPath(input: unknown): string;
}

export interface SubagentsService {
  waitForChildren?(parent: AgentLike): Promise<boolean>;
}
