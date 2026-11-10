import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
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
  agentType: z.enum(['dsh', 'claude']).optional().default('dsh'),
  kind: z.enum(['local', 'remote']).optional(),
  host: z.string().trim().max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  agentType: z.enum(['dsh', 'claude']).optional(),
  kind: z.enum(['local', 'remote']).optional(),
  host: z.string().trim().max(200).optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  status: z.enum(['unconfigured', 'online', 'offline', 'error']).optional(),
});

function instanceWith(db: import('../../db/index.ts').Db, id: string): DshInstance {
  const row = getInstanceRow(db, id);
  if (!row) throw errors.notFound('智能体不存在');
  return buildInstance(db, row);
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.env', '.csv', '.tsv',
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.css', '.scss', '.html', '.xml', '.svg', '.sql',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.sh', '.zsh', '.fish',
  '.gitignore', '.gitattributes', '.lock', '.log', '.diff', '.patch',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function workspaceRootFor(row: import('./identity-helpers.ts').InstanceRow): string {
  return row.workspace_root || join(homedir(), '.aiwo', 'workspaces');
}

function safeWorkspacePath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath || '.');
  const base = resolve(root);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw errors.badRequest('路径超出项目工作区');
  }
  // 防止工作区内的符号链接指向目录外。
  if (existsSync(base) && existsSync(target)) {
    const realBase = realpathSync(base);
    const realTarget = realpathSync(target);
    if (realTarget !== realBase && !realTarget.startsWith(`${realBase}${sep}`)) {
      throw errors.badRequest('路径通过符号链接超出项目工作区');
    }
  }
  return target;
}

function projectWorkspaceForService(
  db: import('../../db/index.ts').Db,
  projectId: string,
  serviceId: string,
): { row: import('./identity-helpers.ts').InstanceRow; root: string; workspace: string } {
  const row = getInstanceRow(db, serviceId);
  if (!row) throw errors.notFound('智能体不存在');
  const linked = db.prepare('SELECT 1 FROM instance_projects WHERE instance_id = ? AND project_id = ?').get(serviceId, projectId);
  if (!linked) throw errors.badRequest('该 智能体未绑定到当前项目');
  const root = workspaceRootFor(row);
  const safeProject = projectId.replace(/[^A-Za-z0-9._-]/g, '_');
  return { row, root, workspace: join(root, 'projects', safeProject) };
}

