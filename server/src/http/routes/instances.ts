import { z } from 'zod';
import type { Router } from '../router.ts';
import { requireAdmin, requirePerson } from '../auth.ts';
import { errors } from '../respond.ts';
import { newId, nowIso, randomToken, sha256 } from '../../lib/ids.ts';
import { buildInstance, computeInstanceStatus, getInstanceRow } from './identity-helpers.ts';
import type { DshInstance } from '../../../../shared/src/types.ts';

function installCommand(baseUrl: string, token: string): string {
  return `node integrations/aiwo-instance/agent.mjs --base ${baseUrl} --token ${token}`;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['local', 'remote']).optional(),
  host: z.string().trim().max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  workspacePath: z.string().trim().max(500).optional(),
  projectIds: z.array(z.string().min(1)).max(100).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['local', 'remote']).optional(),
  host: z.string().trim().max(200).optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  workspacePath: z.string().trim().max(500).optional(),
  status: z.enum(['unconfigured', 'online', 'offline', 'error']).optional(),
  projectIds: z.array(z.string().min(1)).max(100).optional(),
});

function bindProjects(db: import('../../db/index.ts').Db, instanceId: string, projectIds: string[]): void {
  const current = db.prepare('SELECT project_id FROM instance_projects WHERE instance_id = ?').all(instanceId) as unknown as { project_id: string }[];
  const next = new Set(projectIds);
  for (const row of current) if (!next.has(row.project_id)) db.prepare('DELETE FROM instance_projects WHERE instance_id = ? AND project_id = ?').run(instanceId, row.project_id);
  const now = nowIso();
  for (const projectId of next) {
    db.prepare('INSERT OR IGNORE INTO instance_projects (instance_id, project_id, created_at) VALUES (?, ?, ?)').run(instanceId, projectId, now);
  }
}

function instanceWith(db: import('../../db/index.ts').Db, id: string): DshInstance {
  const row = getInstanceRow(db, id);
  if (!row) throw errors.notFound('实例不存在');
  return buildInstance(db, row);
}

export function registerInstanceRoutes(router: Router): void {
  router.get('/api/instances', (rc) => {
    requirePerson(rc);
    const rows = rc.app.db.prepare('SELECT id FROM dsh_instances ORDER BY created_at DESC').all() as unknown as { id: string }[];
    rc.json(rows.map((row) => instanceWith(rc.app.db, row.id)));
  });

  router.post('/api/instances', async (rc) => {
    const person = requireAdmin(rc);
    const input = await rc.body(createSchema);
    const id = newId('ins');
    const token = `aiwo_ins_${randomToken(32)}`;
    const now = nowIso();
    const kind = input.kind ?? 'remote';
    rc.app.db.prepare(
      `INSERT INTO dsh_instances
         (id, name, kind, host, port, base_url, workspace_path, version, plugin_version,
          token_hash, token_prefix, status, registered_at, last_seen_at, revoked_at, created_by, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?, 'unconfigured', ?, NULL, NULL, ?, ?, ?, '{}')`,
    ).run(
      id,
      input.name,
      kind,
      input.host ?? '',
      input.port ?? null,
      input.baseUrl ?? null,
      input.workspacePath ?? '',
      sha256(token),
      token.slice(0, 18),
      now,
      person.id,
      now,
      now,
    );
    if (input.projectIds?.length) bindProjects(rc.app.db, id, input.projectIds);
    const base = process.env.AIWO_PUBLIC_BASE_URL || `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`;
    rc.json({ instance: instanceWith(rc.app.db, id), token, command: installCommand(base, token) }, 201);
  });

  router.patch('/api/instances/:id', async (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('实例不存在');
    const input = await rc.body(updateSchema);
    const now = nowIso();
    rc.app.db.prepare(
      `UPDATE dsh_instances
          SET name = ?, kind = ?, host = ?, port = ?, base_url = ?, workspace_path = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.name ?? row.name,
      input.kind ?? row.kind,
      input.host ?? row.host,
      input.port === undefined ? row.port : input.port,
      input.baseUrl === undefined ? row.base_url : input.baseUrl,
      input.workspacePath ?? row.workspace_path,
      input.status ?? row.status,
      now,
      row.id,
    );
    if (input.projectIds) bindProjects(rc.app.db, row.id, input.projectIds);
    rc.json(instanceWith(rc.app.db, row.id));
  });

  router.post('/api/instances/:id/token', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('实例不存在');
    const token = `aiwo_ins_${randomToken(32)}`;
    rc.app.db.prepare("UPDATE dsh_instances SET token_hash = ?, token_prefix = ?, status = 'unconfigured', updated_at = ? WHERE id = ?").run(
      sha256(token),
      token.slice(0, 18),
      nowIso(),
      row.id,
    );
    const base = process.env.AIWO_PUBLIC_BASE_URL || `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`;
    rc.json({ token, command: installCommand(base, token) });
  });

  router.post('/api/instances/:id/test', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('实例不存在');
    const status = computeInstanceStatus(row);
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    rc.json({
      ok: status === 'online',
      status,
      latencyMs: lastSeen ? Date.now() - lastSeen : null,
      pluginVersion: row.plugin_version,
      message: status === 'online' ? '实例在线，插件心跳正常' : row.status === 'unconfigured' ? '尚未安装/连接插件' : '实例离线',
    });
  });

  router.delete('/api/instances/:id', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('实例不存在');
    rc.app.db.prepare("UPDATE dsh_instances SET revoked_at = ?, status = 'revoked', updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), row.id);
    rc.json({ ok: true });
  });
}
