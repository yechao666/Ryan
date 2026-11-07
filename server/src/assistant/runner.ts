import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../..');
const RESTRICTED_PATCH = join(REPO_ROOT, 'integrations/assistant/restricted.cordis.yml');

const sessions = new Map<string, string>();

export interface AssistantTurn {
  personName: string;
  personId: string;
  message: string;
  pathname: string;
  projectId?: string;
  taskId?: string;
  /** 项目对应的 DSH 工作区；缺省使用助手默认工作区。 */
  workspace?: string;
  token: string;
  apiBase: string;
  /** SSE/流式调用时接收 DSH 原始运行事件。 */
  onEvent?: (event: Record<string, unknown>) => void;
  /** 浏览器断开/取消时中止 DSH 子进程。 */
  signal?: AbortSignal;
}

export interface AssistantResult {
  reply: string;
  navigate?: string;
  sessionId?: string;
  instance: string;
}

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function dshBin(): string {
  return process.env.HIVE_DSH_BIN || 'dsh';
}

function profile(): string {
  return process.env.HIVE_DSH_PROFILE || 'headless';
}

function workspace(): string {
  // 助手只在自己的运行目录中工作，不再把 Aiwo 源码仓库作为 cwd。
  return process.env.HIVE_DSH_WORKSPACE || join(homedir(), '.aiwo', 'assistant');
}

function sessionKey(input: AssistantTurn): string {
  return `${input.personId}::${input.workspace ?? ''}`;
}

async function deepseekKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const yaml = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
    const match = yaml.match(/DEEPSEEK_API_KEY:\s*["']?([^\s"']+)/);
    if (match?.[1]) return match[1];
  } catch {
    /* fall through */
  }
  return '';
}

function buildPrompt(input: AssistantTurn): string {
  return [
    '你是 Aiwo 平台内置的 DSH 系统助手，运行在一个真实的 DSH headless 服务中。',
    'Aiwo 没有智员概念：任务执行者固定为「人员@Aiwo」。你的职责是直接帮助当前人员操作系统，而不是只给出操作步骤。',
    '',
    `当前人员：${input.personName}（${input.personId}）`,
    `当前页面：${input.pathname}`,
    `当前项目：${input.projectId ?? '不在项目内'}`,
    `当前任务：${input.taskId ?? '未打开具体任务'}${input.taskId ? '（用户说“这个任务”时使用这个 ID）' : ''}`,
    '任务详情页路径格式：/projects/:projectId/tasks/:taskId（不要使用 ?task= 查询参数）。',
    '',
    '你只有一个工具：aiwo_api。它只能通过 HTTP 访问当前 Aiwo 服务的 /api 路径。',
    '你没有 shell、文件读写、文件搜索、web_fetch、skill、subagent 等工具；不要尝试执行命令或读取文件。',
    'API 契约只来自稳定 manifest，不通过阅读源码推断接口。',
    '第一步调用 aiwo_api GET /api/assistant/manifest 获取完整接口清单；manifest 是唯一的 API 定义来源。',
    '',
    '工具调用形式：aiwo_api({ method: "GET"|"POST"|"PATCH"|"DELETE", path: "/api/...", body?: object })。',
    '常用路径：/api/projects、/api/teams、/api/persons、/api/instances、/api/tasks、/api/prompt-cards；',
    'POST /api/projects/:id/tasks、POST /api/prompt-cards、POST /api/instances、POST /api/automations/:id/run。',
    '',
    '执行规则：',
    '- 用户明确要求创建/修改/查询时，直接调用 aiwo_api 完成；先做必要的查询确认 ID 和权限。',
    '- 不要修改仓库源码、数据库文件或系统配置，只通过开放 API 操作。',
    '- 写操作完成后用中文简洁说明做了什么（名称、ID、时间等）；没有执行写操作就不要声称已执行。',
    '- 如果操作影响某个页面，最后单独输出一行：HIVE_NAVIGATE: /projects/...（只能是站内以 / 开头的路径）。',
    '- 权限不足或 API 返回错误时，如实说明，不要伪造成功。',
    '',
    '用户请求：',
    input.message,
  ].join('\n');
}

