import type { Router } from '../router.ts';
import { requirePerson } from '../auth.ts';
import { errors } from '../respond.ts';

/** 任务通知：完成接力/提醒目标人员的站内通知。 */
export function registerNotificationRoutes(router: Router): void {
  router.get('/api/notifications', (rc) => {
    const person = requirePerson(rc);
    const unreadOnly = rc.url.searchParams.get('unread') === '1';
    const rows = rc.app.db.prepare(
      `SELECT n.*, p.name AS project_name, w.title AS task_title
         FROM task_notifications n
         LEFT JOIN projects p ON p.id = n.project_id
         LEFT JOIN work_items w ON w.id = n.task_id
        WHERE n.person_id = ? ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
        ORDER BY n.created_at DESC
        LIMIT 100`,
    ).all(person.id) as unknown as Array<{
      id: string; task_id: string | null; project_id: string | null; type: string; title: string; body: string;
      read_at: string | null; created_at: string; project_name: string | null; task_title: string | null;
    }>;
    const unread = Number((rc.app.db.prepare('SELECT COUNT(*) AS c FROM task_notifications WHERE person_id = ? AND read_at IS NULL').get(person.id) as unknown as { c: number }).c) || 0;
    rc.json({
      unread,
      notifications: rows.map((row) => ({
        id: row.id,
        taskId: row.task_id ?? undefined,
        projectId: row.project_id ?? undefined,
        projectName: row.project_name ?? undefined,
        taskTitle: row.task_title ?? undefined,
        type: row.type,
        title: row.title,
        body: row.body,
        readAt: row.read_at ?? undefined,
        createdAt: row.created_at,
      })),
    });
  });

  router.post('/api/notifications/:id/read', (rc) => {
    const person = requirePerson(rc);
    const result = rc.app.db.prepare('UPDATE task_notifications SET read_at = ? WHERE id = ? AND person_id = ?')
      .run(new Date().toISOString(), rc.params.id, person.id);
    if (Number(result.changes) === 0) throw errors.notFound('通知不存在');
    rc.json({ ok: true });
  });

  router.post('/api/notifications/read-all', (rc) => {
    const person = requirePerson(rc);
    rc.app.db.prepare('UPDATE task_notifications SET read_at = ? WHERE person_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), person.id);
    rc.json({ ok: true });
  });
}
