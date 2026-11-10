import type { Router } from '../router.ts';
import { requirePerson, requireProject } from '../auth.ts';
import { errors as httpErrors } from '../respond.ts';
import {
  getProjectBot,
  pollProjectBotRegistration,
  removeProjectBot,
  startProjectBotRegistration,
} from '../../wecom/project-bots.ts';

/** 项目企业微信机器人：扫码注册、状态查询与解绑。 */
export function registerWecomBotRoutes(router: Router): void {
  router.get('/api/projects/:id/wecom-bot', (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    rc.json({ bot: getProjectBot(project.id) });
  });

  router.post('/api/projects/:id/wecom-bot/register/start', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const person = requirePerson(rc);
    try {
      rc.json(await startProjectBotRegistration(project.id, person.id));
    } catch (error) {
      throw httpErrors.badRequest(error instanceof Error ? error.message : '无法生成企业微信机器人二维码');
    }
  });

  router.get('/api/projects/:id/wecom-bot/register/:attemptId', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    try {
      rc.json(await pollProjectBotRegistration(project.id, rc.params.attemptId));
    } catch (error) {
      throw httpErrors.badRequest(error instanceof Error ? error.message : '企业微信机器人扫码状态读取失败');
    }
  });

  router.delete('/api/projects/:id/wecom-bot', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    await removeProjectBot(project.id);
    rc.json({ ok: true });
  });
}
