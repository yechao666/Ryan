/**
 * 控制台 SSE 实时流：`GET /api/events?token=<session>&projectId=`
 *
 * - 用会话 token（sha256 查 sessions + persons）鉴权，EventSource 无法自定义 header；
 * - projectId 可选，需要该项目的 view 权限；
 * - 每条活动写 `event: activity\ndata: {LiveEvent JSON}\n\n`，20s 注释心跳；
 * - 请求关闭时退订并清理定时器。
 */
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { personFromRow } from '../context.ts';
import { requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { nowIso, sha256 } from '../../lib/ids.ts';
import type { LiveEvent } from '../../../../shared/src/types.ts';

const HEARTBEAT_MS = 20_000;

interface SessionPersonRow {
  id: string;
  email: string;
  name: string;
  title: string | null;
  avatar_color: string;
  is_admin: number;
  created_at: string;
  last_seen_at: string | null;
}

function authenticateSessionToken(rc: RequestContext, token: string): void {
  if (!token) throw errors.unauthorized();
  const row = rc.app.db
    .prepare(
      `SELECT p.* FROM sessions s JOIN persons p ON p.id = s.person_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), nowIso()) as unknown as SessionPersonRow | undefined;
  if (!row) throw errors.unauthorized('登录状态已失效，请重新登录');
  rc.person = personFromRow(row);
}

export function registerEventRoutes(router: Router): void {
  router.get('/api/events', (rc) => {
    const token = rc.url.searchParams.get('token') ?? '';
    authenticateSessionToken(rc, token);
    const projectId = rc.url.searchParams.get('projectId') || undefined;
    if (projectId) requireProject(rc, projectId, 'view');

    const res = rc.res;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    const write = (chunk: string): void => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch {
        /* 客户端已断开 */
      }
    };

    write(': connected\n\n');

    const unsubscribe = rc.app.bus.subscribe((event: LiveEvent) => {
      if (projectId && event.projectId !== projectId) return;
      write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* noop */
      }
    };

    rc.req.on('close', cleanup);
    rc.req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });
}
