import type { Context, SessionEventLike } from './dsh-types.js';
import type { HiveRuntimeConfig } from './config.js';
import { type HiveClaimedTask } from './client.js';
export interface TaskExecutionInput {
    task: HiveClaimedTask;
    config: HiveRuntimeConfig;
    memoryBrief?: string | null;
}
export interface ExecutionHooks {
    progress(message: string, payload?: Record<string, unknown>): void;
    log(message: string, fields?: Record<string, unknown>): void;
    /** 转发 DSH headless NDJSON 事件到 Hive，控制台实时展示。 */
    runtime?(event: {
        type: string;
        payload: Record<string, unknown>;
        at?: string;
    }): void;
}
export interface ExecutionOutput {
    summary: string;
    decisions?: string[];
    lessons?: string[];
    /** headless 会话 id，服务端保存后用于任务完成后的追问。 */
    sessionId?: string;
}
export type TaskExecutor = (input: TaskExecutionInput, hooks: ExecutionHooks, signal: AbortSignal) => Promise<ExecutionOutput>;
/** 中文提示词：任务 + 项目 + 记忆简报 + 历史消息。 */
export declare function buildTaskPrompt(input: TaskExecutionInput): string;
/** 从 Session 持久事件里提取本轮最后的助手文本与结束原因。 */
export declare function summarizeSession(session: {
    seq: number;
    eventAt(index: number): SessionEventLike | undefined;
}, firstSeq: number): string;
export declare function extractMemoryItems(summary: string): {
    decisions: string[];
    lessons: string[];
};
/** 联调用：不真正调用 LLM。 */
export declare function createEchoExecutor(): TaskExecutor;
/** 外部命令执行器：任务通过环境变量注入，stdout 作为结果。 */
export declare function createCommandExecutor(): TaskExecutor;
/**
 * headless 执行器（默认）：每个任务一个 `dsh --profile headless --json -` 子进程。
 * 任务经 stdin 传入，NDJSON 事件用于进展上报，final 事件作为最终答案。
 * 子进程环境会禁用本插件，避免递归注册。
 *
 * 会话延续仅限运行中的任务：本轮结束后用 `--session-id` 继续跑，直到没有新消息。
 * 任务完成即结束，不再续聊。
 */
export declare function createHeadlessExecutor(): TaskExecutor;
/**
 * DSH 进程内执行器：每任务一个独立 Session，完成后写回摘要。
 * 服务全部从宿主 ctx 惰性获取，不 import harness bundle 包。
 */
export declare function createAgentExecutor(ctx: Context): TaskExecutor;
export declare function createExecutor(ctx: Context, config: HiveRuntimeConfig): TaskExecutor;
