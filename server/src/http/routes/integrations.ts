/**
 * 入站 Webhook（公开，验签）：GitHub / GitLab。
 *
 * 关键点：
 * - HMAC / 共享令牌必须基于「原始 body」，因此自行读流（上限 1MB），不用 rc.body；
 * - 事件匹配 triggerConfig.events（含 `*`）；验签用 crypto.timingSafeEqual；
 * - 重复 delivery 返回 duplicate；验收通过后建 source=webhook 任务（dedupe_key=provider:delivery）；
 * - 响应中绝不回显 secret。
 */
import type { IncomingMessage } from 'node:http';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { headerOf } from '../context.ts';
import { errors } from '../respond.ts';
import { getProjectRow } from '../../lib/access.ts';
import { tx } from '../../db/index.ts';
import { newId } from '../../lib/ids.ts';
import { renderTemplate } from '../../runtime/template.ts';
import { verifyGithubSignature, verifyGitlabToken } from '../../runtime/signature.ts';
import { parseTriggerConfig, type AutomationRow } from './automations.ts';
import { createTaskRecord, parseStringArray, truncateSummary } from './tasks.ts';

type Provider = 'github' | 'gitlab';

interface NormalizedWebhook {
  provider: Provider;
  /** 归一化后的事件名（用于 triggerConfig.events 匹配） */
  event: string;
  title: string;
  url: string;
  actor: string;
  branch: string;
  deliveryId: string;
  metadata: Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 标题压缩为单行（提交信息可能是多行）。 */
function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 自行读取原始请求体；超过上限抛 413（继续消费请求体，保证能返回结构化错误）。 */
function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      if (tooLarge) {
        reject(errors.payloadTooLarge());
        return;
      }
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parsePayload(raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw errors.invalidJson();
  }
  const object = asObject(parsed);
  if (!object) throw errors.badRequest('Webhook 负载必须是 JSON 对象');
  return object;
}

