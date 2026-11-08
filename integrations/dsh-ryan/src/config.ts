import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** 设置命名空间 = cordis.patch.yml 的行 id。 */
export const RYAN_SETTINGS_NAMESPACE = 'dsh-ryan';

export interface RyanPluginConfig {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  host: string;
  workspaceRoot: string;
  nodePath: string;
  enabled: boolean;
}

export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:4500').volatile(),
  // role('secret') 让设置页只显示已配置，不显示明文。
  apiKey: z.string().role('secret').default('').volatile(),
  instanceName: z.string().default('').volatile(),
  host: z.string().default('').volatile(),
  workspaceRoot: z.string().default('').volatile(),
  nodePath: z.string().default('').volatile(),
  enabled: z.boolean().default(true).volatile(),
});

export interface VolatileLike<T> {
  get(): T;
}

export type RawRyanPluginConfig = {
  [K in keyof RyanPluginConfig]?: RyanPluginConfig[K] | VolatileLike<RyanPluginConfig[K]>;
};

function unwrap<T>(field: T | VolatileLike<T> | undefined): T | undefined {
  if (field === undefined || field === null) return undefined;
  const ref = field as VolatileLike<T>;
  if (typeof ref.get === 'function') return ref.get() ?? undefined;
  return field as T;
}

export function defaultStateFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'dsh-ryan.json');
}

function findNodePath(): string {
  if (process.env.DSH_NODE && existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE;
  const candidates = [
    process.execPath.endsWith('node') ? process.execPath : '',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? 'node';
}

export function resolveConfig(raw?: RawRyanPluginConfig): RyanPluginConfig {
  const value = raw ?? {};
  return {
    baseUrl: (unwrap(value.baseUrl) ?? 'http://127.0.0.1:4500').replace(/\/+$/, ''),
    apiKey: unwrap(value.apiKey) ?? '',
    instanceName: unwrap(value.instanceName)?.trim() || hostname(),
    host: unwrap(value.host)?.trim() || hostname(),
    workspaceRoot: unwrap(value.workspaceRoot)?.trim() || join(homedir(), '.ryan', 'workspaces'),
    nodePath: unwrap(value.nodePath)?.trim() || findNodePath(),
    enabled: unwrap(value.enabled) ?? true,
  };
}
