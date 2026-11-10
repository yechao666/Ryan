import { z } from 'zod';
import type { Router } from '../router.ts';
import { requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import { listProjectContext, mapContextRow, PROJECT_CONTEXT_CATEGORIES } from '../../projects/context.ts';

const categoryValues = PROJECT_CONTEXT_CATEGORIES.map((item) => item.value) as [string, ...string[]];

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(20_000).optional().default(''),
  category: z.enum(categoryValues).optional().default('other'),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(20_000).optional(),
  category: z.enum(categoryValues).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

/** 项目背景条目：逐条增删改，执行任务时统一注入到项目上下文。 */
export function registerProjectContextRoutes(router: Router): void {
  router.get('/api/projects/:id/context-items', (rc) => {
    const project = requireProject(rc, rc.params.id, 'view');
    rc.json({ items: listProjectContext(rc.app.db, project.id) });
  });

  router.post('/api/projects/:id/context-items', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const person = requirePerson(rc);
    const input = await rc.body(createSchema);
    const max = rc.app.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM project_context_items WHERE project_id = ?')
      .get(project.id) as unknown as { value: number };
    const id = newId('pctx');
    const now = nowIso();
    rc.app.db.prepare(
      `INSERT INTO project_context_items (id, project_id, title, content, category, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, project.id, input.title, input.content, input.category, Number(max.value) + 1, person.id, now, now);
    const row = rc.app.db.prepare('SELECT * FROM project_context_items WHERE id = ?').get(id);
    if (!row) throw errors.internal('项目背景创建后读取失败');
    rc.json(mapContextRow(row as never), 201);
  });

  router.patch('/api/projects/:id/context-items/:itemId', async (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const current = rc.app.db.prepare('SELECT * FROM project_context_items WHERE id = ? AND project_id = ?')
      .get(rc.params.itemId, project.id) as unknown as { id: string } | undefined;
    if (!current) throw errors.notFound('项目背景条目不存在');
    const input = await rc.body(updateSchema);
    const row = mapContextRow(rc.app.db.prepare('SELECT * FROM project_context_items WHERE id = ?').get(rc.params.itemId) as never);
    rc.app.db.prepare(
      `UPDATE project_context_items SET title = ?, content = ?, category = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
    ).run(
      input.title ?? row.title,
      input.content ?? row.content,
      input.category ?? row.category,
      input.sortOrder ?? row.sortOrder,
      nowIso(),
      row.id,
    );
    const updated = rc.app.db.prepare('SELECT * FROM project_context_items WHERE id = ?').get(row.id);
    rc.json(mapContextRow(updated as never));
  });

  router.delete('/api/projects/:id/context-items/:itemId', (rc) => {
    const project = requireProject(rc, rc.params.id, 'manage');
    const result = rc.app.db.prepare('DELETE FROM project_context_items WHERE id = ? AND project_id = ?')
      .run(rc.params.itemId, project.id);
    if (Number(result.changes) === 0) throw errors.notFound('项目背景条目不存在');
    rc.json({ ok: true });
  });
}