function extractNavigation(text: string): { reply: string; navigate?: string } {
  const match = text.match(/^HIVE_NAVIGATE:\s*(\/\S+)\s*$/m);
  if (!match) return { reply: text.trim() };
  return {
    reply: text.replace(match[0], '').trim(),
    navigate: match[1],
  };
}

async function runAssistantTurnOnce(input: AssistantTurn): Promise<AssistantResult> {
  const apiKey = await deepseekKey();
  if (!apiKey) {
    throw new Error('Aiwo 助手缺少 DEEPSEEK_API_KEY：请在服务器环境中配置，或写入 ~/.dsh/.credentials.yaml');
  }
  const prompt = buildPrompt(input);
  const cwd = input.workspace || workspace();
  await mkdir(cwd, { recursive: true });
  const key = sessionKey(input);
  const previous = sessions.get(key);
  const args = ['--profile', profile(), '--patch', RESTRICTED_PATCH, '--json'];
  if (previous) args.push('--session-id', previous);
  args.push('-');

  const env = {
    ...process.env,
    DSH_HOME: dshHome(),
    DEEPSEEK_API_KEY: apiKey,
    DSH_HIVE_RUNTIME_DISABLED: '1',
    AIWO_API_BASE: input.apiBase,
    HIVE_TOKEN: input.token,
  };

  const tokenDir = await mkdtemp(join(tmpdir(), 'aiwo-assistant-'));
  const tokenFile = join(tokenDir, 'token');
  await writeFile(tokenFile, input.token, { mode: 0o600 });
  const child = spawn(dshBin(), args, {
    cwd,
    env: { ...env, HIVE_AUTH_FILE: tokenFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const abortChild = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  };
  input.signal?.addEventListener('abort', abortChild, { once: true });

  let stdout = '';
  let stderr = '';
  let buffer = '';
  let finalText = '';
  let lastText = '';
  let sessionId = previous;
  let failure = '';

  const exitPromise = new Promise<number | null>((resolveExit, reject) => {
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`无法启动 DSH（${dshBin()}）：${error.message}`));
    });
    child.once('close', (code) => done(code));
    child.once('exit', (code) => setTimeout(() => done(code), 300));
  });

  const handleEvent = (event: any): void => {
    if (event && typeof event.type === 'string') {
      try {
        input.onEvent?.(event);
      } catch {
        /* 事件消费者失败不影响助手主流程 */
      }
    }
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (event.type === 'text' && typeof event.text === 'string' && event.text.trim()) lastText = event.text;
    if (event.type === 'final' && typeof event.text === 'string') finalText = event.text;
    if (event.type === 'error' && typeof event.message === 'string') failure = event.message;
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });

  const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000);
  timeout.unref?.();
  try {
    child.stdin.end(prompt);
    const code = await exitPromise;
    if (buffer.trim()) {
      try {
        handleEvent(JSON.parse(buffer.trim()));
      } catch {
        /* ignore */
      }
    }
    if (failure) throw new Error(failure);
    if (code !== 0) throw new Error(`DSH 助手退出码 ${String(code)}：${(stderr || stdout).trim().slice(-1200) || '无输出'}`);
    const raw = (finalText || lastText).trim();
    if (!raw) throw new Error('DSH 助手没有返回内容');
    if (sessionId) sessions.set(key, sessionId);
    return { ...extractNavigation(raw), sessionId, instance: 'aiwo-assistant' };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortChild);
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(tokenDir, { recursive: true, force: true });
  }
}


const assistantQueues = new Map<string, Promise<void>>();
const SESSION_LOCK_RE = /already owned by an active write handle|active write handle|session[^\n]*locked/i;

/**
 * 同一人员的助手请求串行执行；DSH session 若被遗留进程锁住，清掉 session 并用新会话重试一次。
 * 避免多标签页/流式请求取消后出现 “session already owned” 永久失败。
 */
export async function runAssistantTurn(input: AssistantTurn): Promise<AssistantResult> {
  const previous = assistantQueues.get(input.personId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  assistantQueues.set(input.personId, chained);
  await previous;
  try {
    try {
      return await runAssistantTurnOnce(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!SESSION_LOCK_RE.test(message)) throw error;
      sessions.delete(sessionKey(input));
      return await runAssistantTurnOnce(input);
    }
  } finally {
    release();
    if (assistantQueues.get(input.personId) === chained) assistantQueues.delete(input.personId);
  }
}