function directoryEntries(root: string, workspace: string, relativePath: string) {
  const target = safeWorkspacePath(workspace, relativePath);
  if (!existsSync(target)) return { exists: false, entries: [] };
  const stat = statSync(target);
  if (!stat.isDirectory()) throw errors.badRequest('路径不是目录');
  const entries = readdirSync(target, { withFileTypes: true })
    .slice(0, 500)
    .map((entry) => {
      const absolute = join(target, entry.name);
      let size = 0;
      let mtime = '';
      try {
        const info = statSync(absolute);
        size = info.size;
        mtime = info.mtime.toISOString();
      } catch {
        /* 忽略不可读条目 */
      }
      return {
        name: entry.name,
        path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
        type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file',
        size,
        mtime,
      };
    })
    .sort((a, b) => (a.type === 'dir' ? -1 : 0) - (b.type === 'dir' ? -1 : 0) || a.name.localeCompare(b.name, 'zh-CN'));
  return { exists: true, entries };
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
      if (!service) throw errors.badRequest(`智能体不存在或已吊销：${serviceId}`);
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
         (id, name, agent_type, kind, host, port, base_url, workspace_path, version, plugin_version, capabilities,
          token_hash, token_prefix, status, registered_at, last_seen_at, revoked_at, created_by, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?, ?, 'unconfigured', ?, NULL, NULL, ?, ?, ?, '{}')`,
    ).run(
      id,
      input.name,
      input.agentType ?? 'dsh',
      kind,
      input.host ?? '',
      input.port ?? null,
      input.baseUrl ?? null,
      '',
      JSON.stringify(input.capabilities ?? []),
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
    if (!row) throw errors.notFound('智能体不存在');
    const input = await rc.body(updateSchema);
    const now = nowIso();
    rc.app.db.prepare(
      `UPDATE dsh_instances
          SET name = ?, agent_type = ?, kind = ?, host = ?, port = ?, base_url = ?, capabilities = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.name ?? row.name,
      input.agentType ?? row.agent_type,
      input.kind ?? row.kind,
      input.host ?? row.host,
      input.port === undefined ? row.port : input.port,
      input.baseUrl === undefined ? row.base_url : input.baseUrl,
      input.capabilities === undefined ? row.capabilities : JSON.stringify(input.capabilities),
      input.status ?? row.status,
      now,
      row.id,
    );
    rc.json(instanceWith(rc.app.db, row.id));
  });

  router.post('/api/instances/:id/token', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('智能体不存在');
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

  // 本机智能体：由 Ryan 直接启动本地智能体代理（轮换 token 后以环境变量注入）。
  router.post('/api/instances/:id/start', async (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('智能体不存在');
    if (row.kind !== 'local') throw errors.badRequest('仅本机智能体支持服务端自动启动；远端请复制安装命令执行');
    if (computeInstanceStatus(row) === 'online') throw errors.conflict('智能体已在线，无需重复启动');

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
          AIWO_WORKSPACE_ROOT: workspace,
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
      throw errors.internal(`启动本机智能体代理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    closeSync(logFd);

    // 给代理留出注册窗口；即使未完成，UI 也会在 15s 自动刷新。
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
    const updated = getInstanceRow(rc.app.db, row.id);
    rc.json({ started: true, pid: child.pid, logPath, instance: updated ? buildInstance(rc.app.db, updated) : null });
  });

  router.post('/api/instances/:id/restore', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('智能体不存在');
    if (!row.revoked_at) throw errors.conflict('智能体未被删除');
    const token = `aiwo_ins_${randomToken(32)}`;
    rc.app.db.prepare(
      "UPDATE dsh_instances SET revoked_at = NULL, status = 'unconfigured', token_hash = ?, token_prefix = ?, last_seen_at = NULL, updated_at = ? WHERE id = ?",
    ).run(sha256(token), token.slice(0, 18), nowIso(), row.id);
    const base = process.env.AIWO_PUBLIC_BASE_URL || `http://${rc.app.env.host === '0.0.0.0' ? '127.0.0.1' : rc.app.env.host}:${rc.app.env.port}`;
    rc.json({
      instance: instanceWith(rc.app.db, row.id),
      token,
      command: installCommand(base, token),
    });
  });

  router.post('/api/instances/:id/test', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('智能体不存在');
    const status = computeInstanceStatus(row);
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    rc.json({
      ok: status === 'online',
      status,
      latencyMs: lastSeen ? Date.now() - lastSeen : null,
      pluginVersion: row.plugin_version,
      message: status === 'online' ? '智能体在线，插件心跳正常' : row.status === 'unconfigured' ? '尚未安装/连接插件' : '智能体离线',
    });
  });

  router.get('/api/projects/:id/services/:serviceId/workspace', (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id!, 'view');
    const query = rc.query(z.object({ path: z.string().trim().max(1_000).optional().default('') }));
    const target = projectWorkspaceForService(rc.app.db, project.id, rc.params.serviceId!);
    const response = {
      projectId: project.id,
      serviceId: target.row.id,
      serviceName: target.row.name,
      serviceKind: target.row.kind,
      available: target.row.kind === 'local',
      workspaceRoot: target.workspace,
      path: query.path,
      reason: target.row.kind === 'local' ? undefined : '该智能体是远端智能体，工作区位于智能体所在机器；当前仅支持本机智能体在线浏览。',
      ...directoryEntries(target.root, target.workspace, query.path),
    };
    rc.json(response);
  });

  router.get('/api/projects/:id/services/:serviceId/file', (rc) => {
    requirePerson(rc);
    const project = requireProject(rc, rc.params.id!, 'view');
    const query = rc.query(z.object({ path: z.string().trim().min(1).max(1_000) }));
    const target = projectWorkspaceForService(rc.app.db, project.id, rc.params.serviceId!);
    if (target.row.kind !== 'local') throw errors.badRequest('远端智能体暂不支持在线预览文件');
    const absolute = safeWorkspacePath(target.workspace, query.path);
    if (!existsSync(absolute)) throw errors.notFound('文件不存在');
    const stat = statSync(absolute);
    if (stat.isDirectory()) throw errors.badRequest('路径是目录');
    const ext = extname(absolute).toLowerCase();
    const result = {
      path: query.path,
      name: absolute.split(sep).pop() ?? query.path,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      binary: false,
      truncated: false,
      content: '',
      dataUrl: undefined as string | undefined,
    };
    if (IMAGE_EXTENSIONS.has(ext) && stat.size <= 5_000_000) {
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
      result.dataUrl = `data:${mime};base64,${readFileSync(absolute).toString('base64')}`;
      rc.json(result);
      return;
    }
    if (!TEXT_EXTENSIONS.has(ext) && ext !== '') {
      result.binary = true;
      rc.json(result);
      return;
    }
    const raw = readFileSync(absolute);
    const slice = raw.subarray(0, 256_000);
    if (slice.includes(0)) {
      result.binary = true;
      rc.json(result);
      return;
    }
    result.content = slice.toString('utf8');
    result.truncated = raw.length > slice.length;
    rc.json(result);
  });

  router.delete('/api/instances/:id', (rc) => {
    requireAdmin(rc);
    const row = getInstanceRow(rc.app.db, rc.params.id);
    if (!row) throw errors.notFound('智能体不存在');
    rc.app.db.prepare("UPDATE dsh_instances SET revoked_at = ?, status = 'revoked', updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), row.id);
    rc.json({ ok: true });
  });
}
