import { z } from 'zod';
import type { Router } from '../router.ts';
import { requirePerson } from '../auth.ts';
import { errors } from '../respond.ts';
import { runAssistantTurn } from '../../assistant/runner.ts';
import { checkUserInput } from '../../security/check.ts';

const chatSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  pathname: z.string().trim().max(500).optional().default('/'),
  projectId: z.string().trim().max(80).optional(),
  taskId: z.string().trim().max(80).optional(),
});

function bearerToken(header: string | undefined): string {
  if (!header) return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export function registerAssistantRoutes(router: Router): void {
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
