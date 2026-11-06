import z from '@deepseek-ai/schemastery';
/** 设置命名空间 = cordis.patch.yml 的行 id。 */
export declare const HIVE_RUNTIME_SETTINGS_NAMESPACE = "dsh-hive-runtime";
export type ExecutionMode = 'headless' | 'agent' | 'command' | 'echo';
export interface HiveRuntimeConfig {
    baseUrl: string;
    agentToken: string;
    instanceName: string;
    host: string;
    workspacePath: string;
    autoClaim: boolean;
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
    executionMode: ExecutionMode;
    commandTemplate: string;
    dshBin: string;
    dshHome: string;
    headlessProfile: string;
    useDshCredentials: boolean;
    credentialsFile: string;
    maxTaskMinutes: number;
    stateFile: string;
    includeMemoryContext: boolean;
    provider: string;
    model: string;
    announceToAgent: boolean;
    enabled: boolean;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    baseUrl: z<string, string, "volatile-defined">;
    agentToken: z<string, string, "volatile-defined">;
    instanceName: z<string, string, "volatile-defined">;
    host: z<string, string, "volatile-defined">;
    workspacePath: z<string, string, "volatile-defined">;
    autoClaim: z<boolean, boolean, "volatile-defined">;
    pollIntervalMs: z<number, number, "volatile-defined">;
    heartbeatIntervalMs: z<number, number, "volatile-defined">;
    executionMode: z<"headless" | "agent" | "command" | "echo", "headless" | "agent" | "command" | "echo", "volatile-defined">;
    commandTemplate: z<string, string, "volatile-defined">;
    dshBin: z<string, string, "volatile-defined">;
    dshHome: z<string, string, "volatile-defined">;
    headlessProfile: z<string, string, "volatile-defined">;
    useDshCredentials: z<boolean, boolean, "volatile-defined">;
    credentialsFile: z<string, string, "volatile-defined">;
    maxTaskMinutes: z<number, number, "volatile-defined">;
    stateFile: z<string, string, "volatile-defined">;
    includeMemoryContext: z<boolean, boolean, "volatile-defined">;
    provider: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    baseUrl: z<string, string, "volatile-defined">;
    agentToken: z<string, string, "volatile-defined">;
    instanceName: z<string, string, "volatile-defined">;
    host: z<string, string, "volatile-defined">;
    workspacePath: z<string, string, "volatile-defined">;
    autoClaim: z<boolean, boolean, "volatile-defined">;
    pollIntervalMs: z<number, number, "volatile-defined">;
    heartbeatIntervalMs: z<number, number, "volatile-defined">;
    executionMode: z<"headless" | "agent" | "command" | "echo", "headless" | "agent" | "command" | "echo", "volatile-defined">;
    commandTemplate: z<string, string, "volatile-defined">;
    dshBin: z<string, string, "volatile-defined">;
    dshHome: z<string, string, "volatile-defined">;
    headlessProfile: z<string, string, "volatile-defined">;
    useDshCredentials: z<boolean, boolean, "volatile-defined">;
    credentialsFile: z<string, string, "volatile-defined">;
    maxTaskMinutes: z<number, number, "volatile-defined">;
    stateFile: z<string, string, "volatile-defined">;
    includeMemoryContext: z<boolean, boolean, "volatile-defined">;
    provider: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
export interface VolatileLike<T> {
    get(): T;
}
export type RawHiveRuntimeConfig = {
    [K in keyof HiveRuntimeConfig]?: HiveRuntimeConfig[K] | VolatileLike<HiveRuntimeConfig[K]>;
};
export declare function defaultStateFile(): string;
export declare function resolveConfig(input: RawHiveRuntimeConfig | undefined): HiveRuntimeConfig;
