/**
 * 项目级企业微信机器人：通过企业微信二维码注册机器人，并把它接到项目任务。
 * 扫码注册使用企业微信智能机器人二维码服务，不依赖 SSO 的 Corp ID / Secret 配置。
 */
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type { Db } from '../db/index.ts';
import type { EventBus } from '../lib/bus.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { createTaskRecord } from '../http/routes/tasks.ts';
import { canContributeProject, getProjectRow } from '../lib/access.ts';

const QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate';
const QR_POLL_URL = 'https://work.weixin.qq.com/ai/qc/query_result';
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

async function handleText(projectId: string, frame: any): Promise<void> {
  const client = runtimes.get(projectId)?.client;
  if (!client) return;
  const body = frame?.body && typeof frame.body === 'object' ? frame.body : {};
  const content = clean(body.text?.content);
  if (!content) return;
  const senderId = clean(body.from?.userid);
  const chatType = clean(body.chattype) || (body.chatid ? 'group' : 'single');
  const chatId = clean(body.chatid);
  const streamId = generateReqId('stream');
  if (!senderId) {
    await client.replyStream(frame, streamId, '无法识别发送者身份，已拒收该消息。', true).catch(() => undefined);
    return;
  }
  const sender = boundWecomPerson(senderId);
  if (!sender) {
    await client.replyStream(
      frame,
      streamId,
      `企业微信账号「${senderId}」尚未绑定 Ryan 账号，已拒收该消息。请先在 Ryan 账号管理中绑定企业微信后再发送。`,
      true,
    ).catch(() => undefined);
    return;
  }
  const senderName = sender.name;
  try {
    const project = getProjectRow(db(), projectId);
    if (!project) throw new Error('项目不存在');
    if (!canContributeProject(db(), { id: sender.id, isAdmin: sender.isAdmin }, project)) {
      await client.replyStream(frame, streamId, `${senderName} 没有该项目任务权限，已拒收该消息。`, true).catch(() => undefined);
      return;
    }
    const row = botRow(projectId);
    const safeContent = content.replace(/\s+/g, ' ').slice(0, 72);
    const sourceLine = chatType === 'group'
      ? `发送人：${senderName}（${senderId || '未知'}） · 群聊：${chatId || '未知'}`
      : `发送人：${senderName}（${senderId || '未知'}）`;
    const task = createTaskRecord(db(), bus(), {
      projectId,
      title: `企业微信 · ${senderName}：${safeContent}`,
      prompt: `[来自企业微信]\n${sourceLine}\n\n${content}`,
      source: 'api',
      type: 'other',
      createdBy: sender.id,
      metadata: {
        wecomProjectBot: true,
        wecomSenderId: senderId,
        wecomSenderName: senderName,
        wecomChatType: chatType,
        ...(chatId ? { wecomChatId: chatId } : {}),
      },
      activitySummary: `企业微信机器人收到 ${senderName} 的消息并创建任务`,
      eventMessage: `企业微信机器人收到 ${senderName} 的消息`,
    });
    const link = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}` : '';
    await client.replyStream(frame, streamId, `已收到 ${senderName} 的消息，并创建项目任务：${task.title}${link ? `\n${link}` : ''}`, true);
  } catch (error) {
    await client.replyStream(frame, streamId, `处理失败：${error instanceof Error ? error.message : '无法创建任务'}`, true).catch(() => undefined);
  }
}

async function connectBot(row: BotRow): Promise<void> {
  await disconnectBot(row.project_id);
  const client = new WSClient({
    botId: row.remote_bot_id,
    secret: row.secret,
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
