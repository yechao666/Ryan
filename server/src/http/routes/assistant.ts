import { z } from 'zod';
import type { Router } from '../router.ts';
import { requirePerson } from '../auth.ts';
import { errors } from '../respond.ts';
import { runAssistantTurn } from '../../assistant/runner.ts';
import { checkUserInput } from '../../security/check.ts';
import { assistantApiManifest } from '../../assistant/manifest.ts';
import { generateSuggestions } from '../../assistant/suggestions.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import type { Db } from '../../db/index.ts';
import type { Person } from '../../../../shared/src/types.ts';
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

interface StoredProcessBlock {
  id: string;
  kind: 'thinking' | 'tool';
  text?: string;
  tool?: string;
  callId?: string;
  input?: unknown;
  result?: string;
  status?: string;
  done: boolean;
}

interface ConversationRow {
  id: string;
  person_id: string;
  title: string;
  pathname: string;
  created_at: string;
  updated_at: string;
}

function dialogTitle(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.length > 42 ? `${compact.slice(0, 42)}…` : compact || '新会话';
}

function parseProcess(raw: string): StoredProcessBlock[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as StoredProcessBlock[] : [];
  } catch {
    return [];
  }
}

function conversationOr404(db: Db, id: string): ConversationRow {
  const row = db.prepare('SELECT * FROM assistant_conversations WHERE id = ?').get(id) as unknown as ConversationRow | undefined;
  if (!row) throw errors.notFound('会话不存在');
  return row;
}

function canAccessConversation(person: Person, row: ConversationRow): boolean {
  // 聊天记录按账号隔离：管理员也不能读取他人的会话。
  return row.person_id === person.id;
}