/** GitLab 的 `x-gitlab-event` 头 → 归一化事件名。 */
function mapGitlabEvent(header: string): string {
  const value = header.trim().toLowerCase();
  if (!value) return '';
  if (value.includes('merge request')) return 'merge_request';
  if (value.includes('tag push')) return 'push';
  if (value.includes('push')) return 'push';
  if (value.includes('issue')) return 'issue';
  if (value.includes('note')) return 'note';
  const cleaned = value.replace(/\s*hook$/, '').trim();
  return cleaned.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeGithub(rc: RequestContext, payload: Record<string, unknown>): NormalizedWebhook {
  const event = headerOf(rc.req, 'x-github-event').trim();
  const deliveryId = headerOf(rc.req, 'x-github-delivery').trim() || newId('dlv');
  const pullRequest = asObject(payload.pull_request);
  const issue = asObject(payload.issue);
  const headCommit = asObject(payload.head_commit);
  const repository = asObject(payload.repository);
  const sender = asObject(payload.sender);

  const title = singleLine(
    str(pullRequest?.title) ?? str(issue?.title) ?? str(headCommit?.message) ?? event,
  );
  const url =
    str(pullRequest?.html_url) ??
    str(issue?.html_url) ??
    str(headCommit?.url) ??
    str(repository?.html_url) ??
    '';
  const actor = str(sender?.login) ?? 'GitHub';
  const branch = str(payload.ref) ?? '';

  return {
    provider: 'github',
    event,
    title,
    url,
    actor,
    branch,
    deliveryId,
    metadata: {
      provider: 'github',
      deliveryId,
      event,
      action: str(payload.action),
      repository: str(repository?.full_name),
      ref: str(payload.ref),
      number: num(pullRequest?.number) ?? num(issue?.number),
    },
  };
}

function normalizeGitlab(rc: RequestContext, payload: Record<string, unknown>): NormalizedWebhook {
  const header = headerOf(rc.req, 'x-gitlab-event').trim();
  const objectKind = str(payload.object_kind);
  const event = mapGitlabEvent(header || objectKind || '');
  const deliveryId = headerOf(rc.req, 'x-gitlab-event-uuid').trim() || newId('dlv');
  const attributes =
    asObject(payload.object_attributes) ??
    asObject(payload.merge_request) ??
    asObject(payload.issue) ??
    {};
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const lastCommit = commits.length > 0 ? asObject(commits[commits.length - 1]) : undefined;
  const project = asObject(payload.project);
  const user = asObject(payload.user);

  const title = singleLine(
    str(attributes.title) ?? str(lastCommit?.message) ?? str(lastCommit?.title) ?? event,
  );
  const url = str(attributes.url) ?? str(project?.web_url) ?? '';
  const actor = str(user?.name) ?? str(payload.user_name) ?? str(payload.user_username) ?? 'GitLab';
  const branch = str(attributes.source_branch) ?? str(payload.ref) ?? '';

  return {
    provider: 'gitlab',
    event,
    title,
    url,
    actor,
    branch,
    deliveryId,
    metadata: {
      provider: 'gitlab',
      deliveryId,
      event,
      objectKind: objectKind,
      repository: str(project?.path_with_namespace) ?? str(project?.name),
      ref: str(payload.ref),
      number: num(attributes.iid),
    },
  };
}

function matchesEvent(configEvents: string[] | undefined, event: string): boolean {
  if (!configEvents || configEvents.length === 0) return false;
  const target = event.toLowerCase();
  return configEvents.some((candidate) => {
    const value = candidate.toLowerCase();
    return value === '*' || value === target;
  });
}

function verifySignature(rc: RequestContext, automation: AutomationRow, raw: Buffer): boolean {
  const config = parseTriggerConfig(automation.trigger_config);
  const secret = config.secret ?? '';
  if (!secret) return false;
  if (automation.trigger_type !== 'webhook') return false;
  if (rc.params.provider === 'github') {
    return verifyGithubSignature(secret, raw, headerOf(rc.req, 'x-hub-signature-256'));
  }
  return verifyGitlabToken(secret, headerOf(rc.req, 'x-gitlab-token'));
}

type Normalizer = (rc: RequestContext, payload: Record<string, unknown>) => NormalizedWebhook;

async function handleInbound(rc: RequestContext, provider: Provider, normalize: Normalizer): Promise<void> {
  const db = rc.app.db;
  rc.params.provider = provider;

  const project = getProjectRow(db, rc.params.projectId);
  if (!project) throw errors.notFound('项目不存在');

  const limit = Math.max(1024, Math.min(rc.app.env.webhookMaxBytes, 1_048_576));
  const raw = await readRawBody(rc.req, limit);
  const payload = parsePayload(raw);
  const normalized = normalize(rc, payload);

  const automations = db
    .prepare(
      `SELECT * FROM automations
        WHERE project_id = ? AND enabled = 1 AND trigger_type = 'webhook'
        ORDER BY created_at ASC`,
    )
    .all(project.id) as unknown as AutomationRow[];

  const candidates = automations.filter((automation) =>
    matchesEvent(parseTriggerConfig(automation.trigger_config).events, normalized.event),
  );
  if (candidates.length === 0) {
    rc.json({ status: 'ignored' }, 202);
    return;
  }

  const verified = candidates.filter((automation) => verifySignature(rc, automation, raw));
  if (verified.length === 0) {
    rc.json({ status: 'rejected' }, 401);
    return;
  }
  const automation = verified[0]!;

  const existing = db
    .prepare('SELECT id, task_id FROM inbound_deliveries WHERE project_id = ? AND provider = ? AND delivery_id = ?')
    .get(project.id, provider, normalized.deliveryId) as unknown as
    | { id: string; task_id: string | null }
    | undefined;
  if (existing) {
    rc.json({ status: 'duplicate' }, 200);
    return;
  }

  const dedupeKey = `${provider}:${normalized.deliveryId}`;
  const duplicateTask = db
    .prepare('SELECT id FROM work_items WHERE project_id = ? AND dedupe_key = ?')
    .get(project.id, dedupeKey) as unknown as { id: string } | undefined;
  if (duplicateTask) {
    rc.json({ status: 'duplicate' }, 200);
    return;
  }

  const prompt = renderTemplate(automation.prompt_template, {
    project: project.name,
    event: normalized.event,
    title: normalized.title,
    url: normalized.url,
    actor: normalized.actor,
    branch: normalized.branch,
  });
  const providerLabel = provider === 'github' ? 'GitHub' : 'GitLab';
  const title = truncated(normalized.title || `${providerLabel} ${normalized.event || 'webhook'}`);

  const deliveryRowId = newId('dlv');
  const now = new Date().toISOString();
  try {
    // 投递记录 + 任务同事务写入：任务创建失败时回滚投递记录，避免「已接受但无任务」。
    const task = tx(db, () => {
      db.prepare(
        `INSERT INTO inbound_deliveries (id, project_id, provider, delivery_id, event, status, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'accepted', NULL, ?)`,
      ).run(deliveryRowId, project.id, provider, normalized.deliveryId, normalized.event, now);
      const created = createTaskRecord(db, rc.app.bus, {
        projectId: project.id,
        source: 'webhook',
        title,
        prompt,
        promptCardIds: parseStringArray(automation.prompt_card_ids),
        instanceId: automation.instance_id,
        priority: 0,
        createdBy: automation.created_by ?? project.owner_person_id ?? null,
        dedupeKey,
        metadata: {
          ...normalized.metadata,
          automationId: automation.id,
          automationName: automation.name,
          url: normalized.url,
          branch: normalized.branch,
          actor: normalized.actor,
        },
        actorName: normalized.actor,
        activitySummary: truncateSummary(`收到 ${providerLabel} ${normalized.event}：${title}`),
        eventMessage: `收到 ${providerLabel} ${normalized.event}：${title}`,
      });
      db.prepare('UPDATE inbound_deliveries SET task_id = ? WHERE id = ?').run(created.id, deliveryRowId);
      return created;
    });
    rc.json({ status: 'accepted', taskId: task.id }, 202);
  } catch (error) {
    // 并发重复投递：唯一约束冲突按 duplicate 处理。
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      rc.json({ status: 'duplicate' }, 200);
      return;
    }
    throw error;
  }
}

function truncated(text: string, limit = 200): string {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export function registerIntegrationRoutes(router: Router): void {
  // GitHub：x-hub-signature-256 HMAC-SHA256
  router.post('/api/integrations/github/:projectId', async (rc) => {
    rc.params.provider = 'github';
    await handleInbound(rc, 'github', normalizeGithub);
  });

  // GitLab：x-gitlab-token 共享令牌
  router.post('/api/integrations/gitlab/:projectId', async (rc) => {
    rc.params.provider = 'gitlab';
    await handleInbound(rc, 'gitlab', normalizeGitlab);
  });
}
