import type { Router } from '../router.ts';
import { requirePerson } from '../auth.ts';
import { listMentionTargets } from '../../mentions.ts';

/** 统一的 @ 提及候选：人员 + 智能体。 */
export function registerMentionRoutes(router: Router): void {
  router.get('/api/mentions', (rc) => {
    requirePerson(rc);
    rc.json({ targets: listMentionTargets(rc.app.db) });
  });
}
