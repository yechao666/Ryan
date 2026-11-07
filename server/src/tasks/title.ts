import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function dshBin(): string {
  return process.env.HIVE_DSH_BIN || 'dsh';
}

async function deepseekKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const yaml = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
    const match = yaml.match(/DEEPSEEK_API_KEY:\s*["']?([^\s"']+)/);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

/** 无 AI 时的确定性标题：取任务内容第一行，去掉 /goal 与 Markdown 标记。 */
export function fallbackTaskTitle(content: string): string {
  const first = String(content ?? '')
    .replace(/^\/goal\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*+\-\d.\s]+/, '').trim())
    .find(Boolean) ?? '';
  const title = first.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
  return (title || '未命名任务').slice(0, 40);
}

function cleanTitle(raw: string): string {
  const value = String(raw ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  return value
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^[-*#>\d.\s]+/, '')
    .replace(/^(标题|任务标题)[:：]\s*/i, '')
    .trim()
    .slice(0, 40);
}

/** 用 DSH headless 让模型整理短标题；失败或无凭据时回退到内容首行。 */
export async function generateTaskTitle(content: string): Promise<string> {
  const fallback = fallbackTaskTitle(content);
  if (process.env.AIWO_TITLE_AI === '0') return fallback;
  const key = await deepseekKey();
  if (!key) return fallback;
  const dir = await mkdtemp(join(tmpdir(), 'aiwo-title-'));
  const child = spawn(dshBin(), ['--profile', 'headless', '--json', '-'], {
    cwd: dir,
    env: {
      ...process.env,
      DSH_HOME: dshHome(),
      DEEPSEEK_API_KEY: key,
      DSH_HIVE_RUNTIME_DISABLED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let text = '';
  let finalText = '';
  let buffer = '';
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
      } catch {
        /* ignore */
      }
    }
  });
  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
  }, 5000);
  timeout.unref?.();
  try {
    child.stdin.end(`为下面的任务内容生成一个不超过 24 个中文字符的简短标题。只输出标题本身，不要引号、不要解释、不要 Markdown。\n\n${String(content).slice(0, 4000)}`);
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    const cleaned = cleanTitle(finalText || text);
    return cleaned || fallback;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
}
