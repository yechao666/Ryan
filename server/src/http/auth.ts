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

const SESSION_PREFIX = 'aiwo_sess_';

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
  if (token.startsWith('ryan_ak_')) {
    const keyRow = rc.app.db
      .prepare(
        `SELECT p.*, k.id AS api_key_id FROM api_keys k JOIN persons p ON p.id = k.person_id
          WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
      )
      .get(sha256(token)) as unknown as
      | {
          id: string;
          email: string;
          name: string;
          title: string | null;
          avatar_color: string;
          is_admin: number;
          created_at: string;
          last_seen_at: string | null;
          api_key_id: string;
        }
      | undefined;
    if (keyRow) {
      rc.app.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), keyRow.api_key_id);
      const person = personFromRow(keyRow);
      rc.person = person;
      return person;
    }
    if (required) throw errors.unauthorized('API Key 无效或已被吊销');
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

/** 运行时鉴权：Agent token（注册服务时）或 Instance token（服务运行期）。 */
/** Ryan 服务令牌：只认证服务本身。 */
export function authenticateInstance(rc: RequestContext): { id: string; name: string } {
  const header = String(rc.req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw errors.unauthorized();
  const row = rc.app.db
    .prepare(
      `SELECT id, name, status, revoked_at
         FROM dsh_instances
        WHERE token_hash = ?`,
    )
    .get(sha256(token)) as unknown as
    | { id: string; name: string; status: string; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at) throw errors.unauthorized('服务令牌无效或已吊销');
  rc.app.db
    .prepare("UPDATE dsh_instances SET last_seen_at = ?, status = 'online' WHERE id = ?")
    .run(nowIso(), row.id);
  rc.instance = { id: row.id, name: row.name, status: 'online' };
  return { id: row.id, name: row.name };
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
