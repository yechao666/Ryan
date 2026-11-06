/**
 * DSH 凭据辅助：headless profile 不会自动读取凭据服务，
 * 若环境里没有 DEEPSEEK_API_KEY，则从 $DSH_HOME/.credentials.yaml 的 refs 中读取并注入子进程。
 * 密钥只进入子进程 env，不写日志。
 */
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

export function resolveDshHome(dshHome) {
  return dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 从 .credentials.yaml 的 `refs:` 块读取某个凭据值；失败返回 null。 */
export function readCredentialRef(name, dshHome) {
  const file = path.join(resolveDshHome(dshHome), '.credentials.yaml');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inRefs) {
      if (/^refs:\s*$/.test(line)) inRefs = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const match = /^\s+(["']?)([A-Za-z0-9_]+)\1:\s*(.*)$/.exec(line);
    if (match && match[2] === name) {
      let value = match[3].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || null;
    }
  }
  return null;
}

/** 构造 DSH 子进程环境变量。 */
export function buildDshEnv(config, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (config.dshHome) env.DSH_HOME = config.dshHome;
  if (config.credentials && !env.DEEPSEEK_API_KEY) {
    const key = readCredentialRef('DEEPSEEK_API_KEY', config.dshHome);
    if (key) env.DEEPSEEK_API_KEY = key;
  }
  return env;
}
