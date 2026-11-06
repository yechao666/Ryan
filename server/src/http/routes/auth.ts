import { z } from 'zod';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, APP_VERSION } from '../../../../shared/src/constants.ts';
import type { Person } from '../../../../shared/src/types.ts';
import type { Router } from '../router.ts';
import { createSession, requirePerson } from '../auth.ts';
import { personFromRow } from '../context.ts';
import { errors } from '../respond.ts';
import { verifyPassword } from '../../lib/password.ts';
import { nowIso, sha256 } from '../../lib/ids.ts';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export function registerAuthRoutes(router: Router): void {
  router.post('/api/auth/login', async (rc) => {
    const input = await rc.body(loginSchema);
    const row = rc.app.db.prepare('SELECT * FROM persons WHERE lower(email) = lower(?)').get(input.email) as unknown as
      | {
          id: string;
          email: string;
          name: string;
          title: string | null;
          avatar_color: string;
          is_admin: number;
          created_at: string;
          last_seen_at: string | null;
          password_hash: string;
        }
      | undefined;
    if (!row || !verifyPassword(input.password, row.password_hash)) {
      throw errors.unauthorized('邮箱或密码不正确');
    }
    const person = personFromRow(row);
    const token = createSession(rc.app.db, person.id, rc.app.env.sessionTtlHours, rc);
    rc.json({ token, person });
  });

  router.get('/api/auth/me', (rc) => {
    const person = requirePerson(rc);
    rc.json({ person });
  });

  router.post('/api/auth/logout', (rc) => {
    const header = String(rc.req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
      rc.app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    }
    rc.json({ ok: true });
  });

  router.get('/api/meta', (rc) => {
    rc.json({
      name: 'Aiwo',
      version: APP_VERSION,
      demo: rc.app.env.demoMode,
      demoAccounts: DEMO_ACCOUNTS,
      demoPassword: rc.app.env.demoMode ? DEMO_PASSWORD : undefined,
    });
  });

  router.get('/api/health', (rc) => {
    rc.json({ ok: true, version: APP_VERSION, uptimeMs: Date.now() - Date.parse(rc.app.startedAt), time: nowIso() });
  });
}
