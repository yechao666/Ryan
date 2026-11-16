/**
 * 项目级企业微信机器人：通过企业微信二维码注册机器人，并把它接到项目任务。
 * 扫码注册使用企业微信智能机器人二维码服务，不依赖 SSO 的 Corp ID / Secret 配置。
 */
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type { Db } from '../db/index.ts';
import type { EventBus } from '../lib/bus.ts';
import { newId, nowIso, randomToken, sha256 } from '../lib/ids.ts';
import { createTaskRecord, insertTaskEvent, insertTaskMessage, parseJsonObject } from '../http/routes/tasks.ts';
import { runAssistantTurn } from '../assistant/runner.ts';
import { canContributeProject, getProjectRow } from '../lib/access.ts';
import { recordActivity } from '../lib/activity.ts';

const AI_QR_BASE = (process.env.AIWO_WECOM_AI_BASE || 'https://work.weixin.qq.com').replace(/\/+$/, '');
const QR_GENERATE_URL = `${AI_QR_BASE}/ai/qc/generate`;
const QR_POLL_URL = `${AI_QR_BASE}/ai/qc/query_result`;
const ATTEMPT_TTL_MS = 5 * 60_000;
const ATTEMPT_POLL_MS = 3_000;

interface BotRow {
  id: string;
  project_id: string;
  remote_bot_id: string;
  secret: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  connected_at: string | null;
}

export interface PublicProjectBot {
  id: string;
  projectId: string;
  remoteBotId: string;
  status: string;
  createdAt: string;
  connectedAt?: string;
}

type AttemptStatus = 'pending' | 'waiting' | 'success' | 'expired' | 'failed' | 'cancelled';

interface RegistrationAttempt {
  id: string;
  projectId: string;
  scode: string;
  authUrl: string;
  qrCodeDataUrl: string;
  createdAt: number;
  expiresAt: number;
  pollIntervalMs: number;
  status: AttemptStatus;
  botId?: string;
  error?: string;
  createdBy: string | null;
}

let database: Db | null = null;
let eventBus: EventBus | null = null;
let publicBaseUrl = '';
const attempts = new Map<string, RegistrationAttempt>();
const runtimes = new Map<string, { client: InstanceType<typeof WSClient>; row: BotRow }>();

function db(): Db {
  if (!database) throw new Error('企业微信机器人服务尚未初始化');
  return database;
}

function bus(): EventBus {
  if (!eventBus) throw new Error('企业微信机器人服务尚未初始化');
  return eventBus;
}

