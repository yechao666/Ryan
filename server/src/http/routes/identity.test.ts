/**
 * identity 路由集成测试：临时数据库 + 真实 HTTP 服务。
 *
 * 运行：node --test server/src/http/routes/identity.test.ts
 * 不读写 data/hive.db，测试结束后清理临时目录。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { closeDatabase, migrate, openDatabase, type Db } from '../../db/index.ts';
import { seedDatabase } from '../../seed/seed.ts';
import { EventBus } from '../../lib/bus.ts';
import { loadEnv } from '../../env.ts';
import { sha256 } from '../../lib/ids.ts';
import { Router } from '../router.ts';
import { createHttpServer } from '../server.ts';
import { registerRoutes } from './index.ts';

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
}

let base = '';
let tempDir = '';
let db: Db;
let server: Server | undefined;
let tokenLin = '';
let tokenChen = '';
let tokenZhou = '';
let tokenSu = '';
let teamProjectId = '';
let privateProjectId = '';

async function call(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function ok(result: ApiResult, expected = 200): any {
  assert.equal(result.status, expected, `期望 HTTP ${expected}，实际 ${result.status}：${JSON.stringify(result.body)}`);
  return result.body;
}

function byId(list: Json[], id: string): Json {
  const found = list.find((item) => item.id === id);
  assert.ok(found, `列表中未找到 ${id}`);
  return found;
}

async function login(email: string): Promise<string> {
  const result = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'hive-demo' },
  });
  return ok(result).token as string;
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'hive-identity-'));
  const dbPath = join(tempDir, 'test.db');
  db = openDatabase(dbPath);
  migrate(db);
  seedDatabase(db);

  const environment = loadEnv({ dataDir: tempDir, dbPath, port: 0 });
  const app = { db, env: environment, bus: new EventBus(), startedAt: new Date().toISOString() };
  const router = new Router();
  registerRoutes(router, app);
  server = createHttpServer(app, router);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', '测试服务未能监听端口');
  base = `http://127.0.0.1:${address.port}`;

  tokenLin = await login('lin.wei@hive.dev');
  tokenChen = await login('chen.hao@hive.dev');
  tokenZhou = await login('zhou.ye@hive.dev');
  tokenSu = await login('su.yan@hive.dev');
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server!.closeAllConnections();
    });
  }
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('鉴权与管理员视图：dashboard / persons / teams / projects / agents / instances', async () => {
  const anonymous = await call('/api/persons');
  assert.equal(anonymous.status, 401);

  const dash = ok(await call('/api/dashboard', { token: tokenLin }));
  assert.equal(dash.person.name, '林薇');
  assert.equal(dash.teams.length, 2, '仪表盘只展示我加入/负责的团队');
  assert.equal(dash.projects.length, 5, 'admin 可查看全部项目');
  assert.equal(dash.agents.length, 1, '仪表盘只展示我拥有的智员');
  assert.equal(dash.instances.length, 1, '林薇的 lab 实例已 seed');
  assert.deepEqual(
    { queued: dash.tasks.queued, running: dash.tasks.running, waiting: dash.tasks.waitingInput },
    { queued: 1, running: 1, waiting: 1 },
  );
  assert.equal(dash.activity.length, 5);
  assert.ok(dash.projects.every((project: Json) => typeof project.counts.agents === 'number'));

  const persons = ok(await call('/api/persons', { token: tokenLin }));
  assert.equal(persons.length, 4);
  assert.ok(persons.every((person: Json) => !('passwordHash' in person) && !('password_hash' in person)));

  const teams = ok(await call('/api/teams', { token: tokenLin }));
  assert.equal(teams.length, 3);
  const platform = byId(teams, 'tm_platform');
  assert.equal(platform.memberCount, 3);
  assert.equal(platform.projectCount, 1);
  assert.equal(platform.leadName, '林薇');

  const teamDetail = ok(await call('/api/teams/tm_platform', { token: tokenLin }));
  assert.equal(teamDetail.members.length, 3);
  assert.equal(teamDetail.projects.length, 1);
  assert.equal(teamDetail.projects[0].id, 'prj_aurora');

  const projects = ok(await call('/api/projects', { token: tokenLin }));
  assert.equal(projects.length, 5);
  const atlas = byId(projects, 'prj_atlas');
  assert.equal(atlas.counts.agents, 1);
  assert.equal(atlas.counts.tasks, 1);
  assert.equal(atlas.counts.activeTasks, 0);
  assert.equal(atlas.counts.instances, 1);
  assert.equal(atlas.counts.members, 1);
  assert.ok(atlas.lastActivityAt);

  const orion = ok(await call('/api/projects/prj_orion', { token: tokenLin }));
  assert.equal(orion.members.length, 2);
  assert.equal(orion.team.name, '研发一组');
  assert.equal(orion.project.counts.tasks, 2);
  assert.equal(orion.project.counts.activeTasks, 2);

  const myAgents = ok(await call('/api/agents?scope=mine', { token: tokenLin }));
  assert.equal(myAgents.length, 1);
  assert.equal(myAgents[0].id, 'agt_platform_ops');
  assert.equal(myAgents[0].stats.projects, 1);

  const allAgents = ok(await call('/api/agents?scope=all', { token: tokenLin }));
  assert.equal(allAgents.length, 5);

  const instances = ok(await call('/api/instances', { token: tokenLin }));
  assert.equal(instances.length, 3, 'lab + orion + atlas');
  const online = byId(instances, 'ins_orion_01');
  assert.equal(online.status, 'online');
  assert.equal(online.currentTask.title, '拆分订单查询服务（读写分离）');
  assert.equal(byId(instances, 'ins_atlas_01').status, 'offline');
});

test('陈昊：团队可见性、viewer 403、私有项目不可见', async () => {
  const dash = ok(await call('/api/dashboard', { token: tokenChen }));
  assert.equal(dash.person.name, '陈昊');
  assert.equal(dash.teams.length, 2);
  assert.equal(dash.projects.length, 3);
  assert.equal(dash.agents.length, 1);
  assert.equal(dash.instances.length, 1);
  assert.ok(dash.activity.every((event: Json) => event.projectId !== 'prj_lab'), '不可见项目的活动不应出现');

  const projects = ok(await call('/api/projects', { token: tokenChen }));
  const ids = projects.map((project: Json) => project.id);
  assert.deepEqual(ids.sort(), ['prj_atlas', 'prj_aurora', 'prj_orion']);

  assert.equal((await call('/api/projects/prj_helios', { token: tokenChen })).status, 403);
  assert.equal((await call('/api/projects/prj_lab', { token: tokenChen })).status, 403);
  assert.equal((await call('/api/projects/prj_orion', { token: tokenChen })).status, 200);
  assert.equal((await call('/api/projects/prj_aurora', { token: tokenChen })).status, 200);

  // 团队项目可看，但陈昊不是项目成员/团队负责人，不能贡献。
  const auroraAgents = ok(await call('/api/projects/prj_aurora/agents', { token: tokenChen }));
  assert.equal(auroraAgents.length, 1);
  assert.equal((await call('/api/projects/prj_aurora', { token: tokenChen, method: 'PATCH', body: { name: 'x' } })).status, 403);
  assert.equal(
    (await call('/api/projects/prj_aurora/agents', { token: tokenChen, body: { agentId: 'agt_orion_coder' } })).status,
    403,
  );

  const agentDetail = ok(await call('/api/agents/agt_orion_coder', { token: tokenChen }));
  assert.equal(agentDetail.projects.length, 1);
  assert.equal(agentDetail.tokens.length, 1);
  assert.equal(agentDetail.instances.length, 1);
  assert.deepEqual(agentDetail.agent.stats, {
    projects: 1,
    runningTasks: 1,
    queuedTasks: 1,
    onlineInstances: 1,
  });
  assert.equal((await call('/api/agents/agt_atlas_review', { token: tokenChen })).status, 403);
});

test('周野 / 苏妍：私有、团队与公开项目可见性', async () => {
  const zhouProjects = ok(await call('/api/projects', { token: tokenZhou }));
  assert.deepEqual(
    zhouProjects.map((project: Json) => project.id).sort(),
    ['prj_atlas', 'prj_helios', 'prj_orion'],
  );
  assert.equal((await call('/api/projects/prj_helios', { token: tokenZhou })).status, 200);
  assert.equal((await call('/api/projects/prj_aurora', { token: tokenZhou })).status, 403);
  assert.equal((await call('/api/projects/prj_lab', { token: tokenZhou })).status, 403);

  const suProjects = ok(await call('/api/projects', { token: tokenSu }));
  assert.deepEqual(
    suProjects.map((project: Json) => project.id).sort(),
    ['prj_aurora', 'prj_helios', 'prj_orion'],
  );
  assert.equal((await call('/api/projects/prj_helios', { token: tokenSu })).status, 200);
  assert.equal((await call('/api/projects/prj_atlas', { token: tokenSu })).status, 403);
  assert.equal((await call('/api/teams', { token: tokenSu })).body.length, 2);

  // 非团队成员不能用该团队创建项目。
  const notMember = await call('/api/projects', {
    token: tokenSu,
    body: { name: '越权团队项目', ownerTeamId: 'tm_rnd' },
  });
  assert.equal(notMember.status, 403);
});

test('团队管理：创建 / 加人 / lead 同步 / 最后一位负责人保护', async () => {
  assert.equal((await call('/api/teams', { token: tokenChen, body: { name: '越权团队' } })).status, 403);

  const created = ok(
    await call('/api/teams', {
      token: tokenLin,
      body: { name: '质量保障组', slug: 'qa', description: '质量与发布守卫', leadPersonId: 'per_zhouye' },
    }),
    201,
  );
  assert.equal(created.slug, 'qa');
  assert.equal(created.leadPersonId, 'per_zhouye');
  assert.equal(created.leadName, '周野');
  assert.equal(created.memberCount, 1);
  assert.equal(created.projectCount, 0);
  const teamId = created.id as string;

  const detail = ok(await call(`/api/teams/${teamId}`, { token: tokenZhou }));
  assert.equal(detail.members.length, 1);
  assert.equal(detail.members[0].role, 'lead');
  assert.equal(detail.projects.length, 0);
  assert.equal((await call(`/api/teams/${teamId}`, { token: tokenSu })).status, 403);

  const patched = ok(
    await call(`/api/teams/${teamId}`, { token: tokenZhou, method: 'PATCH', body: { description: '发布质量' } }),
  );
  assert.equal(patched.description, '发布质量');

  ok(
    await call(`/api/teams/${teamId}/members`, {
      token: tokenZhou,
      body: { personId: 'per_suyan', role: 'member' },
    }),
  );
  assert.equal((await call(`/api/teams/${teamId}`, { token: tokenSu, method: 'PATCH', body: { name: 'x' } })).status, 403);

  const leadMember = ok(
    await call(`/api/teams/${teamId}/members`, {
      token: tokenLin,
      body: { personId: 'per_chenhao', role: 'lead' },
    }),
  );
  assert.equal(leadMember.role, 'lead');
  const afterLead = ok(await call(`/api/teams/${teamId}`, { token: tokenLin }));
  assert.equal(afterLead.team.leadPersonId, 'per_chenhao');
  assert.equal(afterLead.team.leadName, '陈昊');

  // 两位 lead：先移除周野，再尝试移除最后一位 lead 陈昊。
  ok(await call(`/api/teams/${teamId}/members/per_zhouye`, { token: tokenChen, method: 'DELETE' }));
  assert.equal(
    (await call(`/api/teams/${teamId}/members/per_chenhao`, { token: tokenChen, method: 'DELETE' })).status,
    409,
  );
  assert.equal(
    (await call(`/api/teams/${teamId}/members/per_chenhao`, { token: tokenLin, method: 'DELETE' })).status,
    409,
  );

  ok(await call(`/api/teams/${teamId}/members/per_suyan`, { token: tokenChen, method: 'DELETE' }));
  const finalDetail = ok(await call(`/api/teams/${teamId}`, { token: tokenChen }));
  assert.equal(finalDetail.members.length, 1);
  assert.equal(finalDetail.members[0].personId, 'per_chenhao');
});

test('项目创建、更新、密钥保护与可见性', async () => {
  const created = ok(
    await call('/api/projects', {
      token: tokenChen,
      body: { name: '测试项目甲', ownerTeamId: 'tm_rnd', description: '临时项目' },
    }),
    201,
  );
  assert.match(created.slug, /^project(-\d+)?$/, '中文名回退并保证唯一');
  assert.equal(created.visibility, 'team', '有团队时默认 team');
  assert.equal(created.type, 'manual');
  assert.equal(created.ownerPersonId, 'per_chenhao');
  assert.equal(created.ownerPersonName, '陈昊');
  assert.equal(created.mnemosConfigured, false);
  assert.deepEqual(created.counts, { agents: 0, tasks: 0, activeTasks: 0, instances: 0, members: 0 });
  const projectId = created.id as string;
  teamProjectId = projectId;

  const second = ok(
    await call('/api/projects', { token: tokenChen, body: { name: '测试项目甲', description: '无团队' } }),
    201,
  );
  assert.notEqual(second.slug, created.slug, 'slug 需要去重');
  assert.equal(second.visibility, 'private', '没有团队时默认 private');
  privateProjectId = second.id as string;

  const secret = 'mnemos_live_identity_test_secret';
  const patched = ok(
    await call(`/api/projects/${projectId}`, {
      token: tokenChen,
      method: 'PATCH',
      body: {
        name: '测试项目甲改',
        repoUrl: 'https://github.com/acme/hive-test',
        type: 'github',
        mnemosProjectId: 'prj_hive_test',
        mnemosApiKey: secret,
      },
    }),
  );
  assert.equal(patched.name, '测试项目甲改');
  assert.equal(patched.type, 'github');
  assert.equal(patched.mnemosConfigured, true);
  assert.equal(JSON.stringify(patched).includes(secret), false, '响应不得包含 mnemos 明文密钥');

  const detail = ok(await call(`/api/projects/${projectId}`, { token: tokenChen }));
  assert.equal(JSON.stringify(detail).includes(secret), false);
  assert.equal(detail.project.mnemosConfigured, true);
  assert.equal(JSON.stringify(ok(await call('/api/projects', { token: tokenChen }))).includes(secret), false);

  const cleared = ok(
    await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { mnemosApiKey: '' } }),
  );
  assert.equal(cleared.mnemosConfigured, false, '空字符串清除密钥');

  // 改私有后，团队成员周野不可见。
  ok(await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { visibility: 'private' } }));
  assert.equal((await call(`/api/projects/${projectId}`, { token: tokenZhou })).status, 403);
  ok(await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { visibility: 'public' } }));
  assert.equal((await call(`/api/projects/${projectId}`, { token: tokenZhou })).status, 200);

  // reporter 只能查看：加为成员后即使私有也可看，但管理/贡献全部 403。
  ok(
    await call(`/api/projects/${projectId}/members`, {
      token: tokenChen,
      body: { personId: 'per_zhouye', role: 'reporter' },
    }),
  );
  ok(await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { visibility: 'private' } }));
  assert.equal((await call(`/api/projects/${projectId}`, { token: tokenZhou })).status, 200);
  assert.equal(
    (await call(`/api/projects/${projectId}`, { token: tokenZhou, method: 'PATCH', body: { name: 'hijack' } })).status,
    403,
  );
  assert.equal(
    (await call(`/api/projects/${projectId}/agents`, { token: tokenZhou, body: { agentId: 'agt_atlas_review' } })).status,
    403,
  );
  ok(await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { visibility: 'public' } }));

  const archived = ok(
    await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { status: 'archived' } }),
  );
  assert.equal(archived.status, 'archived');
  ok(await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { status: 'active' } }));

  assert.equal(
    (await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'PATCH', body: { name: '' } })).status,
    400,
  );
  assert.equal(
    (await call('/api/projects', { token: tokenChen, body: { name: '坏团队项目', ownerTeamId: 'tm_missing' } })).status,
    404,
  );
  assert.equal(
    (await call('/api/projects', { token: tokenChen, body: { name: '跨团队项目', ownerTeamId: 'tm_data' } })).status,
    403,
  );
});

test('项目智员：绑定权限、唯一性、运行中任务保护、所有者解绑', async () => {
  const projectId = teamProjectId;

  const bound = ok(
    await call('/api/projects/prj_atlas/agents', { token: tokenChen, body: { agentId: 'agt_orion_coder' } }),
  );
  assert.equal(bound.memoryAgentId, 'prj_atlas_copilot__agt_orion_coder');
  assert.equal(bound.status, 'active');
  assert.equal(bound.role, 'developer');
  assert.equal(bound.agent.name, 'Orion 开发智员');
  assert.equal(bound.agent.ownerName, '陈昊');
  assert.equal(bound.onlineInstances, 1);
  assert.ok(bound.addedBy, 'addedBy 返回添加人展示名');

  assert.equal(
    (await call('/api/projects/prj_atlas/agents', { token: tokenChen, body: { agentId: 'agt_orion_coder' } })).status,
    409,
  );
  // 非自己拥有的智员不能绑定（admin 例外）。
  assert.equal(
    (await call('/api/projects/prj_atlas/agents', { token: tokenChen, body: { agentId: 'agt_atlas_review' } })).status,
    403,
  );
  assert.equal(
    (await call('/api/projects/prj_atlas/agents', { token: tokenChen, body: { agentId: 'agt_missing' } })).status,
    404,
  );

  // admin 可以绑定任意 active 智员。
  const adminBound = ok(
    await call('/api/projects/prj_lab/agents', { token: tokenLin, body: { agentId: 'agt_aurora_support' } }),
  );
  assert.equal(adminBound.memoryAgentId, 'prj_hive_lab__agt_aurora_support');
  // 记忆标识冲突。
  assert.equal(
    (await call('/api/projects/prj_lab/agents', {
      token: tokenLin,
      body: { agentId: 'agt_orion_coder', memoryAgentId: 'prj_hive_lab__agt_aurora_support' },
    })).status,
    409,
  );

  const updated = ok(
    await call(`/api/projects/prj_lab/agents/agt_aurora_support`, {
      token: tokenLin,
      method: 'PATCH',
      body: { status: 'paused', role: 'maintainer', memoryAgentId: 'prj_hive_lab__aurora_custom' },
    }),
  );
  assert.equal(updated.status, 'paused');
  assert.equal(updated.role, 'maintainer');
  assert.equal(updated.memoryAgentId, 'prj_hive_lab__aurora_custom');
  assert.equal(
    (await call('/api/projects/prj_lab/agents/agt_aurora_support', {
      token: tokenLin,
      method: 'PATCH',
      body: { memoryAgentId: 'prj_lab__platform-ops' },
    })).status,
    409,
    '同项目记忆标识唯一',
  );

  // 有 running 任务时禁止解绑。
  assert.equal(
    (await call('/api/projects/prj_orion/agents/agt_orion_coder', { token: tokenChen, method: 'DELETE' })).status,
    409,
  );
  // Agent 所有者即使不是项目成员也可以解绑自己的智员。
  ok(await call('/api/projects/prj_lab/agents/agt_aurora_support', { token: tokenSu, method: 'DELETE' }));
  // 项目负责人解绑无运行任务的智员。
  ok(await call('/api/projects/prj_atlas/agents/agt_orion_coder', { token: tokenChen, method: 'DELETE' }));

  // paused 状态的智员不能绑定新项目。
  ok(await call('/api/agents/agt_orion_coder', { token: tokenChen, method: 'PATCH', body: { status: 'paused' } }));
  assert.equal(
    (await call(`/api/projects/${projectId}/agents`, { token: tokenChen, body: { agentId: 'agt_orion_coder' } })).status,
    409,
  );
  ok(await call('/api/agents/agt_orion_coder', { token: tokenChen, method: 'PATCH', body: { status: 'active' } }));

  const list = ok(await call('/api/projects/prj_atlas/agents', { token: tokenChen }));
  assert.equal(list.length, 1);
  assert.equal(list[0].agentId, 'agt_atlas_review');
});

test('智员 CRUD、scope 与一次性令牌', async () => {
  const created = ok(
    await call('/api/agents', {
      token: tokenChen,
      body: { name: '测试智员', role: 'tester', capabilities: ['qa', 'qa', ' node '] },
    }),
    201,
  );
  assert.equal(created.name, '测试智员');
  assert.equal(created.ownerPersonId, 'per_chenhao');
  assert.equal(created.status, 'active');
  assert.deepEqual(created.capabilities, ['qa', 'node']);
  assert.deepEqual(created.stats, { projects: 0, runningTasks: 0, queuedTasks: 0, onlineInstances: 0 });
  const agentId = created.id as string;

  const mine = ok(await call('/api/agents?scope=mine', { token: tokenChen }));
  assert.equal(mine.length, 2);
  const allAsChen = ok(await call('/api/agents?scope=all', { token: tokenChen }));
  assert.equal(allAsChen.length, 2, '非 admin 的 all 也只返回自己');
  const allAsAdmin = ok(await call('/api/agents?scope=all', { token: tokenLin }));
  assert.equal(allAsAdmin.length, 6);

  const detail = ok(await call(`/api/agents/${agentId}`, { token: tokenChen }));
  assert.equal(detail.projects.length, 0);
  assert.equal(detail.tokens.length, 0);
  assert.equal(detail.instances.length, 0);
  assert.equal((await call(`/api/agents/${agentId}`, { token: tokenZhou })).status, 403);
  assert.equal(
    (await call(`/api/agents/${agentId}`, { token: tokenZhou, method: 'PATCH', body: { name: 'hijack' } })).status,
    403,
  );

  const patched = ok(
    await call(`/api/agents/${agentId}`, {
      token: tokenChen,
      method: 'PATCH',
      body: { name: '测试智员改', model: 'deepseek-coder', description: '用于集成测试' },
    }),
  );
  assert.equal(patched.name, '测试智员改');
  assert.equal(patched.model, 'deepseek-coder');

  assert.equal(
    (await call(`/api/agents/${agentId}/tokens`, { token: tokenZhou, body: { label: '越权令牌' } })).status,
    403,
  );
  assert.equal((await call(`/api/agents/${agentId}/tokens`, { token: tokenChen, body: { label: '' } })).status, 400);

  const token = ok(await call(`/api/agents/${agentId}/tokens`, { token: tokenChen, body: { label: '测试令牌' } }), 201);
  assert.match(token.secret, /^hive_agt_[A-Za-z0-9_-]{32}$/);
  assert.equal(token.prefix, token.secret.slice(0, 14));
  assert.equal(token.revokedAt, undefined);

  const stored = db
    .prepare('SELECT token_hash, prefix FROM agent_tokens WHERE id = ?')
    .get(token.id) as unknown as { token_hash: string; prefix: string };
  assert.equal(stored.token_hash, sha256(token.secret));
  assert.notEqual(stored.token_hash, token.secret);
  assert.equal(stored.prefix, token.prefix);

  const detailWithToken = ok(await call(`/api/agents/${agentId}`, { token: tokenChen }));
  assert.equal(detailWithToken.tokens.length, 1);
  assert.equal(JSON.stringify(detailWithToken).includes(token.secret), false, '详情不得返回明文 secret');
  assert.equal(JSON.stringify(detailWithToken).includes(stored.token_hash), false, '详情不得返回哈希');

  assert.equal(
    (await call(`/api/agents/${agentId}/tokens/${token.id}`, { token: tokenZhou, method: 'DELETE' })).status,
    403,
  );
  ok(await call(`/api/agents/${agentId}/tokens/${token.id}`, { token: tokenChen, method: 'DELETE' }));
  const revoked = ok(await call(`/api/agents/${agentId}`, { token: tokenChen }));
  assert.ok(revoked.tokens[0].revokedAt);
  assert.equal(
    (await call(`/api/agents/agt_orion_coder/tokens/${token.id}`, { token: tokenChen, method: 'DELETE' })).status,
    404,
  );
  ok(await call(`/api/agents/${agentId}/tokens/${token.id}`, { token: tokenChen, method: 'DELETE' }));
});

test('实例：状态计算、currentTask、所有者吊销', async () => {
  const chenInstances = ok(await call('/api/instances', { token: tokenChen }));
  assert.equal(chenInstances.length, 1);
  assert.equal(chenInstances[0].id, 'ins_orion_01');
  assert.equal(chenInstances[0].status, 'online');
  assert.equal(chenInstances[0].currentTask.title, '拆分订单查询服务（读写分离）');

  const zhouInstances = ok(await call('/api/instances', { token: tokenZhou }));
  assert.equal(zhouInstances.length, 1);
  assert.equal(zhouInstances[0].id, 'ins_atlas_01');
  assert.equal(zhouInstances[0].status, 'offline');
  assert.equal(zhouInstances[0].currentTask, undefined);

  assert.equal(
    (await call('/api/instances/ins_orion_01', { token: tokenZhou, method: 'DELETE' })).status,
    403,
  );
  ok(await call('/api/instances/ins_orion_01', { token: tokenChen, method: 'DELETE' }));

  const after = ok(await call('/api/instances', { token: tokenChen }));
  assert.equal(after[0].status, 'revoked');
  assert.ok(after[0].revokedAt);
  assert.ok(after[0].lastSeenAt);
  // 幂等吊销。
  ok(await call('/api/instances/ins_orion_01', { token: tokenChen, method: 'DELETE' }));
  assert.equal((await call('/api/instances/ins_missing', { token: tokenChen, method: 'DELETE' })).status, 404);
});

test('项目删除：仅 owner/admin，running 任务保护', async () => {
  const projectId = teamProjectId;

  assert.equal(
    (await call(`/api/projects/${projectId}`, { token: tokenZhou, method: 'DELETE' })).status,
    403,
    'reporter 不能删除项目',
  );
  assert.equal(
    (await call('/api/projects/prj_orion', { token: tokenChen, method: 'DELETE' })).status,
    409,
    '有 running 任务时 owner 也不能删除',
  );
  assert.equal((await call('/api/projects/prj_orion', { token: tokenLin, method: 'DELETE' })).status, 409);

  ok(await call(`/api/projects/${privateProjectId}`, { token: tokenChen, method: 'DELETE' }));
  assert.equal((await call(`/api/projects/${privateProjectId}`, { token: tokenChen })).status, 404);
  ok(await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'DELETE' }));
  assert.equal((await call(`/api/projects/${projectId}`, { token: tokenChen, method: 'DELETE' })).status, 404);
});
