/** 企业微信会话：Ryan 与外部企业微信聊天的一一映射。 */
import type { Router } from '../router.ts';
import { requirePerson } from '../auth.ts';
import { errors } from '../respond.ts';
import { getWecomConversationMessages, listWecomConversations } from '../../wecom/project-bots.ts';

export function registerWecomChatRoutes(router: Router): void {
  router.get('/api/wecom/conversations', (rc) => {
    const person = requirePerson(rc);
    rc.json(listWecomConversations(person.id, person.isAdmin));
  });

  router.get('/api/wecom/conversations/:id/messages', (rc) => {
    const person = requirePerson(rc);
    const result = getWecomConversationMessages(rc.params.id, person.id, person.isAdmin);
    if (!result) throw errors.notFound('企业微信会话不存在');
    rc.json(result);
  });
}