function platform(): number {
  if (process.platform === 'win32') return 2;
  if (process.platform === 'linux') return 3;
  return 1;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mask(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function publicProjectBot(row: BotRow): PublicProjectBot {
  return {
    id: row.id,
    projectId: row.project_id,
    remoteBotId: mask(row.remote_bot_id),
    status: row.status,
    createdAt: row.created_at,
    ...(row.connected_at ? { connectedAt: row.connected_at } : {}),
  };
}

function botRow(projectId: string): BotRow | undefined {
  return db().prepare('SELECT * FROM project_wecom_bots WHERE project_id = ?').get(projectId) as unknown as BotRow | undefined;
}

function updateStatus(projectId: string, status: string, connected = false): void {
  const now = nowIso();
  db().prepare('UPDATE project_wecom_bots SET status = ?, updated_at = ?, connected_at = COALESCE(?, connected_at) WHERE project_id = ?')
    .run(status, now, connected ? now : null, projectId);
}

async function requestJson(url: URL): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`企业微信二维码服务返回 HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

function safeAuthUrl(value: unknown): string {
  const raw = clean(value);
  try {
    const url = new URL(raw);
    const mockBase = process.env.AIWO_WECOM_AI_BASE ? new URL(process.env.AIWO_WECOM_AI_BASE) : null;
    if (mockBase) return url.origin === mockBase.origin ? url.toString() : '';
    return url.protocol === 'https:' && url.hostname === 'work.weixin.qq.com' ? url.toString() : '';
  } catch {
    return '';
  }
}

export async function startProjectBotRegistration(projectId: string, createdBy: string | null): Promise<{
  attemptId: string;
  status: AttemptStatus;
  qrCodeDataUrl: string;
  authUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
}> {
  // 同一项目只保留最新一次扫码尝试。
  for (const attempt of attempts.values()) {
    if (attempt.projectId === projectId && !['success', 'expired', 'failed', 'cancelled'].includes(attempt.status)) {
      if (Date.now() > attempt.expiresAt) attempt.status = 'expired';
    }
  }
  const url = new URL(QR_GENERATE_URL);
  url.searchParams.set('source', 'ryan');
  url.searchParams.set('plat', String(platform()));
  const data = await requestJson(url);
  const payload = data.data as Record<string, unknown> | undefined;
  const scode = clean(payload?.scode);
  const authUrl = safeAuthUrl(payload?.auth_url);
  if (!scode || !authUrl) throw new Error('企业微信二维码服务返回数据不完整');
  const qrCodeDataUrl = await QRCode.toDataURL(authUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
  const attempt: RegistrationAttempt = {
    id: randomUUID(),
    projectId,
    scode,
    authUrl,
    qrCodeDataUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + ATTEMPT_TTL_MS,
    pollIntervalMs: ATTEMPT_POLL_MS,
    status: 'pending',
    createdBy,
  };
  attempts.set(attempt.id, attempt);
  return {
    attemptId: attempt.id,
    status: attempt.status,
    qrCodeDataUrl,
    authUrl,
    expiresAt: new Date(attempt.expiresAt).toISOString(),
    pollIntervalMs: attempt.pollIntervalMs,
  };
}

/** 一键连接 Mock 企业微信：向 Mock 申请机器人凭据后走同一套绑定/WS 连接。 */
export async function connectMockProjectBot(projectId: string, createdBy: string | null): Promise<PublicProjectBot> {
  const base = (process.env.AIWO_WECOM_AI_BASE || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 Mock 企业微信地址');
  const response = await fetch(`${base}/api/mock/robots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Ryan 项目机器人 · ${projectId}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json() as { robot?: { botId?: string; secret?: string }; error?: string };
  if (!response.ok || !data.robot?.botId || !data.robot?.secret) throw new Error(data.error ?? 'Mock 企业微信未返回机器人凭据');
  return bindBot(projectId, data.robot.botId, data.robot.secret, createdBy);
}

async function bindBot(projectId: string, remoteBotId: string, secret: string, createdBy: string | null): Promise<PublicProjectBot> {
  const existingById = db().prepare('SELECT * FROM project_wecom_bots WHERE remote_bot_id = ?').get(remoteBotId) as unknown as BotRow | undefined;
  if (existingById && existingById.project_id !== projectId) {
    throw new Error('该企业微信机器人已绑定到其他项目');
  }
  const previous = botRow(projectId);
  if (previous) await disconnectBot(projectId);
  const now = nowIso();
  db().prepare(
    `INSERT INTO project_wecom_bots
       (id, project_id, remote_bot_id, secret, status, created_by, created_at, updated_at, connected_at)
     VALUES (?, ?, ?, ?, 'connecting', ?, ?, ?, NULL)
     ON CONFLICT(project_id) DO UPDATE SET
       remote_bot_id = excluded.remote_bot_id,
       secret = excluded.secret,
       status = 'connecting',
       created_by = excluded.created_by,
       updated_at = excluded.updated_at,
       connected_at = NULL`,
  ).run(previous?.id ?? newId('wbot'), projectId, remoteBotId, secret, createdBy, previous?.created_at ?? now, now);
  const row = botRow(projectId);
  if (!row) throw new Error('机器人保存失败');
  await connectBot(row);
  return publicProjectBot(botRow(projectId) ?? row);
}

export async function pollProjectBotRegistration(projectId: string, attemptId: string): Promise<{
  attemptId: string;
  status: AttemptStatus;
  bot?: PublicProjectBot;
  error?: string;
}> {
  const attempt = attempts.get(attemptId);
  if (!attempt || attempt.projectId !== projectId) throw new Error('扫码尝试不存在或已过期');
  if (['success', 'expired', 'failed', 'cancelled'].includes(attempt.status)) {
    return { attemptId, status: attempt.status, ...(attempt.error ? { error: attempt.error } : {}), ...(attempt.botId ? { bot: botRow(projectId) ? publicProjectBot(botRow(projectId)!) : undefined } : {}) };
  }
  if (Date.now() > attempt.expiresAt) {
    attempt.status = 'expired';
    attempt.error = '二维码已过期，请重新生成';
    return { attemptId, status: attempt.status, error: attempt.error };
  }
  const url = new URL(QR_POLL_URL);
  url.searchParams.set('scode', attempt.scode);
  const data = await requestJson(url);
  const payload = data.data as Record<string, unknown> | undefined;
  const status = clean(payload?.status).toLowerCase();
  if (status === 'success') {
    const info = payload?.bot_info as Record<string, unknown> | undefined;
    const remoteBotId = clean(info?.botid);
    const secret = clean(info?.secret);
    if (!remoteBotId || !secret) throw new Error('企业微信返回的机器人凭据不完整');
    const bot = await bindBot(projectId, remoteBotId, secret, attempt.createdBy);
    attempt.status = 'success';
    attempt.botId = remoteBotId;
    return { attemptId, status: 'success', bot };
  }
  if (['expired', 'timeout'].includes(status)) {
    attempt.status = 'expired';
    attempt.error = '二维码已过期，请重新生成';
    return { attemptId, status: attempt.status, error: attempt.error };
  }
  if (['fail', 'failed', 'error'].includes(status)) {
    attempt.status = 'failed';
    attempt.error = '企业微信扫码绑定失败';
    return { attemptId, status: attempt.status, error: attempt.error };
  }
  attempt.status = 'waiting';
  return { attemptId, status: attempt.status };
}

/**
 * 企业微信帧只带发送人 userid。只有已经绑定 Ryan 账号的 userid 才允许投递消息；
 * 绑定来源为企业微信 SSO 写入的 auth_identities。
 */
function boundWecomPerson(userId: string): { id: string; name: string; isAdmin: boolean } | undefined {
  if (!userId) return undefined;
  const row = db().prepare(
    `SELECT p.id, p.name, p.is_admin
       FROM auth_identities i
       JOIN auth_providers pr ON pr.id = i.provider_id
       JOIN persons p ON p.id = i.person_id
      WHERE pr.type = 'wecom' AND i.subject = ?
      LIMIT 1`,
  ).get(userId) as unknown as { id: string; name: string; is_admin: number } | undefined;
  return row ? { id: row.id, name: row.name, isAdmin: Number(row.is_admin) === 1 } : undefined;
}

interface WecomLinkRow {
  id: string;
  project_id: string;
  bot_id: string;
  chat_id: string;
  chat_type: string;
  person_id: string;
  conversation_id: string;
  task_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

const coordinatorTokens = new Map<string, string>();
let completionSubscribed = false;

function coordinatorToken(personId: string): string {
  const cached = coordinatorTokens.get(personId);
  if (cached) return cached;
  const token = `ryan_s_${randomToken(24)}`;
  db().prepare(
    `INSERT INTO sessions (token_hash, person_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, 'wecom-bot', 'ryan coordinator')`,
  ).run(sha256(token), personId, nowIso(), new Date(Date.now() + 2 * 3_600_000).toISOString());
  coordinatorTokens.set(personId, token);
  return token;
}

function linkFor(projectId: string, botId: string, chatType: string, chatId: string): WecomLinkRow | undefined {
  return db().prepare(
    'SELECT * FROM wecom_chat_links WHERE project_id = ? AND bot_id = ? AND chat_type = ? AND chat_id = ?',
  ).get(projectId, botId, chatType, chatId) as unknown as WecomLinkRow | undefined;
}

function ensureLink(input: {
  projectId: string; botId: string; chatType: string; chatId: string;
  personId: string; senderName: string;
}): WecomLinkRow {
  const existing = linkFor(input.projectId, input.botId, input.chatType, input.chatId);
  if (existing) {
    db().prepare('UPDATE wecom_chat_links SET updated_at = ? WHERE id = ?').run(nowIso(), existing.id);
    return existing;
  }
  const now = nowIso();
  const conversationId = newId('conv');
  const title = input.chatType === 'group'
    ? `企业微信群 · ${input.chatId.slice(-8)}`
    : `企业微信 · ${input.senderName}`;
  db().prepare(
    'INSERT INTO assistant_conversations (id, person_id, title, pathname, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(conversationId, input.personId, title, `/projects/${input.projectId}/wecom-bot`, now, now);
  const id = newId('wcl');
  db().prepare(
    `INSERT INTO wecom_chat_links (id, project_id, bot_id, chat_id, chat_type, person_id, conversation_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.projectId, input.botId, input.chatId, input.chatType, input.personId, conversationId, title, now, now);
  return db().prepare('SELECT * FROM wecom_chat_links WHERE id = ?').get(id) as unknown as WecomLinkRow;
}

function insertAssistantMessage(conversationId: string, role: 'user' | 'assistant', content: string): string {
  const id = newId('amsg');
  db().prepare('INSERT INTO assistant_messages (id, conversation_id, role, content, process, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, conversationId, role, content, '[]', nowIso());
  db().prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?').run(nowIso(), conversationId);
  return id;
}

function linkTasksToWecom(projectId: string, senderId: string, since: string, link: WecomLinkRow, senderName: string): string[] {
  const rows = db().prepare(
    'SELECT id, metadata FROM work_items WHERE project_id = ? AND created_by = ? AND created_at >= ? ORDER BY created_at ASC',
  ).all(projectId, senderId, since) as unknown as { id: string; metadata: string }[];
  const linked: string[] = [];
  for (const row of rows) {
    const metadata = {
      ...parseJsonObject(row.metadata),
      wecomProjectBot: true,
      wecomChatId: link.chat_id,
      wecomChatType: link.chat_type,
      wecomBotId: link.bot_id,
      wecomChatLinkId: link.id,
      wecomConversationId: link.conversation_id,
      wecomSenderId: senderId,
      wecomSenderName: senderName,
    };
    db().prepare('UPDATE work_items SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), row.id);
    linked.push(row.id);
  }
  if (linked.length > 0) {
    db().prepare('UPDATE wecom_chat_links SET task_id = ? WHERE id = ?').run(linked[0], link.id);
  }
  return linked;
}

function stripWecomReply(text: string): string {
  return text
    .replace(/```dsh-ui[\s\S]*?```/gi, '')
    .replace(/^HIVE_NAVIGATE:\s*\/\S+\s*$/gim, '')
    .trim();
}

function findLinkedTask(link: WecomLinkRow): { id: string; title: string; status: string; project_id: string; instance_id: string | null; created_by: string | null } | undefined {
  if (!link.task_id) return undefined;
  return db().prepare('SELECT id, title, status, project_id, instance_id, created_by FROM work_items WHERE id = ?')
    .get(link.task_id) as unknown as { id: string; title: string; status: string; project_id: string; instance_id: string | null; created_by: string | null } | undefined;
}

/** 同一企业微信会话继续同一个系统任务对话；done/failed 后自动重新排队。 */
function appendWecomTaskMessage(link: WecomLinkRow, taskId: string, content: string, senderId: string, senderName: string): boolean {
  const task = db().prepare('SELECT id, status, project_id FROM work_items WHERE id = ?').get(taskId) as unknown as { id: string; status: string; project_id: string } | undefined;
  if (!task) return false;
  if (['assigned', 'running', 'waiting_input'].includes(task.status)) return false;
  const now = nowIso();
  insertTaskMessage(db(), {
    taskId,
    role: 'user',
    content,
    authorPersonId: senderId,
    authorName: senderName,
    source: 'wecom',
    createdAt: now,
  });
  if (['done', 'failed', 'cancelled'].includes(task.status)) {
    db().prepare(
      "UPDATE work_items SET status = 'queued', lease_until = NULL, started_at = NULL, finished_at = NULL, result = NULL, error = NULL WHERE id = ?",
    ).run(taskId);
  }
  insertTaskEvent(db(), {
    taskId,
    projectId: task.project_id,
    type: 'task.message',
    message: '收到企业微信继续消息',
    payload: { senderId, source: 'wecom' },
    createdAt: now,
  });
  recordActivity(db(), bus(), {
    projectId: task.project_id,
    type: 'task.message',
    actor: '企业微信',
    summary: '企业微信继续任务对话',
    taskId,
  });
  db().prepare('UPDATE wecom_chat_links SET updated_at = ? WHERE id = ?').run(now, link.id);
  return true;
}

async function notifyWecomTaskCompletion(taskId: string): Promise<void> {
  const task = db().prepare(
    'SELECT id, project_id, title, status, result, error, metadata, created_by FROM work_items WHERE id = ?',
  ).get(taskId) as unknown as { id: string; project_id: string; title: string; status: string; result: string | null; error: string | null; metadata: string; created_by: string | null } | undefined;
  if (!task) return;
  const metadata = parseJsonObject(task.metadata);
  if (metadata.wecomProjectBot !== true || typeof metadata.wecomChatId !== 'string' || !metadata.wecomChatId) return;
  const runtime = runtimes.get(task.project_id);
  if (!runtime) return;
  const chatId = metadata.wecomChatId;
  const ok = task.status === 'done';
  const body = ok ? (task.result ?? '任务已完成') : (task.error ?? '任务执行失败');
  const link = db().prepare('SELECT * FROM wecom_chat_links WHERE id = ? OR conversation_id = ? LIMIT 1').get(
    String(metadata.wecomChatLinkId ?? metadata.wecomConversationId ?? ''),
    String(metadata.wecomConversationId ?? ''),
  ) as unknown as WecomLinkRow | undefined;
  const content = `${ok ? '✅ 任务已完成' : '❌ 任务失败'}\n任务：${task.title}\n${ok ? '结果' : '原因'}：${body.slice(0, 3000)}${publicBaseUrl ? `\n${publicBaseUrl.replace(/\/$/, '')}/projects/${task.project_id}/tasks/${task.id}` : ''}`;
  try {
    await runtime.client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
    if (link) insertAssistantMessage(link.conversation_id, 'assistant', content);
  } catch (error) {
    console.warn('[project-wecom-bot] 任务完成消息发送失败', error);
  }
}

export function listWecomConversations(personId: string, isAdmin: boolean): Record<string, unknown>[] {
  const rows = db().prepare(
    `SELECT l.*, p.name AS project_name,
       (SELECT content FROM assistant_messages m WHERE m.conversation_id = l.conversation_id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
       (SELECT created_at FROM assistant_messages m WHERE m.conversation_id = l.conversation_id ORDER BY m.created_at DESC LIMIT 1) AS last_at
     FROM wecom_chat_links l JOIN projects p ON p.id = l.project_id
     ${isAdmin ? '' : 'WHERE l.person_id = ?'}
     ORDER BY COALESCE(last_at, l.updated_at) DESC`,
  ).all(...(isAdmin ? [] : [personId])) as unknown as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id, projectId: row.project_id, projectName: row.project_name, botId: row.bot_id,
    chatId: row.chat_id, chatType: row.chat_type, title: row.title,
    lastMessage: row.last_message ?? '', lastAt: row.last_at ?? row.updated_at,
    conversationId: row.conversation_id,
  }));
}

export function getWecomConversationMessages(linkId: string, personId: string, isAdmin: boolean): { link: Record<string, unknown>; messages: Record<string, unknown>[] } | null {
  const link = db().prepare('SELECT * FROM wecom_chat_links WHERE id = ?').get(linkId) as unknown as WecomLinkRow | undefined;
  if (!link) return null;
  if (!isAdmin && link.person_id !== personId) return null;
  const messages = db().prepare('SELECT id, role, content, created_at FROM assistant_messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(link.conversation_id) as unknown as Record<string, unknown>[];
  return { link: { ...link, projectId: link.project_id, chatId: link.chat_id, chatType: link.chat_type }, messages };
}

async function handleText(projectId: string, frame: any): Promise<void> {
  const client = runtimes.get(projectId)?.client;
  const row = botRow(projectId);
  if (!client || !row) return;
  const body = frame?.body && typeof frame.body === 'object' ? frame.body : {};
  const content = clean(body.text?.content);
  if (!content) return;
  const senderId = clean(body.from?.userid);
  const chatType = clean(body.chattype) || (body.chatid ? 'group' : 'single');
  const chatId = clean(body.chatid);
  const replyTo = chatId || senderId;
  const streamId = generateReqId('stream');
  if (!senderId) {
    await client.replyStream(frame, streamId, '无法识别发送者身份，已拒收该消息。', true).catch(() => undefined);
    return;
  }
  const sender = boundWecomPerson(senderId);
  if (!sender) {
    await client.replyStream(frame, streamId, `企业微信账号「${senderId}」尚未绑定 Ryan 账号，已拒收该消息。请先在 Ryan 账号管理中绑定企业微信后再发送。`, true).catch(() => undefined);
    return;
  }
  let assistantMessageId = '';
  try {
    const project = getProjectRow(db(), projectId);
    if (!project) throw new Error('项目不存在');
    if (!canContributeProject(db(), { id: sender.id, isAdmin: sender.isAdmin }, project)) {
      await client.replyStream(frame, streamId, `${sender.name} 没有该项目任务权限，已拒收该消息。`, true).catch(() => undefined);
      return;
    }

    const link = ensureLink({
      projectId, botId: row.remote_bot_id, chatType,
      chatId: replyTo, personId: sender.id, senderName: sender.name,
    });
    insertAssistantMessage(link.conversation_id, 'user', content);
    assistantMessageId = insertAssistantMessage(link.conversation_id, 'assistant', '');
    const linkedTask = findLinkedTask(link);
    if (linkedTask) {
      const accepted = appendWecomTaskMessage(link, linkedTask.id, content, sender.id, sender.name);
      const active = ['assigned', 'running', 'waiting_input'].includes(linkedTask.status);
      const replyText = accepted
        ? `已收到，继续任务对话「${linkedTask.title}」。` + (['done', 'failed', 'cancelled'].includes(linkedTask.status) ? '该任务已重新排队执行。' : '')
        : active ? 'Ryan 正在执行该任务，请等待本轮结束后继续。' : '任务状态异常，暂时无法继续。';
      db().prepare('UPDATE assistant_messages SET content = ? WHERE id = ?').run(replyText, assistantMessageId);
      db().prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?').run(nowIso(), link.conversation_id);
      try {
        await client.sendMessage(replyTo, { msgtype: 'markdown', markdown: { content: replyText } });
      } catch {
        await client.replyStream(frame, streamId, replyText, true).catch(() => undefined);
      }
      return;
    }
    const startedAt = nowIso();
    const reply = await runAssistantTurn({
      personId: sender.id,
      personName: sender.name,
      message: content,
      pathname: `/projects/${projectId}/wecom-bot`,
      projectId,
      conversationId: link.conversation_id,
      token: coordinatorToken(sender.id),
      apiBase: publicBaseUrl || process.env.AIWO_PUBLIC_URL || 'http://127.0.0.1:4500',
      mode: 'wecom',
    });
    const text = stripWecomReply(reply.reply) || '已收到。';
    db().prepare('UPDATE assistant_messages SET content = ? WHERE id = ?').run(text, assistantMessageId);
    db().prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?').run(nowIso(), link.conversation_id);
    db().prepare('UPDATE wecom_chat_links SET updated_at = ? WHERE id = ?').run(nowIso(), link.id);
    linkTasksToWecom(projectId, sender.id, startedAt, link, sender.name);
    try {
      await client.sendMessage(replyTo, { msgtype: 'markdown', markdown: { content: text } });
    } catch {
      await client.replyStream(frame, streamId, text, true).catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '处理失败';
    if (assistantMessageId) db().prepare('UPDATE assistant_messages SET content = ? WHERE id = ?').run(`处理失败：${message}`, assistantMessageId);
    await client.replyStream(frame, streamId, `处理失败：${message}`, true).catch(() => undefined);
  }
}

async function connectBot(row: BotRow): Promise<void> {
  await disconnectBot(row.project_id);
  const client = new WSClient({
    botId: row.remote_bot_id,
    secret: row.secret,
    ...(process.env.AIWO_WECOM_AI_WS_URL ? { wsUrl: process.env.AIWO_WECOM_AI_WS_URL } : {}),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => console.warn('[project-wecom-bot]', message),
      error: (message) => console.error('[project-wecom-bot]', message),
    },
  });
  runtimes.set(row.project_id, { client, row });
  client.on('authenticated', () => {
    updateStatus(row.project_id, 'online', true);
  });
  client.on('message.text', (frame: any) => {
    void handleText(row.project_id, frame);
  });
  client.on('event.enter_chat', (frame: any) => {
    const project = db().prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id) as unknown as { name: string } | undefined;
    void client.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: `我是「${project?.name ?? 'Ryan 项目'}」的企业微信机器人。仅已绑定 Ryan 账号的成员可以发送消息并创建任务。` },
    }).catch(() => undefined);
  });
  client.on('error', (error: unknown) => {
    console.warn(`[project-wecom-bot] ${row.project_id} 连接异常`, error);
    updateStatus(row.project_id, 'error');
  });
  client.connect();
}

async function disconnectBot(projectId: string): Promise<void> {
  const current = runtimes.get(projectId);
  if (!current) return;
  runtimes.delete(projectId);
  try {
    current.client.disconnect();
  } catch {
    // 忽略断线异常
  }
}

export async function removeProjectBot(projectId: string): Promise<void> {
  await disconnectBot(projectId);
  db().prepare('DELETE FROM project_wecom_bots WHERE project_id = ?').run(projectId);
  for (const [id, attempt] of attempts) if (attempt.projectId === projectId) attempts.delete(id);
}

export function getProjectBot(projectId: string): PublicProjectBot | null {
  const row = botRow(projectId);
  return row ? publicProjectBot(row) : null;
}

export async function initializeProjectWecomBots(databaseImpl: Db, busImpl: EventBus, baseUrl: string): Promise<void> {
  database = databaseImpl;
  eventBus = busImpl;
  publicBaseUrl = baseUrl;
  if (!completionSubscribed) {
    completionSubscribed = true;
    eventBus.subscribe((event) => {
      if (event.type !== 'task.completed' && event.type !== 'task.failed') return;
      if (!event.taskId) return;
      void notifyWecomTaskCompletion(event.taskId);
    });
  }
  const rows = database.prepare('SELECT * FROM project_wecom_bots').all() as unknown as BotRow[];
  for (const row of rows) {
    try {
      await connectBot(row);
    } catch (error) {
      updateStatus(row.project_id, 'error');
      console.warn(`[project-wecom-bot] 初始化 ${row.project_id} 失败`, error);
    }
  }
}

export async function closeProjectWecomBots(): Promise<void> {
  await Promise.all([...runtimes.keys()].map(disconnectBot));
}
