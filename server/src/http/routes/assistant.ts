import { z } from 'zod';
import type { Router } from '../router.ts';
import { requirePerson } from '../auth.ts';
import { errors } from '../respond.ts';
import { runAssistantTurn } from '../../assistant/runner.ts';
import { checkUserInput } from '../../security/check.ts';
import { assistantApiManifest } from '../../assistant/manifest.ts';
import type { ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const chatSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  pathname: z.string().trim().max(500).optional().default('/'),
  projectId: z.string().trim().max(80).optional(),
  taskId: z.string().trim().max(80).optional(),
  conversationId: z.string().trim().max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
});

/** 项目工作区由服务端按项目 ID 自动生成，不读取/保存路径配置。 */
function projectWorkspaceFor(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  const root = process.env.AIWO_WORKSPACE_ROOT || join(homedir(), '.aiwo', 'workspaces');
  const safe = projectId.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = join(root, 'projects', safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function bearerToken(header: string | undefined): string {
  if (!header) return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

class EventQueue<T> {
  private items: T[] = [];
  private waiters: ((item: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 文本按码点切块，让前端在 SSE 上看到逐段输出。 */
async function streamText(res: ServerResponse, text: string): Promise<void> {
  const chars = Array.from(text);
  if (chars.length === 0) return;
  const maxChunks = 48;
  const size = Math.max(1, Math.ceil(chars.length / maxChunks));
  for (let index = 0; index < chars.length; index += size) {
    if (res.writableEnded || res.destroyed) return;
    sseWrite(res, 'text', { delta: chars.slice(index, index + size).join('') });
    // 文本块通常一次性到达；用小间隔还原常见的逐字输出观感。
    if (chars.length > size) await sleep(12);
  }
}

/** 思考块逐片下发；第一片带 start，前端据此新开一个折叠块。 */
async function streamThinking(res: ServerResponse, text: string): Promise<void> {
  const chars = Array.from(text);
  if (chars.length === 0) return;
  const maxChunks = 40;
  const size = Math.max(1, Math.ceil(chars.length / maxChunks));
  for (let index = 0; index < chars.length; index += size) {
    if (res.writableEnded || res.destroyed) return;
    sseWrite(res, 'thinking', {
      delta: chars.slice(index, index + size).join(''),
      start: index === 0,
    });
    if (chars.length > size) await sleep(8);
  }
}

export function registerAssistantRoutes(router: Router): void {
  // 助手/客户端读取稳定 API 清单；不从源码推断接口。
  router.get('/api/assistant/manifest', (rc) => {
    requirePerson(rc);
    rc.json(assistantApiManifest());
  });

  // POST /api/assistant/chat/stream —— SSE 流式助手；DSH 事件实时转发。
  router.post('/api/assistant/chat/stream', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(chatSchema);
    const security = await checkUserInput({ db: rc.app.db, personId: person.id, source: 'assistant', content: input.message });
    if (!security.allowed) {
      throw errors.badRequest(security.blockedMessage ?? '输入未通过安全检查', { reason: security.reason });
    }
    const token = bearerToken(rc.req.headers.authorization);
    if (!token) throw errors.unauthorized('助手需要当前人员的登录凭证');

    const queue = new EventQueue<
      | { kind: 'event'; event: Record<string, unknown> }
      | { kind: 'done'; result: Awaited<ReturnType<typeof runAssistantTurn>> }
      | { kind: 'error'; error: unknown }
    >();
    const controller = new AbortController();
    const res = rc.res;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.setHeader('x-request-id', rc.requestId);
    res.flushHeaders?.();

    const keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, 15_000);
    keepAlive.unref?.();
    res.on('close', () => controller.abort());

    sseWrite(res, 'meta', { person: { id: person.id, name: person.name }, pathname: input.pathname ?? '/' });
    void runAssistantTurn({
      personId: person.id,
      personName: person.name,
      message: input.message,
      pathname: input.pathname || '/',
      projectId: input.projectId,
      taskId: input.taskId,
      workspace: projectWorkspaceFor(input.projectId),
      conversationId: input.conversationId,
      token,
      apiBase:
        process.env.HIVE_API_BASE ||
        `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`,
      signal: controller.signal,
      onEvent: (event) => queue.push({ kind: 'event', event }),
    })
      .then((result) => queue.push({ kind: 'done', result }))
      .catch((error: unknown) => queue.push({ kind: 'error', error }));

    let streamedText = '';
    try {
      for (;;) {
        const item = await queue.next();
        if (item.kind === 'event') {
          const event = item.event;
          const type = String(event.type ?? '');
          if (type === 'text' && typeof event.text === 'string' && event.text) {
            let delta = event.text;
            if (delta.startsWith(streamedText)) delta = delta.slice(streamedText.length);
            else if (streamedText.startsWith(delta)) delta = '';
            if (delta) {
              streamedText += delta;
              await streamText(res, delta);
            }
          } else if (type === 'thinking' && typeof event.text === 'string' && event.text.trim()) {
            await streamThinking(res, event.text);
          } else if (type === 'status') {
            sseWrite(res, 'status', { phase: event.phase ?? '', turn: event.turn, step: event.step });
          } else if (type === 'tool' || type === 'tool_call' || type === 'tool_result') {
            sseWrite(res, 'tool', {
              kind: type === 'tool_result' ? 'tool_result' : 'tool_call',
              callId: event.callId,
              tool: event.tool ?? event.title ?? 'tool',
              input: event.input,
              status: event.status,
              result: event.result ?? event.content,
            });
          } else if (type === 'error') {
            sseWrite(res, 'error', { message: String(event.message ?? '助手运行错误') });
          }
        } else if (item.kind === 'done') {
          sseWrite(res, 'done', {
            reply: item.result.reply,
            navigate: item.result.navigate,
            sessionId: item.result.sessionId,
            instance: item.result.instance,
          });
          break;
        } else {
          const message = item.error instanceof Error ? item.error.message : String(item.error);
          sseWrite(res, 'error', { message });
          break;
        }
      }
    } finally {
      clearInterval(keepAlive);
      controller.abort();
      if (!res.writableEnded) res.end();
    }
  });

  // POST /api/assistant/chat —— DSH 系统助手（可调用全部开放 API）
  router.post('/api/assistant/chat', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(chatSchema);
    const security = await checkUserInput({ db: rc.app.db, personId: person.id, source: 'assistant', content: input.message });
    if (!security.allowed) {
      throw errors.badRequest(security.blockedMessage ?? '输入未通过安全检查', { reason: security.reason });
    }
    const token = bearerToken(rc.req.headers.authorization);
    if (!token) throw errors.unauthorized('助手需要当前人员的登录凭证');

    try {
      const result = await runAssistantTurn({
        personId: person.id,
        personName: person.name,
        message: input.message,
        pathname: input.pathname || '/',
        projectId: input.projectId,
        taskId: input.taskId,
        workspace: projectWorkspaceFor(input.projectId),
        conversationId: input.conversationId,
        token,
        apiBase:
          process.env.HIVE_API_BASE ||
          `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`,
      });
      rc.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw errors.serviceUnavailable(`DSH 助手暂不可用：${message}`);
    }
  });
}
