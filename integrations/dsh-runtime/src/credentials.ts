/** 为 headless 子进程解析 DEEPSEEK_API_KEY；只在内存/子进程 env 中出现，不写日志。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type { HiveRuntimeConfig } from './config.js';

export interface CredentialResolution {
  apiKey?: string;
  source: 'environment' | 'credentials-file' | 'missing';
  file?: string;
}

export async function resolveDeepseekApiKey(config: HiveRuntimeConfig): Promise<CredentialResolution> {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && fromEnv.trim()) return { apiKey: fromEnv.trim(), source: 'environment' };
  if (!config.useDshCredentials) return { source: 'missing' };
  const file = config.credentialsFile || join(config.dshHome, '.credentials.yaml');
  try {
    const doc = YAML.parse(await readFile(file, 'utf8')) as { refs?: Record<string, unknown> } | null;
    const ref = doc?.refs?.DEEPSEEK_API_KEY;
    if (typeof ref === 'string' && ref.trim()) return { apiKey: ref.trim(), source: 'credentials-file', file };
  } catch {
    /* 文件不存在/不可读时交给子进程报错 */
  }
  return { source: 'missing', file };
}