function beginConversation(
  db: Db,
  person: Person,
  input: { conversationId?: string; pathname: string; message: string },
): { conversation: ConversationRow; userMessageId: string; assistantMessageId: string } {
  let conversation: ConversationRow | undefined;
  if (input.conversationId) {
    conversation = db.prepare('SELECT * FROM assistant_conversations WHERE id = ?').get(input.conversationId) as unknown as ConversationRow | undefined;
    if (conversation && !canAccessConversation(person, conversation)) throw errors.forbidden('无权写入该会话');
  }
  const now = nowIso();
  if (!conversation) {
    const id = input.conversationId || newId('conv');
    db.prepare(
      'INSERT INTO assistant_conversations (id, person_id, title, pathname, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, person.id, dialogTitle(input.message), input.pathname || '/', now, now);
    conversation = conversationOr404(db, id);
  } else if (conversation.title === '新会话') {
    db.prepare('UPDATE assistant_conversations SET title = ?, updated_at = ? WHERE id = ?').run(dialogTitle(input.message), now, conversation.id);
    conversation = { ...conversation, title: dialogTitle(input.message), updated_at: now };
  }
  const userMessageId = newId('amsg');
  const assistantMessageId = newId('amsg');
  db.prepare('INSERT INTO assistant_messages (id, conversation_id, role, content, process, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userMessageId, conversation.id, 'user', input.message, '[]', now);
  db.prepare('INSERT INTO assistant_messages (id, conversation_id, role, content, process, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(assistantMessageId, conversation.id, 'assistant', '', '[]', now);
  return { conversation, userMessageId, assistantMessageId };
}

function finishAssistantMessage(
  db: Db,
  conversationId: string,
  messageId: string,
  content: string,
  process: StoredProcessBlock[],
): void {
  const now = nowIso();
  db.prepare('UPDATE assistant_messages SET content = ?, process = ? WHERE id = ?')
    .run(content, JSON.stringify(process), messageId);
  db.prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
}

function recordProcessEvent(blocks: StoredProcessBlock[], event: Record<string, unknown>): void {
  const type = String(event.type ?? '');
  if (type === 'thinking' && typeof event.text === 'string' && event.text.trim()) {
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'thinking' && !last.done) last.text = `${last.text ?? ''}${event.text}`;
    else blocks.push({ id: newId('think'), kind: 'thinking', text: event.text, done: false });
    return;
  }
  if (type !== 'tool' && type !== 'tool_call' && type !== 'tool_result') return;
  blocks.forEach((block) => { if (block.kind === 'thinking') block.done = true; });
  const callId = typeof event.callId === 'string' ? event.callId : '';
  const index = callId ? blocks.findIndex((block) => block.kind === 'tool' && block.callId === callId) : -1;
  const isResult = type === 'tool_result';
  if (index >= 0) {
    const block = blocks[index]!;
    if (isResult) {
      block.result = String(event.result ?? event.content ?? '');
      block.status = typeof event.status === 'string' ? event.status : block.status;
      block.done = true;
    } else {
      block.tool = String(event.tool ?? event.title ?? block.tool ?? 'tool');
      block.input = event.input ?? block.input;
      block.status = typeof event.status === 'string' ? event.status : block.status;
    }
    return;
  }
  blocks.push({
    id: callId || newId('tool'),
    kind: 'tool',
    callId,
    tool: String(event.tool ?? event.title ?? 'tool'),
    input: event.input,
    result: isResult ? String(event.result ?? event.content ?? '') : undefined,
    status: typeof event.status === 'string' ? event.status : undefined,
    done: isResult,
  });
}

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
  router.post('/api/assistant/conversations', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(z.object({
      title: z.string().trim().max(120).optional(),
      pathname: z.string().trim().max(500).optional().default('/'),
    }).optional().default({}));
    const id = newId('conv');
    const now = nowIso();
    const title = input.title?.trim() || '新会话';
    rc.app.db.prepare(
      'INSERT INTO assistant_conversations (id, person_id, title, pathname, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, person.id, title, input.pathname || '/', now, now);
    rc.json({
      conversation: {
        id,
        title,
        personId: person.id,
        personName: person.name,
        pathname: input.pathname || '/',
        messageCount: 0,
        preview: '',
        createdAt: now,
        updatedAt: now,
      },
    });
  });

  router.get('/api/assistant/conversations', (rc) => {
    const person = requirePerson(rc);
    const query = rc.query(z.object({
      q: z.string().trim().max(200).optional().default(''),
      limit: z.coerce.number().int().min(1).max(300).optional().default(200),
    }));
    const where = ['c.person_id = ?'];
    const params: (string | number)[] = [person.id];
    if (query.q) {
      where.push('c.title LIKE ?');
      params.push(`%${query.q}%`);
    }
    params.push(query.limit);
    const rows = rc.app.db.prepare(
      `SELECT c.*, p.name AS person_name,
              (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT content FROM assistant_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS preview
         FROM assistant_conversations c
         JOIN persons p ON p.id = c.person_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.updated_at DESC LIMIT ?`,
    ).all(...params) as unknown as (ConversationRow & { person_name: string; message_count: number; preview: string | null })[];
    rc.json({
      conversations: rows.map((row) => ({
        id: row.id,
        title: row.title,
        personId: row.person_id,
        personName: row.person_name,
        pathname: row.pathname,
        messageCount: Number(row.message_count),
        preview: (row.preview ?? '').replace(/\s+/g, ' ').slice(0, 160),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  });

  router.get('/api/assistant/conversations/:id', (rc) => {
    const person = requirePerson(rc);
    const conversation = conversationOr404(rc.app.db, rc.params.id!);
    if (!canAccessConversation(person, conversation)) throw errors.forbidden('无权查看该会话');
    const messages = rc.app.db.prepare(
      `SELECT m.*, p.name AS person_name FROM assistant_messages m
         JOIN assistant_conversations c ON c.id = m.conversation_id
         JOIN persons p ON p.id = c.person_id
        WHERE m.conversation_id = ? ORDER BY m.created_at ASC, m.rowid ASC`,
    ).all(conversation.id) as unknown as { id: string; role: string; content: string; process: string; created_at: string; person_name: string }[];
    rc.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        personId: conversation.person_id,
        personName: messages[0]?.person_name ?? '',
        pathname: conversation.pathname,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
      },
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        process: parseProcess(message.process),
        createdAt: message.created_at,
      })),
    });
  });

  router.patch('/api/assistant/conversations/:id', async (rc) => {
    const person = requirePerson(rc);
    const conversation = conversationOr404(rc.app.db, rc.params.id!);
    if (!canAccessConversation(person, conversation)) throw errors.forbidden('无权修改该会话');
    const input = await rc.body(z.object({ title: z.string().trim().min(1).max(120) }));
    rc.app.db.prepare('UPDATE assistant_conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(input.title, nowIso(), conversation.id);
    rc.json({ ok: true });
  });

  router.delete('/api/assistant/conversations/:id', (rc) => {
    const person = requirePerson(rc);
    const conversation = conversationOr404(rc.app.db, rc.params.id!);
    if (!canAccessConversation(person, conversation)) throw errors.forbidden('无权删除该会话');
    rc.app.db.prepare('DELETE FROM assistant_conversations WHERE id = ?').run(conversation.id);
    rc.json({ ok: true });
  });

  // 助手/客户端读取稳定 API 清单；不从源码推断接口。
  router.get('/api/assistant/manifest', (rc) => {
    requirePerson(rc);
    rc.json(assistantApiManifest());
  });

  router.post('/api/assistant/suggestions', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(z.object({
      pathname: z.string().max(500).optional().default('/'),
      projectId: z.string().max(80).optional(),
      taskId: z.string().max(80).optional(),
      context: z.string().max(2_000).optional(),
    }));
    rc.json(await generateSuggestions(rc.app.db, {
      personName: person.name,
      pathname: input.pathname,
      projectId: input.projectId,
      taskId: input.taskId,
      context: input.context,
    }));
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

    const started = beginConversation(rc.app.db, person, {
      conversationId: input.conversationId,
      pathname: input.pathname || '/',
      message: input.message,
    });
    const processBlocks: StoredProcessBlock[] = [];
    sseWrite(res, 'meta', {
      person: { id: person.id, name: person.name },
      pathname: input.pathname ?? '/',
      conversationId: started.conversation.id,
      userMessageId: started.userMessageId,
      assistantMessageId: started.assistantMessageId,
    });
    void (async () => {
      try {
        const result = await runAssistantTurn({
          personId: person.id,
          personName: person.name,
          message: input.message,
          pathname: input.pathname || '/',
          projectId: input.projectId,
          taskId: input.taskId,
          workspace: projectWorkspaceFor(input.projectId),
          conversationId: started.conversation.id,
          token,
          apiBase:
            process.env.HIVE_API_BASE ||
            `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`,
          signal: controller.signal,
          onEvent: (event) => {
            recordProcessEvent(processBlocks, event);
            queue.push({ kind: 'event', event });
          },
        });
        const reply = result.reply || '已完成。';
        finishAssistantMessage(rc.app.db, started.conversation.id, started.assistantMessageId, reply, processBlocks.map((block) => ({ ...block, done: true })));
        queue.push({ kind: 'done', result });
      } catch (error: unknown) {
        const message = error instanceof Error && error.message ? error.message : '助手运行失败';
        finishAssistantMessage(rc.app.db, started.conversation.id, started.assistantMessageId, message, processBlocks.map((block) => ({ ...block, done: true })));
        queue.push({ kind: 'error', error });
      }
    })();

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
            conversationId: started.conversation.id,
            userMessageId: started.userMessageId,
            assistantMessageId: started.assistantMessageId,
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

    const started = beginConversation(rc.app.db, person, {
      conversationId: input.conversationId,
      pathname: input.pathname || '/',
      message: input.message,
    });
    const processBlocks: StoredProcessBlock[] = [];
    try {
      const result = await runAssistantTurn({
        personId: person.id,
        personName: person.name,
        message: input.message,
        pathname: input.pathname || '/',
        projectId: input.projectId,
        taskId: input.taskId,
        workspace: projectWorkspaceFor(input.projectId),
        conversationId: started.conversation.id,
        token,
        apiBase:
          process.env.HIVE_API_BASE ||
          `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`,
        onEvent: (event) => recordProcessEvent(processBlocks, event),
      });
      finishAssistantMessage(rc.app.db, started.conversation.id, started.assistantMessageId, result.reply || '已完成。', processBlocks.map((block) => ({ ...block, done: true })));
      rc.json({ ...result, conversationId: started.conversation.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishAssistantMessage(rc.app.db, started.conversation.id, started.assistantMessageId, message, processBlocks.map((block) => ({ ...block, done: true })));
      throw errors.serviceUnavailable(`DSH 助手暂不可用：${message}`);
    }
  });
}
