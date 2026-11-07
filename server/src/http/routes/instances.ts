import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Router } from '../router.ts';
import { requireAdmin, requirePerson, requireProject } from '../auth.ts';
import { errors } from '../respond.ts';
import { newId, nowIso, randomToken, sha256 } from '../../lib/ids.ts';
import { buildInstance, computeInstanceStatus, getInstanceRow } from './identity-helpers.ts';
import type { DshInstance } from '../../../../shared/src/types.ts';

function installCommand(baseUrl: string, token: string): string {
  return [
    `curl -fsSL -H "authorization: Bearer ${token}" "${baseUrl}/api/runtime/instances/agent-package" | tar xz`,
    'cd aiwo-instance && npm install',
    `AIWO_BASE_URL=${baseUrl} AIWO_INSTANCE_TOKEN=${token} node agent.mjs`,
  ].join('\n');
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['local', 'remote']).optional(),
  host: z.string().trim().max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  baseUrl: z.string().trim().max(500).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['local', 'remote']).optional(),
  host: z.string().trim().max(200).optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  status: z.enum(['unconfigured', 'online', 'offline', 'error']).optional(),
});

function instanceWith(db: import('../../db/index.ts').Db, id: string): DshInstance {
  const row = getInstanceRow(db, id);
  if (!row) throw errors.notFound('服务不存在');
  return buildInstance(db, row);
}

export function registerInstanceRoutes(router: Router): void {
  router.get('/api/projects/:id/services', (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id, 'view');
    const rows = rc.app.db
      .prepare(
        `SELECT i.id, i.name FROM instance_projects ip JOIN dsh_instances i ON i.id = ip.instance_id
          WHERE ip.project_id = ? AND i.revoked_at IS NULL ORDER BY i.name ASC`,
      )
      .all(project.id) as unknown as { id: string; name: string }[];
    rc.json({ serviceIds: rows.map((row) => row.id), services: rows });
  });

  router.patch('/api/projects/:id/services', async (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id, 'manage');
    const input = await rc.body(z.object({ serviceIds: z.array(z.string().min(1)).max(100) }));
    const ids = [...new Set(input.serviceIds)];
    for (const serviceId of ids) {
      const service = rc.app.db
        .prepare('SELECT id FROM dsh_instances WHERE id = ? AND revoked_at IS NULL')
        .get(serviceId) as unknown as { id: string } | undefined;
      if (!service) throw errors.badRequest(`DSH 服务不存在或已吊销：${serviceId}`);
    }
    const now = nowIso();
    rc.app.db.prepare('DELETE FROM instance_projects WHERE project_id = ?').run(project.id);
    for (const serviceId of ids) {
      rc.app.db.prepare('INSERT INTO instance_projects (instance_id, project_id, created_at) VALUES (?, ?, ?)').run(serviceId, project.id, now);
    }
    rc.json({ serviceIds: ids });
  });

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
      '',
      sha256(token),
      token.slice(0, 18),
      now,
      person.id,
      now,
      now,
    );
    const base = process.env.AIWO_PUBLIC_BASE_URL || `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`;
    rc.json({ instance: instanceWith(rc.app.db, id), token, command: installCommand(base, token) }, 201);
  });

  router.patch('/api/instances/:id', async (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('服务不存在');
    const input = await rc.body(updateSchema);
    const now = nowIso();
    rc.app.db.prepare(
      `UPDATE dsh_instances
          SET name = ?, kind = ?, host = ?, port = ?, base_url = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.name ?? row.name,
      input.kind ?? row.kind,
      input.host ?? row.host,
      input.port === undefined ? row.port : input.port,
      input.baseUrl === undefined ? row.base_url : input.baseUrl,
      input.status ?? row.status,
      now,
      row.id,
    );
    rc.json(instanceWith(rc.app.db, row.id));
  });

  router.post('/api/instances/:id/token', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('服务不存在');
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

  // 本机服务：由 Aiwo 直接启动本地服务代理（轮换 token 后以环境变量注入）。
  router.post('/api/instances/:id/start', async (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('服务不存在');
    if (row.kind !== 'local') throw errors.badRequest('仅本机服务支持服务端自动启动；远端请复制安装命令执行');
    if (computeInstanceStatus(row) === 'online') throw errors.conflict('服务已在线，无需重复启动');

    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const agentPath = join(repoRoot, 'integrations/aiwo-instance/agent.mjs');
    const workspace = join(repoRoot, '.run', 'workspaces', row.id);
    const token = `aiwo_ins_${randomToken(32)}`;
    const base = process.env.AIWO_PUBLIC_BASE_URL || `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`;
    rc.app.db.prepare(
      "UPDATE dsh_instances SET token_hash = ?, token_prefix = ?, status = 'unconfigured', updated_at = ? WHERE id = ?",
    ).run(sha256(token), token.slice(0, 18), nowIso(), row.id);

    const runDir = join(repoRoot, '.run');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const logPath = join(runDir, `aiwo-instance-${row.id}.log`);
    const logFd = openSync(logPath, 'a');
    let child;
    try {
      child = spawn(process.execPath, [agentPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          AIWO_BASE_URL: base,
          AIWO_INSTANCE_TOKEN: token,
          AIWO_WORKSPACE: workspace,
          AIWO_INSTANCE_NAME: row.name,
          AIWO_INSTANCE_HOST: row.host || '127.0.0.1',
        },
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      child.on('error', () => {});
    } catch (error) {
      closeSync(logFd);
      throw errors.internal(`启动本机服务代理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    closeSync(logFd);

    // 给代理留出注册窗口；即使未完成，UI 也会在 15s 自动刷新。
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
    const updated = getInstanceRow(rc.app.db, row.id);
    rc.json({ started: true, pid: child.pid, logPath, instance: updated ? buildInstance(rc.app.db, updated) : null });
  });

  router.post('/api/instances/:id/test', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('服务不存在');
    const status = computeInstanceStatus(row);
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    rc.json({
      ok: status === 'online',
      status,
      latencyMs: lastSeen ? Date.now() - lastSeen : null,
      pluginVersion: row.plugin_version,
      message: status === 'online' ? '服务在线，插件心跳正常' : row.status === 'unconfigured' ? '尚未安装/连接插件' : '服务离线',
    });
  });

  router.delete('/api/instances/:id', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('服务不存在');
    rc.app.db.prepare("UPDATE dsh_instances SET revoked_at = ?, status = 'revoked', updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), row.id);
    rc.json({ ok: true });
  });
}
