import type { Db } from '../db/index.ts';
import { errors } from './respond.ts';
import type { RequestContext } from './context.ts';
import type { Person } from '../../../shared/src/types.ts';
import { personFromRow } from './context.ts';
import { newId, nowIso, randomToken, sha256 } from '../lib/ids.ts';
import {
  canContributeProject,
  canManageProject,
  canViewProject,
  getProjectRow,
  teamIdsOf,
  type ProjectRow,
} from '../lib/access.ts';

const SESSION_PREFIX = 'hive_sess_';

export function createSession(db: Db, personId: string, ttlHours: number, req: RequestContext): string {
  const token = `${SESSION_PREFIX}${randomToken(24)}`;
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, person_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    sha256(token),
    personId,
    nowIso(),
    expiresAt,
    req.req.socket.remoteAddress ?? null,
    String(req.req.headers['user-agent'] ?? '').slice(0, 200) || null,
  );
  db.prepare('UPDATE persons SET last_seen_at = ? WHERE id = ?').run(nowIso(), personId);
  return token;
}

export function authenticatePerson(rc: RequestContext, required = true): Person | null {
  const header = String(rc.req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    if (required) throw errors.unauthorized();
    return null;
  }
  const row = rc.app.db
    .prepare(
      `SELECT p.* FROM sessions s JOIN persons p ON p.id = s.person_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), nowIso()) as unknown as
    | {
        id: string;
        email: string;
        name: string;
        title: string | null;
        avatar_color: string;
        is_admin: number;
        created_at: string;
        last_seen_at: string | null;
      }
    | undefined;
  if (!row) {
    if (required) throw errors.unauthorized('登录状态已失效，请重新登录');
    return null;
  }
  const person = personFromRow(row);
  rc.person = person;
  return person;
}

export function requirePerson(rc: RequestContext): Person {
  if (rc.person) return rc.person;
  const person = authenticatePerson(rc, true);
  if (!person) throw errors.unauthorized();
  return person;
}

export function requireAdmin(rc: RequestContext): Person {
  const person = requirePerson(rc);
  if (!person.isAdmin) throw errors.forbidden('需要组织管理员权限');
  return person;
}

/** 运行时鉴权：Agent token（注册实例时）或 Instance token（实例运行期）。 */
export function authenticateAgent(rc: RequestContext): { id: string; name: string; ownerPersonId: string } {
  const header = String(rc.req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw errors.unauthorized();
  const row = rc.app.db
    .prepare(
      `SELECT a.id, a.name, a.owner_person_id, a.status, t.id AS token_id
         FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .get(sha256(token)) as unknown as
    | { id: string; name: string; owner_person_id: string; status: string; token_id: string }
    | undefined;
  if (!row) throw errors.unauthorized('Agent 令牌无效或已吊销');
  if (row.status === 'retired') throw errors.forbidden('该智员已离职，令牌不可用');
  rc.app.db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.token_id);
  rc.agent = { id: row.id, name: row.name, ownerPersonId: row.owner_person_id, status: row.status };
  return rc.agent;
}

export function authenticateInstance(rc: RequestContext): { id: string; agentId: string; name: string } {
  const header = String(rc.req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw errors.unauthorized();
  const row = rc.app.db
    .prepare(
      `SELECT i.id, i.agent_id, i.name, i.status, i.revoked_at, a.name AS agent_name, a.owner_person_id
         FROM dsh_instances i JOIN agents a ON a.id = i.agent_id
        WHERE i.token_hash = ?`,
    )
    .get(sha256(token)) as unknown as
    | {
        id: string;
        agent_id: string;
        name: string;
        status: string;
        revoked_at: string | null;
        agent_name: string;
        owner_person_id: string;
      }
    | undefined;
  if (!row || row.revoked_at) throw errors.unauthorized('实例令牌无效或已吊销');
  rc.app.db
    .prepare("UPDATE dsh_instances SET last_seen_at = ?, status = 'online' WHERE id = ?")
    .run(nowIso(), row.id);
  rc.instance = { id: row.id, agentId: row.agent_id, name: row.name, status: 'online' };
  rc.agent = { id: row.agent_id, name: row.agent_name, ownerPersonId: row.owner_person_id, status: 'active' };
  return { id: row.id, agentId: row.agent_id, name: row.name };
}

/** 项目访问：读取 / 贡献 / 管理。 */
export function requireProject(
  rc: RequestContext,
  projectId: string,
  level: 'view' | 'contribute' | 'manage' = 'view',
): ProjectRow {
  const person = requirePerson(rc);
  const project = getProjectRow(rc.app.db, projectId);
  if (!project) throw errors.notFound('项目不存在');
  const actor = { id: person.id, isAdmin: person.isAdmin };
  const allowed =
    level === 'view'
      ? canViewProject(rc.app.db, actor, project)
      : level === 'contribute'
        ? canContributeProject(rc.app.db, actor, project)
        : canManageProject(rc.app.db, actor, project);
  if (!allowed) throw errors.forbidden(level === 'view' ? '无权访问该项目' : '需要项目维护权限');
  return project;
}

export function requireTeam(rc: RequestContext, teamId: string, manage = false): void {
  const person = requirePerson(rc);
  const member = rc.app.db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND person_id = ?')
    .get(teamId, person.id) as unknown as { role: string } | undefined;
  if (!member && !person.isAdmin) throw errors.forbidden('不是该团队成员');
  if (manage && member?.role !== 'lead' && !person.isAdmin) throw errors.forbidden('需要团队负责人权限');
}

export { teamIdsOf };
