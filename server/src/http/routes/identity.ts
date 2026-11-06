/**
 * 身份与权限路由：人员 / 团队 / 项目 / 项目成员 / 项目智员 / 智员 / 令牌 / 实例 / 仪表盘。
 *
 * 权限统一走 server/src/lib/access.ts 与 http/auth.ts 的 requirePerson / requireAdmin /
 * requireProject / requireTeam；所有响应形状严格对齐 shared/src/types.ts。
 */
import { z } from 'zod';
import type { Db } from '../../db/index.ts';
import { tx } from '../../db/index.ts';
import type { Router } from '../router.ts';
import type { RequestContext } from '../context.ts';
import { personFromRow } from '../context.ts';
import { requireAdmin, requirePerson, requireProject, requireTeam } from '../auth.ts';
import { errors } from '../respond.ts';
import { newId, nowIso, randomToken, sha256, utcDayStart } from '../../lib/ids.ts';
import { recordActivity } from '../../lib/activity.ts';
import { canManageProject, canViewProject, getProjectRow, teamIdsOf } from '../../lib/access.ts';
import type { ProjectRow } from '../../lib/access.ts';
import type { AgentToken, Person } from '../../../../shared/src/types.ts';
import {
  buildAgent,
  buildProjectAgent,
  buildProjectSummary,
  buildTeam,
  buildTeamMember,
  countRows,
  defaultMemoryAgentId,
  getAgentRow,
  getAgentTokenRow,
  getInstanceRow,
  getPersonRow,
  getProjectAgentRow,
  getTeamRow,
  listAgentBindings,
  listAgentTokens,
  listAgentsForOwner,
  listInstancesForAgent,
  listInstancesForOwner,
  listMyTeams,
  listProjectAgents,
  listTeamsForPerson,
  listVisibleProjects,
  mapActivityRow,
  mapProjectMemberRow,
  mapTeamMemberRow,
  normalizeCapabilities,
  slugify,
  sortProjectsByActivity,
  uniqueSlug,
} from './identity-helpers.ts';
import type {
  ActivityRow,
  AgentRow,
  PersonRow,
  ProjectMemberRow,
  TeamMemberRow,
  TeamRow,
} from './identity-helpers.ts';

// ---------------------------------------------------------------------------
// 输入契约（zod）
// ---------------------------------------------------------------------------

const teamCreateSchema = z.object({
  name: z.string().trim().min(1, '团队名称不能为空').max(120),
  slug: z.string().trim().max(80).optional(),
  description: z.string().max(2000).optional(),
  leadPersonId: z.string().trim().min(1).optional(),
});

const teamUpdateSchema = z.object({
  name: z.string().trim().min(1, '团队名称不能为空').max(120).optional(),
  description: z.string().max(2000).optional(),
  leadPersonId: z.string().trim().min(1).nullable().optional(),
});

const teamMemberSchema = z.object({
  personId: z.string().trim().min(1, '人员 ID 不能为空'),
  role: z.enum(['lead', 'member']),
});

const visibilitySchema = z.enum(['private', 'team', 'public']);
const projectTypeSchema = z.enum(['manual', 'github', 'gitlab', 'local']);
const projectStatusSchema = z.enum(['active', 'archived']);
const projectRoleSchema = z.enum(['owner', 'maintainer', 'developer', 'reporter']);
const agentStatusSchema = z.enum(['active', 'paused', 'retired']);
const projectAgentStatusSchema = z.enum(['active', 'paused']);

const projectCreateSchema = z.object({
  name: z.string().trim().min(1, '项目名称不能为空').max(120),
  slug: z.string().trim().max(80).optional(),
  description: z.string().max(4000).optional(),
  ownerTeamId: z.string().trim().min(1).optional(),
  visibility: visibilitySchema.optional(),
  type: projectTypeSchema.optional(),
  prompt: z.string().max(20_000).optional(),
  repoUrl: z.string().trim().max(500).optional(),
  mnemosProjectId: z.string().trim().max(120).optional(),
  mnemosApiKey: z.string().max(500).optional(),
});

