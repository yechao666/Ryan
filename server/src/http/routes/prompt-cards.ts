import { z } from 'zod';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { requireAdmin, requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { canManageProject, getProjectRow } from '../../lib/access.ts';
import type { Db } from '../../db/index.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import type { PromptCard, PromptCardCategory, PromptCardScope } from '../../../../shared/src/types.ts';

interface PromptCardRow {
  id: string;
  name: string;
  category: string;
  description: string;
  content: string;
  scope: string;
  project_id: string | null;
  team_id: string | null;
  person_id: string | null;
  enabled: number;
  auto_inject: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  project_name?: string | null;
  team_name?: string | null;
  person_name?: string | null;
  created_by_name?: string | null;
}

interface PersonLike { id: string; isAdmin: boolean }

const SELECT = `
  SELECT c.*, p.name AS project_name, t.name AS team_name, person.name AS person_name, u.name AS created_by_name
    FROM prompt_cards c
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN teams t ON t.id = c.team_id
    LEFT JOIN persons person ON person.id = c.person_id
    LEFT JOIN persons u ON u.id = c.created_by
`;

function rowOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
function rowsOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function mapCard(row: PromptCardRow): PromptCard {
  return {
    id: row.id,
    name: row.name,
    category: row.category as PromptCardCategory,
    description: row.description,
    content: row.content,
    scope: row.scope as PromptCardScope,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    teamId: row.team_id ?? undefined,
    teamName: row.team_name ?? undefined,
    personId: row.person_id ?? undefined,
    personName: row.person_name ?? undefined,
    enabled: Number(row.enabled) === 1,
    autoInject: Number(row.auto_inject) === 1,
    createdBy: row.created_by ?? undefined,
    createdByName: row.created_by_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function teamIds(db: Db, personId: string): Set<string> {
  return new Set((db.prepare('SELECT team_id FROM team_members WHERE person_id = ?').all(personId) as unknown as { team_id: string }[]).map((row) => row.team_id));
}

function canSeeCard(db: Db, person: PersonLike, row: PromptCardRow): boolean {
  if (person.isAdmin || row.created_by === person.id) return true;
  if (row.scope === 'org') return true;
  if (row.scope === 'team') return Boolean(row.team_id && teamIds(db, person.id).has(row.team_id));
  if (row.scope === 'person') return row.person_id === person.id;
  if (row.scope === 'project' && row.project_id) {
    const project = getProjectRow(db, row.project_id);
    return Boolean(project && canManageProject(db, person, project));
  }
  return false;
}

function canEditCard(db: Db, person: PersonLike, row: PromptCardRow): boolean {
  if (person.isAdmin || row.created_by === person.id) return true;
  if (row.scope === 'person') return row.person_id === person.id;
  if (row.scope === 'team' && row.team_id) {
    const lead = rowOf<{ lead_person_id: string | null }>(db, 'SELECT lead_person_id FROM teams WHERE id = ?', [row.team_id]);
    if (lead?.lead_person_id === person.id) return true;
  }
  if (row.scope === 'project' && row.project_id) {
    const project = getProjectRow(db, row.project_id);
    return Boolean(project && canManageProject(db, person, project));
  }
  return false;
}

export function applicableCards(db: Db, projectId: string, personId?: string): PromptCard[] {
  const project = getProjectRow(db, projectId);
  if (!project) return [];
  const rows = rowsOf<PromptCardRow>(
    db,
    `${SELECT}
      WHERE c.enabled = 1 AND (
        c.scope = 'org'
        OR (c.scope = 'team' AND c.team_id = ?)
        OR (c.scope = 'project' AND c.project_id = ?)
        OR (c.scope = 'person' AND c.person_id = ?)
      )
      ORDER BY c.scope ASC, c.updated_at DESC`,
    [project.owner_team_id, project.id, personId ?? ''],
  );
  return rows.map(mapCard);
}

const cardInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(['workflow', 'style', 'standard', 'role', 'other']).optional(),
  description: z.string().max(2000).optional(),
  content: z.string().trim().min(1).max(40_000),
  scope: z.enum(['org', 'team', 'project', 'person']).optional(),
  personId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  autoInject: z.boolean().optional(),
});

const cardPatchSchema = cardInputSchema.partial();

export function registerPromptCardRoutes(router: Router): void {
  router.get('/api/prompt-cards', (rc) => {
    const person = requirePerson(rc);
    const rows = rowsOf<PromptCardRow>(rc.app.db, `${SELECT} ORDER BY c.updated_at DESC LIMIT 500`);
    const visible = rows.filter((row) => canSeeCard(rc.app.db, person, row));
    const projectId = rc.url.searchParams.get('projectId');
    const category = rc.url.searchParams.get('category');
    rc.json(
      visible
        .filter((row) => (projectId ? row.project_id === projectId || row.scope !== 'project' : true))
        .filter((row) => (category ? row.category === category : true))
        .map(mapCard),
    );
  });

  router.get('/api/projects/:id/prompt-cards', (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id, 'view');
    const person = requirePerson(rc);
    rc.json(applicableCards(rc.app.db, project.id, person.id));
  });

  router.post('/api/prompt-cards', async (rc) => {
    const person = requirePerson(rc);
    const input = await rc.body(cardInputSchema);
    const scope = input.scope ?? 'org';
    if (scope === 'org') requireAdmin(rc);
    if (scope === 'team') {
      if (!input.teamId) throw errors.badRequest('团队级提示词需要 teamId');
      const team = rowOf<{ lead_person_id: string | null }>(rc.app.db, 'SELECT lead_person_id FROM teams WHERE id = ?', [input.teamId]);
      if (!team) throw errors.notFound('团队不存在');
      if (!person.isAdmin && team.lead_person_id !== person.id) throw errors.forbidden('只有团队负责人或管理员可以创建团队提示词');
    }
    if (scope === 'project') {
      if (!input.projectId) throw errors.badRequest('项目级提示词需要 projectId');
      requireProject(rc, input.projectId, 'contribute');
    }
    if (scope === 'person') {
      const personId = input.personId ?? person.id;
      if (!person.isAdmin && personId !== person.id) throw errors.forbidden('只能创建自己的个人提示词');
      if (personId !== person.id) {
        const owner = rowOf<{ id: string }>(rc.app.db, 'SELECT id FROM persons WHERE id = ?', [personId]);
        if (!owner) throw errors.notFound('人员不存在');
      }
    }
    if (scope !== 'project' && input.projectId) throw errors.badRequest('非项目级提示词不能指定 projectId');
    if (scope !== 'team' && input.teamId) throw errors.badRequest('非团队级提示词不能指定 teamId');
    if (scope !== 'person' && input.personId) throw errors.badRequest('非人员级提示词不能指定 personId');

    const id = newId('pcard');
    const now = nowIso();
    rc.app.db.prepare(
      `INSERT INTO prompt_cards (id, name, category, description, content, scope, project_id, team_id, person_id, enabled, auto_inject, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.category ?? 'workflow',
      input.description ?? '',
      input.content,
      scope,
      input.projectId ?? null,
      input.teamId ?? null,
      scope === 'person' ? (input.personId ?? person.id) : null,
      input.enabled === false ? 0 : 1,
      input.autoInject ? 1 : 0,
      person.id,
      now,
      now,
    );
    const row = rowOf<PromptCardRow>(rc.app.db, `${SELECT} WHERE c.id = ?`, [id]);
    if (!row) throw errors.internal('提示卡创建后读取失败');
    rc.json(mapCard(row), 201);
  });

  router.patch('/api/prompt-cards/:id', async (rc) => {
    const person = requirePerson(rc);
    const row = rowOf<PromptCardRow>(rc.app.db, `${SELECT} WHERE c.id = ?`, [rc.params.id]);
    if (!row) throw errors.notFound('提示卡不存在');
    if (!canEditCard(rc.app.db, person, row)) throw errors.forbidden('无权修改该提示卡');
    const input = await rc.body(cardPatchSchema);
    const now = nowIso();
    rc.app.db.prepare(
      `UPDATE prompt_cards SET name = ?, category = ?, description = ?, content = ?, enabled = ?, auto_inject = ?, updated_at = ? WHERE id = ?`,
    ).run(
      input.name ?? row.name,
      input.category ?? row.category,
      input.description ?? row.description,
      input.content ?? row.content,
      input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      input.autoInject === undefined ? row.auto_inject : input.autoInject ? 1 : 0,
      now,
      row.id,
    );
    const updated = rowOf<PromptCardRow>(rc.app.db, `${SELECT} WHERE c.id = ?`, [row.id]);
    if (!updated) throw errors.internal('提示卡更新后读取失败');
    rc.json(mapCard(updated));
  });

  router.delete('/api/prompt-cards/:id', (rc) => {
    const person = requirePerson(rc);
    const row = rowOf<PromptCardRow>(rc.app.db, `${SELECT} WHERE c.id = ?`, [rc.params.id]);
    if (!row) throw errors.notFound('提示卡不存在');
    if (!canEditCard(rc.app.db, person, row)) throw errors.forbidden('无权删除该提示卡');
    rc.app.db.prepare('DELETE FROM prompt_cards WHERE id = ?').run(row.id);
    rc.json({ ok: true });
  });
}
