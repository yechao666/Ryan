import type { Db } from '../db/index.ts';

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_team_id: string | null;
  owner_person_id: string;
  visibility: string;
  type: string;
  prompt: string;
  repo_url: string | null;
  status: string;
  mnemos_project_id: string | null;
  mnemos_api_key: string | null;
  memory_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Actor {
  id: string;
  isAdmin: boolean;
}

export function getProjectRow(db: Db, projectId: string): ProjectRow | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as unknown as ProjectRow | undefined) ?? null;
}

export function teamIdsOf(db: Db, personId: string): Set<string> {
  const rows = db.prepare('SELECT team_id FROM team_members WHERE person_id = ?').all(personId) as unknown as {
    team_id: string;
  }[];
  return new Set(rows.map((row) => row.team_id));
}

export function isTeamLead(db: Db, teamId: string, personId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM team_members WHERE team_id = ? AND person_id = ? AND role = 'lead'")
    .get(teamId, personId) as unknown as { ok: number } | undefined;
  return Boolean(row);
}

export function projectMemberRole(db: Db, projectId: string, personId: string): string | null {
  const row = db
    .prepare('SELECT role FROM project_members WHERE project_id = ? AND person_id = ?')
    .get(projectId, personId) as unknown as { role: string } | undefined;
  return row?.role ?? null;
}

const CONTRIBUTE_ROLES = new Set(['owner', 'maintainer', 'developer']);
const MANAGE_ROLES = new Set(['owner', 'maintainer']);

/** 查看权限：私有=归属人/显式成员；团队=归属团队成员/显式成员；公开=组织内所有人员。 */
export function canViewProject(db: Db, actor: Actor, project: ProjectRow): boolean {
  if (actor.isAdmin) return true;
  if (project.owner_person_id === actor.id) return true;
  if (projectMemberRole(db, project.id, actor.id)) return true;
  if (project.visibility === 'public') return true;
  if (project.visibility === 'team' && project.owner_team_id && teamIdsOf(db, actor.id).has(project.owner_team_id)) {
    return true;
  }
  return false;
}

/** 贡献权限：负责人/维护者/开发者；归属团队 lead；组织管理员。 */
export function canContributeProject(db: Db, actor: Actor, project: ProjectRow): boolean {
  if (actor.isAdmin) return true;
  if (project.owner_person_id === actor.id) return true;
  const role = projectMemberRole(db, project.id, actor.id);
  if (role && CONTRIBUTE_ROLES.has(role)) return true;
  if (project.owner_team_id && isTeamLead(db, project.owner_team_id, actor.id)) return true;
  return false;
}

/** 管理权限：负责人/维护者；归属团队 lead；组织管理员。 */
export function canManageProject(db: Db, actor: Actor, project: ProjectRow): boolean {
  if (actor.isAdmin) return true;
  if (project.owner_person_id === actor.id) return true;
  const role = projectMemberRole(db, project.id, actor.id);
  if (role && MANAGE_ROLES.has(role)) return true;
  if (project.owner_team_id && isTeamLead(db, project.owner_team_id, actor.id)) return true;
  return false;
}

export function canViewTeam(db: Db, actor: Actor, teamId: string): boolean {
  return actor.isAdmin || teamIdsOf(db, actor.id).has(teamId);
}

export function canManageTeam(db: Db, actor: Actor, teamId: string): boolean {
  return actor.isAdmin || isTeamLead(db, teamId, actor.id);
}
