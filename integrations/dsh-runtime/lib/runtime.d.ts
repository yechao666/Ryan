import type { Context } from './dsh-types.js';
import type { HiveRuntimeConfig } from './config.js';
import { HiveClient } from './client.js';
export declare const RUNTIME_VERSION = "0.1.0";
export interface RuntimeLogger {
    debug?(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}
export declare class HiveRuntime {
    private readonly ctx;
    private readonly resolve;
    private readonly client;
    private readonly logger;
    private running;
    private timer;
    private heartbeatTimer;
    private abortController;
    private currentRun;
    private state;
    private currentTask;
    private lastHeartbeatAt;
    private registeredAt;
    private stopped;
    constructor(ctx: Context, resolve: () => HiveRuntimeConfig, client: HiveClient, logger: RuntimeLogger);
    get instanceId(): string | null;
    get isRunning(): boolean;
    snapshot(): Record<string, unknown>;
    start(): Promise<void>;
    stop(): Promise<void>;
    private ensureInstance;
    private startLoops;
    private heartbeat;
    private schedule;
    private claimOnce;
    private runTask;
    private loadState;
    private saveState;
}
