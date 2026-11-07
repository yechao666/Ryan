/**
 * Aiwo 内部 AI 任务的本地 DSH 调用器。
 * 只使用本机 dsh headless，不允许工具调用，不依赖外部 Mnemos/摘要服务。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NO_TOOLS_PATCH = join(REPO_ROOT, 'integrations', 'ai', 'no-tools.cordis.yml');

async function deepseekKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml');
    const yaml = await readFile(file, 'utf8');
    const match = yaml.match(/DEEPSEEK_API_KEY:\s*["']?([^\s"']+)/);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

export interface DshTextOptions {
  prompt: string;
  timeoutMs?: number;
  maxChars?: number;
}

/** 调用本机 DSH headless 生成文本；失败返回空字符串，由调用方回退。 */
export async function runDshText({ prompt, timeoutMs = 25_000, maxChars = 20_000 }: DshTextOptions): Promise<string> {
  if (process.env.AIWO_LOCAL_AI === '0') return '';
  const key = await deepseekKey();
  if (!key) return '';
  const dir = await mkdtemp(join(tmpdir(), 'aiwo-ai-'));
  const child = spawn(process.env.HIVE_DSH_BIN || 'dsh', [
    '--profile', 'headless',
    '--patch', NO_TOOLS_PATCH,
    '--json', '-',
  ], {
    cwd: dir,
    env: {
      ...process.env,
      DSH_HOME: process.env.DSH_HOME || join(homedir(), '.dsh'),
      DEEPSEEK_API_KEY: key,
      DSH_HIVE_RUNTIME_DISABLED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let text = '';
  let finalText = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; text?: string };
        if (event.type === 'text' && event.text) text = event.text;
        if (event.type === 'final' && event.text) finalText = event.text;
      } catch { /* ignore */ }
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch { /* noop */ }
  }, timeoutMs);
  timer.unref?.();
  try {
    child.stdin.end(prompt);
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    if (timedOut) return '';
    return String(finalText || text || '').trim().slice(0, maxChars);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
}