const projectUpdateSchema = z.object({
  name: z.string().trim().min(1, '项目名称不能为空').max(120).optional(),
  description: z.string().max(4000).optional(),
  visibility: visibilitySchema.optional(),
  type: projectTypeSchema.optional(),
  prompt: z.string().max(20_000).optional(),
  repoUrl: z.string().trim().max(500).nullable().optional(),
  ownerTeamId: z.string().trim().min(1).nullable().optional(),
  mnemosProjectId: z.string().trim().max(120).nullable().optional(),
  // 空字符串表示清除密钥；字段缺省表示保持不变。
  mnemosApiKey: z.string().max(500).optional(),
  status: projectStatusSchema.optional(),
});

const projectMemberSchema = z.object({
  personId: z.string().trim().min(1, '人员 ID 不能为空'),
  role: projectRoleSchema,
});

const projectAgentBindSchema = z.object({
  agentId: z.string().trim().min(1, '智员 ID 不能为空'),
  memoryAgentId: z.string().trim().max(160).optional(),
  role: z.string().trim().max(40).optional(),
});

const projectAgentUpdateSchema = z.object({
  status: projectAgentStatusSchema.optional(),
  role: z.string().trim().max(40).optional(),
  memoryAgentId: z.string().trim().min(1).max(160).optional(),
});

const agentCreateSchema = z.object({
  name: z.string().trim().min(1, '智员名称不能为空').max(120),
  role: z.string().trim().max(60).optional(),
  model: z.string().trim().max(120).optional(),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
});

const agentUpdateSchema = z.object({
  name: z.string().trim().min(1, '智员名称不能为空').max(120).optional(),
  role: z.string().trim().max(60).optional(),
  model: z.string().trim().max(120).optional(),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  status: agentStatusSchema.optional(),
});

const agentTokenSchema = z.object({
  label: z.string().trim().min(1, '令牌名称不能为空').max(80),
});

const agentListSchema = z.object({
  scope: z.enum(['mine', 'all']).optional(),
});

const DASHBOARD_ACTIVITY_LIMIT = 20;

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function loadTeamOr404(rc: RequestContext, teamId: string): TeamRow {
  const team = getTeamRow(rc.app.db, teamId);
  if (!team) throw errors.notFound('团队不存在');
  return team;
}

function loadAgentOr404(rc: RequestContext, agentId: string): AgentRow {
  const agent = getAgentRow(rc.app.db, agentId);
  if (!agent) throw errors.notFound('智员不存在');
  return agent;
}

function assertPersonExists(db: Db, personId: string): void {
  if (!getPersonRow(db, personId)) throw errors.notFound('人员不存在');
}

function nullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function upsertTeamMember(db: Db, teamId: string, personId: string, role: 'lead' | 'member'): void {
  const existing = db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND person_id = ?')
    .get(teamId, personId) as unknown as { role: string } | undefined;
  if (existing) {
    db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND person_id = ?').run(role, teamId, personId);
    return;
  }
  db.prepare('INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, ?, ?)').run(
    teamId,
    personId,
    role,
    nowIso(),
  );
}

function upsertProjectMember(db: Db, projectId: string, personId: string, role: string): void {
  const existing = db
    .prepare('SELECT role FROM project_members WHERE project_id = ? AND person_id = ?')
    .get(projectId, personId) as unknown as { role: string } | undefined;
  if (existing) {
    db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND person_id = ?').run(
      role,
      projectId,
      personId,
    );
    return;
  }
  db.prepare('INSERT INTO project_members (project_id, person_id, role, added_at) VALUES (?, ?, ?, ?)').run(
    projectId,
    personId,
    role,
    nowIso(),
  );
}

