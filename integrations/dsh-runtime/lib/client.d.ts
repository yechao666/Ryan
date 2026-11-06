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
    project: {
        id: string;
        name: string;
        slug: string;
        prompt?: string;
        repoUrl?: string;
        type: string;
    };
    agent: {
        id: string;
        name: string;
        memoryAgentId: string;
        capabilities: string[];
    };
    memory: {
        baseUrl: string;
        projectId: string;
        apiKey: string;
        agentId: string;
        enabled: boolean;
    };
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
export declare class HiveApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export declare class HiveClient {
    private readonly resolve;
    constructor(resolve: () => HiveRuntimeConfig);
    private request;
    register(agentToken: string, input: {
        name: string;
        host: string;
        workspacePath: string;
        version: string;
    }): Promise<RegisterResult>;
    heartbeat(instanceToken: string): Promise<{
        ok: boolean;
        instance: {
            id: string;
            name: string;
            lastSeenAt: string;
        };
        pending?: {
            queued: number;
        };
    }>;
    claim(instanceToken: string): Promise<HiveClaimedTask | null>;
    progress(instanceToken: string, taskId: string, message: string, payload?: Record<string, unknown>): Promise<unknown>;
    sendMessage(instanceToken: string, taskId: string, content: string): Promise<unknown>;
    listMessages(instanceToken: string, taskId: string, since?: string): Promise<HiveTaskMessage[]>;
    complete(instanceToken: string, taskId: string, input: CompleteInput): Promise<unknown>;
    me(instanceToken: string): Promise<unknown>;
    /** 批量上报 DSH 运行时原始事件（实时日志）。 */
    appendRuntimeEvents(instanceToken: string, taskId: string, events: RuntimeEventInput[]): Promise<unknown>;
    /** 直接读 Mnemos 的 `/v1/context`，失败返回 null（任务不应因记忆不可用而失败）。 */
    fetchMemoryContext(memory: HiveClaimedTask['memory'], query: string, budgetTokens?: number): Promise<string | null>;
}
