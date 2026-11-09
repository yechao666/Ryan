import z from '@deepseek-ai/schemastery';
/** 设置命名空间 = cordis.patch.yml 的行 id。 */
export declare const RYAN_SETTINGS_NAMESPACE = "dsh-ryan";
export interface RyanPluginConfig {
    baseUrl: string;
    apiKey: string;
    instanceName: string;
    host: string;
    kind: 'local' | 'remote';
    workspaceRoot: string;
    nodePath: string;
    enabled: boolean;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    baseUrl: z<string, string, "volatile-defined">;
    apiKey: z<string, string, "volatile-defined">;
    instanceName: z<string, string, "volatile-defined">;
    host: z<string, string, "volatile-defined">;
    kind: z<"local" | "remote", "local" | "remote", "volatile-defined">;
    workspaceRoot: z<string, string, "volatile-defined">;
    nodePath: z<string, string, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    baseUrl: z<string, string, "volatile-defined">;
    apiKey: z<string, string, "volatile-defined">;
    instanceName: z<string, string, "volatile-defined">;
    host: z<string, string, "volatile-defined">;
    kind: z<"local" | "remote", "local" | "remote", "volatile-defined">;
    workspaceRoot: z<string, string, "volatile-defined">;
    nodePath: z<string, string, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
export interface VolatileLike<T> {
    get(): T;
}
export type RawRyanPluginConfig = {
    [K in keyof RyanPluginConfig]?: RyanPluginConfig[K] | VolatileLike<RyanPluginConfig[K]>;
};
export declare function defaultStateFile(): string;
export declare function resolveConfig(raw?: RawRyanPluginConfig): RyanPluginConfig;
