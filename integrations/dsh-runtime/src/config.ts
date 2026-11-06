import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** 设置命名空间 = cordis.patch.yml 的行 id。 */
export const HIVE_RUNTIME_SETTINGS_NAMESPACE = 'dsh-hive-runtime';

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

export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:4400').volatile(),
  // role('secret')：设置页/日志只显示已配置，不显示明文。
  agentToken: z.string().role('secret').default('').volatile(),
  instanceName: z.string().default('').volatile(),
  host: z.string().default('').volatile(),
  workspacePath: z.string().default('').volatile(),
  autoClaim: z.boolean().default(true).volatile(),
  pollIntervalMs: z.number().default(5000).volatile(),
  heartbeatIntervalMs: z.number().default(20000).volatile(),
  executionMode: z
    .union([z.const('headless'), z.const('agent'), z.const('command'), z.const('echo')])
    .default('headless')
    .volatile(),
  commandTemplate: z.string().default('').volatile(),
  dshBin: z.string().default('dsh').volatile(),
  dshHome: z.string().default('').volatile(),
  headlessProfile: z.string().default('headless').volatile(),
  useDshCredentials: z.boolean().default(true).volatile(),
  credentialsFile: z.string().default('').volatile(),
  maxTaskMinutes: z.number().default(30).volatile(),
  stateFile: z.string().default('').volatile(),
  includeMemoryContext: z.boolean().default(true).volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
  enabled: z.boolean().default(true).volatile(),
});

export interface VolatileLike<T> {
  get(): T;
}

export type RawHiveRuntimeConfig = {
  [K in keyof HiveRuntimeConfig]?: HiveRuntimeConfig[K] | VolatileLike<HiveRuntimeConfig[K]>;
};

function unwrap<T>(field: T | VolatileLike<T> | undefined): T | undefined {
  if (field === undefined || field === null) return undefined;
  const ref = field as VolatileLike<T>;
  if (typeof ref.get === 'function') return ref.get() ?? undefined;
  return field as T;
}

export function defaultStateFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'state', 'dsh-hive-runtime.json');
}

export function resolveConfig(input: RawHiveRuntimeConfig | undefined): HiveRuntimeConfig {
  const value = input ?? {};
  const rawName = unwrap(value.instanceName)?.trim();
  const rawHost = unwrap(value.host)?.trim();
  const rawWorkspace = unwrap(value.workspacePath)?.trim();
  return {
    baseUrl: (unwrap(value.baseUrl) ?? 'http://127.0.0.1:4400').replace(/\/+$/, ''),
    agentToken: unwrap(value.agentToken) ?? '',
    instanceName: rawName || hostname(),
    host: rawHost || hostname(),
    workspacePath: rawWorkspace || process.cwd(),
    autoClaim: unwrap(value.autoClaim) ?? true,
    pollIntervalMs: Math.max(500, unwrap(value.pollIntervalMs) ?? 5000),
    heartbeatIntervalMs: Math.max(1000, unwrap(value.heartbeatIntervalMs) ?? 20000),
    executionMode: (unwrap(value.executionMode) ?? 'headless') as ExecutionMode,
    commandTemplate: unwrap(value.commandTemplate) ?? '',
    dshBin: unwrap(value.dshBin)?.trim() || 'dsh',
    dshHome: unwrap(value.dshHome)?.trim() || (process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    headlessProfile: unwrap(value.headlessProfile)?.trim() || 'headless',
    useDshCredentials: unwrap(value.useDshCredentials) ?? true,
    credentialsFile: unwrap(value.credentialsFile)?.trim() || '',
    maxTaskMinutes: Math.max(1, unwrap(value.maxTaskMinutes) ?? 30),
    stateFile: unwrap(value.stateFile)?.trim() || defaultStateFile(),
    includeMemoryContext: unwrap(value.includeMemoryContext) ?? true,
    provider: unwrap(value.provider)?.trim() ?? '',
    model: unwrap(value.model)?.trim() ?? '',
    announceToAgent: unwrap(value.announceToAgent) ?? true,
    enabled: unwrap(value.enabled) ?? true,
  };
}