/** 校验 ownerTeamId 可用：团队存在，且当前人是成员（admin 例外）。 */
function assertTeamSelectable(db: Db, person: Person, teamId: string): void {
  const team = getTeamRow(db, teamId);
  if (!team) throw errors.notFound('团队不存在');
  if (!person.isAdmin && !teamIdsOf(db, person.id).has(team.id)) {
    throw errors.forbidden('只能选择你加入的团队作为项目归属');
  }
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

export function registerIdentityRoutes(router: Router): void {
  // ---- 仪表盘 -------------------------------------------------------------
  router.get('/api/dashboard', (rc) => {
    const person = requirePerson(rc);
    const db = rc.app.db;
    const actor = { id: person.id, isAdmin: person.isAdmin };
    const projects = listVisibleProjects(db, actor);
    const projectIds = projects.map((project) => project.id);

    const counts = { queued: 0, running: 0, waitingInput: 0, doneToday: 0, failedToday: 0 };
    let activity = [] as ReturnType<typeof mapActivityRow>[];
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => '?').join(', ');
      const todayStart = utcDayStart(0).toISOString();
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) AS c,
                  SUM(CASE WHEN finished_at IS NOT NULL AND finished_at >= ? THEN 1 ELSE 0 END) AS finished_today
             FROM work_items
            WHERE project_id IN (${placeholders})
            GROUP BY status`,
        )
        .all(todayStart, ...projectIds) as unknown as {
        status: string;
        c: number | bigint;
        finished_today: number | bigint | null;
      }[];
      for (const row of rows) {
        const total = Number(row.c);
        const finishedToday = Number(row.finished_today ?? 0);
        if (row.status === 'queued') counts.queued = total;
        else if (row.status === 'running') counts.running = total;
        else if (row.status === 'waiting_input') counts.waitingInput = total;
        else if (row.status === 'done') counts.doneToday = finishedToday;
        else if (row.status === 'failed') counts.failedToday = finishedToday;
      }

      // 只返回“我可查看项目”的活动；无项目归属的系统活动保留。
      activity = (
        db
          .prepare(
            `SELECT * FROM activity_events
              WHERE project_id IS NULL OR project_id IN (${placeholders})
              ORDER BY created_at DESC
              LIMIT ${DASHBOARD_ACTIVITY_LIMIT}`,
          )
          .all(...projectIds) as unknown as ActivityRow[]
      ).map(mapActivityRow);
    }

    rc.json({
      person,
      // 仪表盘只展示“我加入/负责的”团队，不因 admin 身份放大。
      teams: listMyTeams(db, person.id),
      projects,
      agents: listAgentsForOwner(db, person.id),
      instances: listInstancesForOwner(db, person.id),
      tasks: counts,
      activity,
    });
  });

  // ---- 人员 ---------------------------------------------------------------
  router.get('/api/persons', (rc) => {
    requirePerson(rc);
    const rows = rc.app.db
      .prepare('SELECT * FROM persons ORDER BY created_at DESC, name ASC')
      .all() as unknown as PersonRow[];
    rc.json(rows.map((row) => personFromRow(row)));
  });

  // ---- 团队 ---------------------------------------------------------------
  router.get('/api/teams', (rc) => {
    const person = requirePerson(rc);
    rc.json(listTeamsForPerson(rc.app.db, person));
  });

  router.get('/api/teams/:id', (rc) => {
    const person = requirePerson(rc);
    const team = loadTeamOr404(rc, rc.params.id!);
    requireTeam(rc, team.id);

    const members = rc.app.db
      .prepare(
        `SELECT tm.team_id, tm.person_id, tm.role, tm.created_at,
                p.name, p.email, p.avatar_color
           FROM team_members tm JOIN persons p ON p.id = tm.person_id
          WHERE tm.team_id = ?
          ORDER BY tm.created_at DESC, p.name ASC`,
      )
      .all(team.id) as unknown as TeamMemberRow[];

    const actor = { id: person.id, isAdmin: person.isAdmin };
    const projectRows = rc.app.db
      .prepare('SELECT * FROM projects WHERE owner_team_id = ? ORDER BY updated_at DESC')
      .all(team.id) as unknown as ProjectRow[];
    const projects = sortProjectsByActivity(
      projectRows
        .filter((row) => canViewProject(rc.app.db, actor, row))
        .map((row) => buildProjectSummary(rc.app.db, row)),
    );

    rc.json({ team: buildTeam(rc.app.db, team), members: members.map(mapTeamMemberRow), projects });
  });

  router.post('/api/teams', async (rc) => {
    requireAdmin(rc);
    const body = await rc.body(teamCreateSchema);
    const db = rc.app.db;
    const leadPersonId = body.leadPersonId ?? null;
    if (leadPersonId) assertPersonExists(db, leadPersonId);

    const id = newId('tm');
    const slug = uniqueSlug(db, 'teams', slugify(body.slug ?? body.name, 'team'));
    const now = nowIso();
    tx(db, () => {
      db.prepare('INSERT INTO teams (id, name, slug, description, lead_person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        body.name,
        slug,
        body.description ?? '',
        leadPersonId,
        now,
      );
      if (leadPersonId) upsertTeamMember(db, id, leadPersonId, 'lead');
    });

    const team = getTeamRow(db, id)!;
    rc.json(buildTeam(db, team), 201);
  });

  router.patch('/api/teams/:id', async (rc) => {
    requirePerson(rc);
    const team = loadTeamOr404(rc, rc.params.id!);
    requireTeam(rc, team.id, true);
    const body = await rc.body(teamUpdateSchema);
    const db = rc.app.db;

    tx(db, () => {
      if (body.name !== undefined) {
        db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(body.name, team.id);
      }
      if (body.description !== undefined) {
        db.prepare('UPDATE teams SET description = ? WHERE id = ?').run(body.description, team.id);
      }
      if (body.leadPersonId !== undefined) {
        if (body.leadPersonId === null) {
          db.prepare('UPDATE teams SET lead_person_id = NULL WHERE id = ?').run(team.id);
        } else {
          assertPersonExists(db, body.leadPersonId);
          db.prepare('UPDATE teams SET lead_person_id = ? WHERE id = ?').run(body.leadPersonId, team.id);
          // 负责人必须同时是团队成员，否则团队管理入口不可用。
          upsertTeamMember(db, team.id, body.leadPersonId, 'lead');
        }
      }
    });

    rc.json(buildTeam(db, getTeamRow(db, team.id)!));
  });

  router.post('/api/teams/:id/members', async (rc) => {
    requirePerson(rc);
    const team = loadTeamOr404(rc, rc.params.id!);
    requireTeam(rc, team.id, true);
    const body = await rc.body(teamMemberSchema);
    const db = rc.app.db;
    assertPersonExists(db, body.personId);

    tx(db, () => {
      upsertTeamMember(db, team.id, body.personId, body.role);
      if (body.role === 'lead') {
        // 契约：设 lead 时同步 teams.lead_person_id。
        db.prepare('UPDATE teams SET lead_person_id = ? WHERE id = ?').run(body.personId, team.id);
      }
    });

    const member = buildTeamMember(db, team.id, body.personId);
    if (!member) throw errors.internal('团队成员写入失败');
    rc.json(member);
  });

  router.delete('/api/teams/:id/members/:personId', (rc) => {
    requirePerson(rc);
    const team = loadTeamOr404(rc, rc.params.id!);
    requireTeam(rc, team.id, true);
    const db = rc.app.db;
    const personId = rc.params.personId!;
    const existing = db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND person_id = ?')
      .get(team.id, personId) as unknown as { role: string } | undefined;
    if (!existing) throw errors.notFound('该人员不是团队成员');

    if (existing.role === 'lead') {
      const leadCount = countRows(
        db,
        "SELECT COUNT(*) AS c FROM team_members WHERE team_id = ? AND role = 'lead'",
        team.id,
      );
      if (leadCount <= 1) {
        throw errors.conflict('团队至少需要一位负责人，无法移除最后一位负责人');
      }
    }

    tx(db, () => {
      db.prepare('DELETE FROM team_members WHERE team_id = ? AND person_id = ?').run(team.id, personId);
      if (team.lead_person_id === personId) {
        const next = db
          .prepare(
            "SELECT person_id FROM team_members WHERE team_id = ? AND role = 'lead' ORDER BY created_at DESC LIMIT 1",
          )
          .get(team.id) as unknown as { person_id: string } | undefined;
        db.prepare('UPDATE teams SET lead_person_id = ? WHERE id = ?').run(next?.person_id ?? null, team.id);
      }
    });

    rc.json({ ok: true });
  });

  // ---- 项目 ---------------------------------------------------------------
  router.get('/api/projects', (rc) => {
    const person = requirePerson(rc);
    rc.json(listVisibleProjects(rc.app.db, { id: person.id, isAdmin: person.isAdmin }));
  });

  router.post('/api/projects', async (rc) => {
    const person = requirePerson(rc);
    const body = await rc.body(projectCreateSchema);
    const db = rc.app.db;

    if (body.ownerTeamId) assertTeamSelectable(db, person, body.ownerTeamId);

    const id = newId('prj');
    const slug = uniqueSlug(db, 'projects', slugify(body.slug ?? body.name, 'project'));
    const visibility = body.visibility ?? (body.ownerTeamId ? 'team' : 'private');
    const type = body.type ?? 'manual';
    const now = nowIso();
    db.prepare(
      `INSERT INTO projects
         (id, slug, name, description, owner_team_id, owner_person_id, visibility, type, prompt, repo_url, status,
          mnemos_project_id, mnemos_api_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(
      id,
      slug,
      body.name,
      body.description ?? '',
      body.ownerTeamId ?? null,
      person.id,
      visibility,
      type,
      body.prompt ?? '',
      nullableText(body.repoUrl),
      nullableText(body.mnemosProjectId),
      nullableText(body.mnemosApiKey),
      now,
      now,
    );

    const project = getProjectRow(db, id)!;
    rc.json(buildProjectSummary(db, project), 201);
  });

  router.get('/api/projects/:id', (rc) => {
    const project = requireProject(rc, rc.params.id!, 'view');
    const db = rc.app.db;
    const members = db
      .prepare(
        `SELECT pm.project_id, pm.person_id, pm.role, pm.added_at,
                p.name, p.email, p.avatar_color
           FROM project_members pm JOIN persons p ON p.id = pm.person_id
          WHERE pm.project_id = ?
          ORDER BY pm.added_at DESC, p.name ASC`,
      )
      .all(project.id) as unknown as ProjectMemberRow[];
    const team = project.owner_team_id ? getTeamRow(db, project.owner_team_id) : null;
    rc.json({
      project: buildProjectSummary(db, project),
      members: members.map(mapProjectMemberRow),
      team: team ? buildTeam(db, team) : undefined,
    });
  });

  router.patch('/api/projects/:id', async (rc) => {
    const person = requirePerson(rc);
    const project = requireProject(rc, rc.params.id!, 'manage');
    const body = await rc.body(projectUpdateSchema);
    const db = rc.app.db;

    if (body.ownerTeamId) assertTeamSelectable(db, person, body.ownerTeamId);

    const updates: string[] = [];
    const params: Array<string | number | null> = [];
    if (body.name !== undefined) {
      updates.push('name = ?');
      params.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description);
    }
    if (body.visibility !== undefined) {
      updates.push('visibility = ?');
      params.push(body.visibility);
    }
    if (body.type !== undefined) {
      updates.push('type = ?');
      params.push(body.type);
    }
    if (body.prompt !== undefined) {
      updates.push('prompt = ?');
      params.push(body.prompt);
    }
    if (body.repoUrl !== undefined) {
      updates.push('repo_url = ?');
      params.push(nullableText(body.repoUrl));
    }
    if (body.ownerTeamId !== undefined) {
      updates.push('owner_team_id = ?');
      params.push(body.ownerTeamId);
    }
    if (body.mnemosProjectId !== undefined) {
      updates.push('mnemos_project_id = ?');
      params.push(nullableText(body.mnemosProjectId));
    }
    if (body.mnemosApiKey !== undefined) {
      // 空字符串 = 清除；非空 = 覆盖；字段缺省 = 不变。
      updates.push('mnemos_api_key = ?');
      params.push(nullableText(body.mnemosApiKey));
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      params.push(body.status);
    }
    updates.push('updated_at = ?');
    params.push(nowIso());
    params.push(project.id);
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    rc.json(buildProjectSummary(db, getProjectRow(db, project.id)!));
  });

  router.delete('/api/projects/:id', (rc) => {
    const person = requirePerson(rc);
    const project = getProjectRow(rc.app.db, rc.params.id!);
    if (!project) throw errors.notFound('项目不存在');
    if (!person.isAdmin && project.owner_person_id !== person.id) {
      throw errors.forbidden('仅项目负责人或组织管理员可以删除项目');
    }
    const running = countRows(
      rc.app.db,
      "SELECT COUNT(*) AS c FROM work_items WHERE project_id = ? AND status = 'running'",
      project.id,
    );
    if (running > 0) {
      throw errors.conflict(`项目仍有 ${running} 个执行中的任务，请先完成或取消后再删除`);
    }
    rc.app.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    rc.json({ ok: true });
  });

  // ---- 项目成员 -----------------------------------------------------------
  router.post('/api/projects/:id/members', async (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id!, 'manage');
    const body = await rc.body(projectMemberSchema);
    const db = rc.app.db;
    assertPersonExists(db, body.personId);
    upsertProjectMember(db, project.id, body.personId, body.role);

    const member = db
      .prepare(
        `SELECT pm.project_id, pm.person_id, pm.role, pm.added_at,
                p.name, p.email, p.avatar_color
           FROM project_members pm JOIN persons p ON p.id = pm.person_id
          WHERE pm.project_id = ? AND pm.person_id = ?`,
      )
      .get(project.id, body.personId) as unknown as ProjectMemberRow | undefined;
    if (!member) throw errors.internal('项目成员写入失败');
    rc.json(mapProjectMemberRow(member));
  });

  router.delete('/api/projects/:id/members/:personId', (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id!, 'manage');
    const personId = rc.params.personId!;
    const existing = rc.app.db
      .prepare('SELECT 1 AS ok FROM project_members WHERE project_id = ? AND person_id = ?')
      .get(project.id, personId) as unknown as { ok: number } | undefined;
    if (!existing) throw errors.notFound('该人员不是项目成员');
    rc.app.db.prepare('DELETE FROM project_members WHERE project_id = ? AND person_id = ?').run(project.id, personId);
    rc.json({ ok: true });
  });

  // ---- 项目智员 -----------------------------------------------------------
  router.get('/api/projects/:id/agents', (rc) => {
    const project = requireProject(rc, rc.params.id!, 'view');
    rc.json(listProjectAgents(rc.app.db, project.id));
  });

  router.post('/api/projects/:id/agents', async (rc) => {
    const person = requirePerson(rc);
    const project = requireProject(rc, rc.params.id!, 'contribute');
    const body = await rc.body(projectAgentBindSchema);
    const db = rc.app.db;
    const agent = loadAgentOr404(rc, body.agentId);

    if (!person.isAdmin && agent.owner_person_id !== person.id) {
      throw errors.forbidden('只能将自己拥有的智员关联到项目');
    }
    if (agent.status !== 'active') {
      throw errors.conflict(`智员当前状态为 ${agent.status}，只有在职（active）的智员可以关联到项目`);
    }

    const sameAgent = db
      .prepare('SELECT 1 AS ok FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(project.id, agent.id) as unknown as { ok: number } | undefined;
    if (sameAgent) throw errors.conflict(`智员「${agent.name}」已关联到该项目`);

    const memoryAgentId =
      body.memoryAgentId && body.memoryAgentId.length > 0
        ? body.memoryAgentId
        : defaultMemoryAgentId(project.slug, agent.id);
    const sameMemory = db
      .prepare('SELECT 1 AS ok FROM project_agents WHERE project_id = ? AND memory_agent_id = ?')
      .get(project.id, memoryAgentId) as unknown as { ok: number } | undefined;
    if (sameMemory) {
      throw errors.conflict(`记忆智员标识「${memoryAgentId}」已被本项目占用，请换一个标识`);
    }

    const id = newId('pba');
    try {
      db.prepare(
        `INSERT INTO project_agents
           (id, project_id, agent_id, memory_agent_id, role, status, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(id, project.id, agent.id, memoryAgentId, body.role ?? 'developer', person.id, nowIso());
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
        throw errors.conflict('该智员或记忆标识已被项目占用，请刷新后重试');
      }
      throw error;
    }

    recordActivity(db, rc.app.bus, {
      projectId: project.id,
      projectName: project.name,
      type: 'agent.bound',
      actor: person.name,
      summary: `关联智员 ${agent.name}`,
      agentId: agent.id,
    });

    // 用最新行回读，保证契约字段与数据库一致。
    const bound = getProjectAgentRow(db, project.id, agent.id);
    if (!bound) throw errors.internal('项目智员关联写入失败');
    rc.json(buildProjectAgent(db, bound));
  });

  router.patch('/api/projects/:id/agents/:agentId', async (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id!, 'manage');
    const body = await rc.body(projectAgentUpdateSchema);
    const db = rc.app.db;
    const binding = getProjectAgentRow(db, project.id, rc.params.agentId!);
    if (!binding) throw errors.notFound('该智员未关联到此项目');

    const updates: string[] = [];
    const params: Array<string | number> = [];
    if (body.status !== undefined) {
      updates.push('status = ?');
      params.push(body.status);
    }
    if (body.role !== undefined) {
      updates.push('role = ?');
      params.push(body.role);
    }
    if (body.memoryAgentId !== undefined) {
      if (body.memoryAgentId !== binding.memory_agent_id) {
        const conflict = db
          .prepare(
            'SELECT 1 AS ok FROM project_agents WHERE project_id = ? AND memory_agent_id = ? AND agent_id <> ?',
          )
          .get(project.id, body.memoryAgentId, binding.agent_id) as unknown as { ok: number } | undefined;
        if (conflict) {
          throw errors.conflict(`记忆智员标识「${body.memoryAgentId}」已被本项目其他智员占用`);
        }
      }
      updates.push('memory_agent_id = ?');
      params.push(body.memoryAgentId);
    }

    if (updates.length > 0) {
      params.push(binding.id);
      db.prepare(`UPDATE project_agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    rc.json(buildProjectAgent(db, getProjectAgentRow(db, project.id, binding.agent_id)!));
  });

  router.delete('/api/projects/:id/agents/:agentId', (rc) => {
    const person = requirePerson(rc);
    const db = rc.app.db;
    const project = getProjectRow(db, rc.params.id!);
    if (!project) throw errors.notFound('项目不存在');
    const binding = getProjectAgentRow(db, project.id, rc.params.agentId!);
    if (!binding) throw errors.notFound('该智员未关联到此项目');
    const agent = getAgentRow(db, binding.agent_id);
    if (!agent) throw errors.notFound('智员不存在');

    const allowed = canManageProject(db, { id: person.id, isAdmin: person.isAdmin }, project) ||
      agent.owner_person_id === person.id;
    if (!allowed) throw errors.forbidden('需要项目管理权限或为该智员所有者');

    const running = countRows(
      db,
      "SELECT COUNT(*) AS c FROM work_items WHERE project_id = ? AND agent_id = ? AND status = 'running'",
      project.id,
      agent.id,
    );
    if (running > 0) {
      throw errors.conflict(`该智员在项目中仍有 ${running} 个执行中的任务，请先完成或取消后再解除关联`);
    }

    db.prepare('DELETE FROM project_agents WHERE id = ?').run(binding.id);
    rc.json({ ok: true });
  });

  // ---- 智员 ---------------------------------------------------------------
  router.get('/api/agents', (rc) => {
    const person = requirePerson(rc);
    const { scope = 'mine' } = rc.query(agentListSchema);
    const ownerPersonId = scope === 'all' && person.isAdmin ? null : person.id;
    rc.json(listAgentsForOwner(rc.app.db, ownerPersonId));
  });

  router.post('/api/agents', async (rc) => {
    const person = requirePerson(rc);
    const body = await rc.body(agentCreateSchema);
    const db = rc.app.db;
    const id = newId('agt');
    const now = nowIso();
    db.prepare(
      `INSERT INTO agents
         (id, owner_person_id, name, role, model, description, capabilities, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      person.id,
      body.name,
      body.role ?? 'assistant',
      body.model ?? 'deepseek-chat',
      body.description ?? '',
      JSON.stringify(normalizeCapabilities(body.capabilities)),
      now,
      now,
    );
    rc.json(buildAgent(db, getAgentRow(db, id)!), 201);
  });

  router.get('/api/agents/:id', (rc) => {
    const person = requirePerson(rc);
    const agent = loadAgentOr404(rc, rc.params.id!);
    if (!person.isAdmin && agent.owner_person_id !== person.id) {
      throw errors.forbidden('无权访问该智员');
    }
    const db = rc.app.db;
    rc.json({
      agent: buildAgent(db, agent),
      projects: listAgentBindings(db, agent.id),
      tokens: listAgentTokens(db, agent.id),
      instances: listInstancesForAgent(db, agent.id),
    });
  });

  router.patch('/api/agents/:id', async (rc) => {
    const person = requirePerson(rc);
    const agent = loadAgentOr404(rc, rc.params.id!);
    if (!person.isAdmin && agent.owner_person_id !== person.id) {
      throw errors.forbidden('无权修改该智员');
    }
    const body = await rc.body(agentUpdateSchema);
    const db = rc.app.db;

    const updates: string[] = [];
    const params: Array<string | number> = [];
    if (body.name !== undefined) {
      updates.push('name = ?');
      params.push(body.name);
    }
    if (body.role !== undefined) {
      updates.push('role = ?');
      params.push(body.role);
    }
    if (body.model !== undefined) {
      updates.push('model = ?');
      params.push(body.model);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description);
    }
    if (body.capabilities !== undefined) {
      updates.push('capabilities = ?');
      params.push(JSON.stringify(normalizeCapabilities(body.capabilities)));
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      params.push(body.status);
    }
    updates.push('updated_at = ?');
    params.push(nowIso());
    params.push(agent.id);
    db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    rc.json(buildAgent(db, getAgentRow(db, agent.id)!));
  });

  router.post('/api/agents/:id/tokens', async (rc) => {
    const person = requirePerson(rc);
    const agent = loadAgentOr404(rc, rc.params.id!);
    if (!person.isAdmin && agent.owner_person_id !== person.id) {
      throw errors.forbidden('无权为该智员创建令牌');
    }
    const body = await rc.body(agentTokenSchema);
    const db = rc.app.db;

    // 明文只在本次响应返回一次；数据库仅保存 sha256 哈希与可展示前缀。
    const secret = `hive_agt_${randomToken(24)}`;
    const prefix = secret.slice(0, 14);
    const id = newId('tok');
    const now = nowIso();
    db.prepare(
      `INSERT INTO agent_tokens (id, agent_id, label, prefix, token_hash, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, agent.id, body.label, prefix, sha256(secret), now);

    const token: AgentToken & { secret: string } = {
      id,
      agentId: agent.id,
      label: body.label,
      prefix,
      createdAt: now,
      secret,
    };
    rc.json(token, 201);
  });

  router.delete('/api/agents/:id/tokens/:tokenId', (rc) => {
    const person = requirePerson(rc);
    const agent = loadAgentOr404(rc, rc.params.id!);
    if (!person.isAdmin && agent.owner_person_id !== person.id) {
      throw errors.forbidden('无权吊销该智员的令牌');
    }
    const token = getAgentTokenRow(rc.app.db, agent.id, rc.params.tokenId!);
    if (!token) throw errors.notFound('令牌不存在或不属于该智员');
    rc.app.db
      .prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
      .run(nowIso(), token.id);
    rc.json({ ok: true });
  });

  // ---- 实例 ---------------------------------------------------------------
  router.get('/api/instances', (rc) => {
    const person = requirePerson(rc);
    rc.json(listInstancesForOwner(rc.app.db, person.isAdmin ? null : person.id));
  });

  router.delete('/api/instances/:id', (rc) => {
    const person = requirePerson(rc);
    const instance = getInstanceRow(rc.app.db, rc.params.id!);
    if (!instance) throw errors.notFound('实例不存在');
    const agent = getAgentRow(rc.app.db, instance.agent_id);
    if (!agent) throw errors.notFound('实例关联的智员不存在');
    if (!person.isAdmin && agent.owner_person_id !== person.id) {
      throw errors.forbidden('仅智员所有者或组织管理员可以吊销实例');
    }
    // 写入 revoked_at 后，实例鉴权会拒绝心跳（authenticateInstance 检查该字段）。
    rc.app.db
      .prepare("UPDATE dsh_instances SET revoked_at = COALESCE(revoked_at, ?), status = 'revoked' WHERE id = ?")
      .run(nowIso(), instance.id);
    rc.json({ ok: true });
  });
}
