import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

process.env.AIWO_LOCAL_AI = '0';
import { EventBus } from '../../lib/bus.ts';
import { openDatabase, migrate } from '../../db/index.ts';
import { loadEnv } from '../../env.ts';
import { seedDatabase } from '../../seed/seed.ts';
import { Router } from '../router.ts';
import { createHttpServer } from '../server.ts';
import { registerRoutes } from './index.ts';

interface Json { [key: string]: any }
let server: Server;
let base = '';
let tempDir = '';
let tokenLin = '';
let tokenChen = '';

async function call(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body: Json | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

function ok(result: { status: number; body: Json | null }): Json {
  assert.ok(result.status >= 200 && result.status < 300, `期望 2xx，实际 ${result.status}`);
  return result.body ?? {};
}

async function login(email: string): Promise<string> {
  const result = ok(await call('/api/auth/login', { method: 'POST', body: { email, password: 'ryan-demo' } }));
  return result.token as string;
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'aiwo-test-'));
  const dbPath = join(tempDir, 'test.db');
  const db = openDatabase(dbPath);
  migrate(db);
  seedDatabase(db);
  const env = loadEnv({ dataDir: tempDir, dbPath, port: 0 });
  const app = { db, env, bus: new EventBus(), startedAt: new Date().toISOString() };
  const router = new Router();
  registerRoutes(router, app);
  server = createHttpServer(app, router);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  tokenLin = await login('lin.wei@ryan.dev');
  tokenChen = await login('chen.hao@ryan.dev');
});

after(() => {
  server?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('Ryan 基础：登录、仪表盘无智员、实例与项目', async () => {
  assert.ok(tokenLin);
  const dash = ok(await call('/api/dashboard', { token: tokenLin }));
  assert.equal(dash.person.name, '林薇');
  assert.equal(dash.agents, undefined, 'Ryan 不应返回 agents');
  assert.ok(Array.isArray(dash.instances));
  assert.equal(dash.projects.length, 1);
  assert.equal(dash.projects[0].counts.promptCards, 4);

  const instances = ok(await call('/api/instances', { token: tokenLin }));
  assert.equal(instances.length, 2);
  assert.equal(instances.find((item: Json) => item.id === 'ins_local').kind, 'local');
});

test('提示卡：项目可引用卡片、创建组织卡片、任务引用写入', async () => {
  const cards = ok(await call('/api/projects/prj_calc/prompt-cards', { token: tokenLin }));
  assert.equal(cards.length, 4);

  const created = ok(await call('/api/prompt-cards', {
    token: tokenLin,
    method: 'POST',
    body: { name: 'AI 测试卡片', category: 'style', content: '测试内容', scope: 'org' },
  }));
  assert.equal(created.scope, 'org');

  const task = ok(await call('/api/projects/prj_calc/tasks', {
    token: tokenLin,
    method: 'POST',
    body: {
      title: 'Ryan 测试任务',
      prompt: '只回复 AIWO_OK',
      priority: 99,
      promptCardIds: [created.id],
      instanceId: 'ins_local',
      type: 'ops',
    },
  }));
  assert.equal(task.executorLabel, '林薇@Ryan');
  assert.deepEqual(task.promptCardIds, [created.id]);
  assert.equal(task.promptCards[0].name, 'AI 测试卡片');
});

test('运行时：实例领取、返回提示卡、完成写回', async () => {
  const queued = ok(await call('/api/tasks?projectId=prj_calc&status=queued', { token: tokenLin }));
  const target = queued.find((task: Json) => task.title === 'Ryan 测试任务');
  assert.ok(target, '找不到测试任务');

  const claimed = ok(await call('/api/runtime/tasks/claim', {
    token: 'aiwo_ins_demo_local_7f3a2c',
    method: 'POST',
  }));
  assert.equal(claimed.task.id, target.id);
  assert.equal(claimed.executor.label, '林薇@Ryan');
  assert.equal(claimed.promptCards[0].name, 'AI 测试卡片');

  const completed = ok(await call(`/api/runtime/tasks/${target.id}/complete`, {
    token: 'aiwo_ins_demo_local_7f3a2c',
    method: 'POST',
    body: { status: 'done', summary: 'AIWO_OK' },
  }));
  assert.equal(completed.status, 'done');
  assert.equal(completed.result, 'AIWO_OK');
});

test('实例资源：管理员创建返回一次性 token，测试未接入状态', async () => {
  const created = ok(await call('/api/instances', {
    token: tokenLin,
    method: 'POST',
    body: { name: '测试服务', kind: 'remote', host: '10.0.0.2' },
  }));
  assert.match(created.token, /^aiwo_ins_/);
  assert.ok(created.command.includes('agent-package') && created.command.includes('AIWO_INSTANCE_TOKEN='));
  assert.equal('projectIds' in created.instance, false);
  assert.equal('workspacePath' in created.instance, false);
  const tested = ok(await call(`/api/instances/${created.instance.id}/test`, { token: tokenLin, method: 'POST' }));
  assert.equal(tested.ok, false);
  assert.equal(tested.status, 'unconfigured');

  const edited = ok(await call(`/api/instances/${created.instance.id}`, {
    token: tokenLin,
    method: 'PATCH',
    body: { name: '测试服务已编辑', host: '10.0.0.9', port: 4600 },
  }));
  assert.equal(edited.name, '测试服务已编辑');
  assert.equal(edited.host, '10.0.0.9');
  assert.equal(edited.port, 4600);

  ok(await call(`/api/instances/${created.instance.id}`, { token: tokenLin, method: 'DELETE' }));
  const list = ok(await call('/api/instances', { token: tokenLin }));
  assert.equal(list.find((item: Json) => item.id === created.instance.id).status, 'revoked');
  const restored = ok(await call(`/api/instances/${created.instance.id}/restore`, { token: tokenLin, method: 'POST', body: {} }));
  assert.match(restored.token, /^aiwo_ins_/);
  assert.equal(restored.instance.status, 'unconfigured');
  assert.equal(restored.instance.name, '测试服务已编辑');
});

test('系统设置：安全检查 endpoint 为空时关闭；实例配置可保存', async () => {
  const settings = ok(await call('/api/settings', { token: tokenLin }));
  assert.equal(settings.security.enabled, false);
  assert.equal(settings.security.endpoint, '');
  const patched = ok(await call('/api/settings/security', {
    token: tokenLin,
    method: 'PATCH',
    body: { endpoint: '', enabled: true },
  }));
  assert.equal(patched.security.enabled, false);
  assert.equal(patched.security.apiKeyConfigured, false);
});

test('权限：非管理员不能创建实例或修改系统设置', async () => {
  assert.equal((await call('/api/instances', { token: tokenChen, method: 'POST', body: { name: 'x' } })).status, 403);
  assert.equal((await call('/api/settings/security', { token: tokenChen, method: 'PATCH', body: { endpoint: '' } })).status, 403);
});

test('运行时：实例可查询任务状态，控制台取消后代理可感知', async () => {
  const task = ok(await call('/api/projects/prj_calc/tasks', {
    token: tokenLin,
    method: 'POST',
    body: { title: '取消测试任务', prompt: 'sleep 30', priority: 99, instanceId: 'ins_local', type: 'ops' },
  }));
  const claimed = ok(await call('/api/runtime/tasks/claim', {
    token: 'aiwo_ins_demo_local_7f3a2c',
    method: 'POST',
  }));
  assert.equal(claimed.task.id, task.id);
  const running = ok(await call(`/api/runtime/tasks/${task.id}/status`, {
    token: 'aiwo_ins_demo_local_7f3a2c',
  }));
  assert.equal(running.status, 'running');
  const cancelled = ok(await call(`/api/tasks/${task.id}/cancel`, { token: tokenLin, method: 'POST' }));
  assert.equal(cancelled.status, 'cancelled');
  const after = ok(await call(`/api/runtime/tasks/${task.id}/status`, {
    token: 'aiwo_ins_demo_local_7f3a2c',
  }));
  assert.equal(after.status, 'cancelled');
  assert.equal((await call(`/api/runtime/tasks/${task.id}/complete`, {
    token: 'aiwo_ins_demo_local_7f3a2c',
    method: 'POST',
    body: { status: 'done', summary: 'too late' },
  })).status, 409);
});

test('自动化任务也固定由人员@Ryan 执行', async () => {
  const run = ok(await call('/api/automations/aut_demo_daily/run', { token: tokenLin, method: 'POST' }));
  assert.equal(run.task.executorLabel, '林薇@Ryan');
  assert.ok(run.task.createdBy);
});

test('多实例调度：两个实例分别领取不同任务，不会抢同一单', async () => {
  const second = ok(await call('/api/instances', {
    token: tokenLin,
    method: 'POST',
    body: { name: '并发服务', kind: 'remote' },
  }));
  const first = ok(await call('/api/projects/prj_calc/tasks', {
    token: tokenLin,
    method: 'POST',
    body: { title: '并发任务 A', prompt: '只回复 A', priority: 99, instanceId: 'ins_local', type: 'ops' },
  }));
  const other = ok(await call('/api/projects/prj_calc/tasks', {
    token: tokenLin,
    method: 'POST',
    body: { title: '并发任务 B', prompt: '只回复 B', priority: 98, type: 'ops' },
  }));
  const claimA = ok(await call('/api/runtime/tasks/claim', {
    token: 'aiwo_ins_demo_local_7f3a2c',
    method: 'POST',
  }));
  const claimB = ok(await call('/api/runtime/tasks/claim', {
    token: second.token,
    method: 'POST',
  }));
  assert.equal(claimA.task.id, first.id);
  assert.equal(claimA.project.id, 'prj_calc');
  assert.equal(claimB.task.id, other.id);
  assert.notEqual(claimA.task.id, claimB.task.id);
  assert.equal((await call('/api/runtime/tasks/claim', {
    token: 'aiwo_ins_demo_local_7f3a2c',
    method: 'POST',
  })).status, 204, '忙碌实例不应再领新单');
});

test('助手 manifest：包含稳定 API 清单，不泄露凭证', async () => {
  const manifest = ok(await call('/api/assistant/manifest', { token: tokenLin }));
  assert.equal(manifest.name, 'Ryan API');
  assert.equal(manifest.version, 2);
  assert.ok(manifest.models?.Task && manifest.models?.Project && manifest.models?.Conversation);
  const taskList = manifest.endpoints.find((item: Json) => item.method === 'GET' && item.path === '/api/tasks');
  assert.ok(taskList.query?.status?.enum?.includes('running'));
  const createTask = manifest.endpoints.find((item: Json) => item.method === 'POST' && item.path === '/api/projects/:id/tasks');
  assert.equal(createTask.body?.title?.required, true);
  assert.ok(Array.isArray(manifest.endpoints));
  assert.ok(manifest.endpoints.some((item: Json) => item.method === 'POST' && item.path === '/api/projects/:id/tasks'));
  assert.ok(manifest.endpoints.some((item: Json) => item.path === '/api/assistant/manifest'));
  assert.ok(manifest.endpoints.some((item: Json) => item.method === 'DELETE' && item.path === '/api/settings/accounts/:id'));
  assert.ok(manifest.endpoints.some((item: Json) => item.path === '/api/settings/accounts'));
  assert.ok(manifest.endpoints.some((item: Json) => item.path === '/api/account'));
  assert.equal(manifest.navigation.directive, 'HIVE_NAVIGATE: <站内绝对路径>');
  assert.ok(manifest.navigation.routes.some((item: Json) => item.path === '/projects/:projectId/tasks/:taskId'));
  assert.ok(manifest.navigation.taskLookup.length >= 2);
  assert.equal(JSON.stringify(manifest).includes('Bearer aiwo'), false);
});

test('项目绑定服务：任务只在绑定服务间公平轮询', async () => {
  const second = ok(await call('/api/instances', {
    token: tokenLin,
    method: 'POST',
    body: { name: '绑定服务 B', kind: 'remote' },
  }));
  ok(await call('/api/runtime/instances/register', {
    token: second.token,
    method: 'POST',
    body: { name: '绑定服务 B', host: '127.0.0.1', version: '0.1.0' },
  }));
  ok(await call('/api/projects/prj_calc/services', {
    token: tokenLin,
    method: 'PATCH',
    body: { serviceIds: ['ins_local', second.instance.id] },
  }));
  const firstTask = ok(await call('/api/projects/prj_calc/tasks', {
    token: tokenLin,
    method: 'POST',
    body: { title: '轮询任务 A', prompt: 'echo A', type: 'ops' },
  }));
  const secondTask = ok(await call('/api/projects/prj_calc/tasks', {
    token: tokenLin,
    method: 'POST',
    body: { title: '轮询任务 B', prompt: 'echo B', type: 'ops' },
  }));
  assert.deepEqual(new Set(firstTask.allowedServiceIds), new Set(['ins_local', second.instance.id]));
  assert.deepEqual(new Set(secondTask.allowedServiceIds), new Set(['ins_local', second.instance.id]));
  assert.ok(firstTask.instanceId);
  assert.ok(secondTask.instanceId);
  assert.notEqual(firstTask.instanceId, secondTask.instanceId, '两次任务应轮询到不同服务');
});

test('默认服务：项目未绑定服务时任务使用默认服务', async () => {
  const project = ok(await call('/api/projects', {
    token: tokenLin,
    method: 'POST',
    body: { name: '默认服务项目', slug: 'default-service-project', visibility: 'team', ownerTeamId: 'tm_platform', type: 'manual' },
  }));
  ok(await call('/api/settings/default-service', {
    token: tokenLin,
    method: 'PATCH',
    body: { serviceId: 'ins_local' },
  }));
  const task = ok(await call(`/api/projects/${project.id}/tasks`, {
    token: tokenLin,
    method: 'POST',
    body: { title: '默认服务任务', prompt: 'echo default', type: 'ops' },
  }));
  assert.deepEqual(task.allowedServiceIds, ['ins_local']);
  assert.equal(task.instanceId, 'ins_local');
  const settings = ok(await call('/api/settings', { token: tokenLin }));
  assert.equal(settings.defaultServiceId, 'ins_local');
  ok(await call('/api/settings/default-service', {
    token: tokenLin,
    method: 'PATCH',
    body: { serviceId: null },
  }));
});

test('内置记忆：写入、claim 注入、完成写回', async () => {
  const project = ok(await call('/api/projects', {
    token: tokenLin,
    method: 'POST',
    body: { name: '内置记忆项目', slug: 'internal-memory-project', visibility: 'team', ownerTeamId: 'tm_platform', type: 'manual' },
  }));
  const memory = ok(await call(`/api/projects/${project.id}/memories`, {
    token: tokenLin,
    method: 'POST',
    body: { title: '支付约定', content: '支付回调必须验证签名并保持幂等。', category: 'decision' },
  }));
  const search = ok(await call(`/api/projects/${project.id}/memory/search?q=支付回调验签&topK=5`, { token: tokenLin }));
  assert.ok(search.configured);
  assert.ok(search.hits.some((hit: Json) => hit.id === memory.id));
  const brief = ok(await call(`/api/projects/${project.id}/memory/brief`, { token: tokenLin }));
  assert.match(brief.text, /支付回调必须验证签名/);
  assert.ok(brief.text.length <= 500);
  const briefConfig = ok(await call(`/api/projects/${project.id}/memory/brief`, {
    token: tokenLin,
    method: 'PATCH',
    body: { maxChars: 300 },
  }));
  assert.equal(briefConfig.maxChars, 300);
  assert.ok(briefConfig.brief.text.length <= 300);

  const service = ok(await call('/api/instances', {
    token: tokenLin,
    method: 'POST',
    body: { name: '记忆测试服务', kind: 'remote' },
  }));
  ok(await call('/api/runtime/instances/register', {
    token: service.token,
    method: 'POST',
    body: { name: '记忆测试服务', host: '127.0.0.1', version: '0.1.0' },
  }));
  const task = ok(await call(`/api/projects/${project.id}/tasks`, {
    token: tokenLin,
    method: 'POST',
    body: { title: '支付回调记忆测试', prompt: '支付回调验签怎么处理？', type: 'ops', instanceId: service.instance.id },
  }));
  const claim = ok(await call('/api/runtime/tasks/claim', {
    token: service.token,
    method: 'POST',
    body: {},
  }));
  assert.equal(claim.task.id, task.id);
  assert.ok(claim.memory.enabled);
  assert.equal(claim.memory.tools, true);
  assert.match(claim.memory.brief, /支付回调必须验证签名/);
  assert.ok(claim.memory.brief.length <= 300);
  assert.equal(claim.memory.maxChars, 300);
  assert.equal(claim.memory.context, undefined);
  const current = ok(await call('/api/runtime/tasks/current', { token: service.token }));
  assert.equal(current.taskId, task.id);
  const toolSearch = ok(await call(`/api/runtime/tasks/${task.id}/memory/search`, {
    token: service.token,
    method: 'POST',
    body: { query: '支付回调', topK: 5 },
  }));
  assert.ok(toolSearch.hits.some((hit: Json) => hit.id === memory.id));
  const toolContext = ok(await call(`/api/runtime/tasks/${task.id}/memory/context?query=支付回调`, {
    token: service.token,
  }));
  assert.match(toolContext.prompt, /支付回调必须验证签名/);
  const toolAdd = ok(await call(`/api/runtime/tasks/${task.id}/memory/add`, {
    token: service.token,
    method: 'POST',
    body: { content: 'DSH 工具写入的项目记忆', category: 'note' },
  }));
  assert.equal(toolAdd.category, 'note');
  assert.equal(toolAdd.taskId, task.id);
  assert.equal(toolAdd.status, 'candidate');
  const blocked = await call(`/api/runtime/tasks/${task.id}/memory/add`, {
    token: service.token,
    method: 'POST',
    body: { content: '任务完成：执行成功，退出码 0。', category: 'note' },
  });
  assert.equal(blocked.status, 400);
  ok(await call(`/api/runtime/tasks/${task.id}/complete`, {
    token: service.token,
    method: 'POST',
    body: { status: 'done', summary: '已完成支付验签改造', decisions: ['使用 HMAC 验签'], lessons: ['重复回调保持幂等'] },
  }));
  const after = ok(await call(`/api/projects/${project.id}/memories?limit=20`, { token: tokenLin }));
  assert.ok(after.memories.some((hit: Json) => hit.taskId === task.id));
  assert.equal(after.agentId, 'aiwo_internal_memory_project');
});

test('记忆做梦：只整理任务候选决策/经验并生成洞见', async () => {
  process.env.AIWO_DREAM_AI = '0';
  const project = ok(await call('/api/projects', {
    token: tokenLin,
    method: 'POST',
    body: { name: '做梦项目', slug: 'dream-project', visibility: 'team', ownerTeamId: 'tm_platform', type: 'manual' },
  }));
  const service = ok(await call('/api/instances', {
    token: tokenLin,
    method: 'POST',
    body: { name: '做梦测试服务', kind: 'remote' },
  }));
  ok(await call('/api/runtime/instances/register', {
    token: service.token,
    method: 'POST',
    body: { name: '做梦测试服务', host: '127.0.0.1', version: '0.1.0' },
  }));
  const task = ok(await call(`/api/projects/${project.id}/tasks`, {
    token: tokenLin,
    method: 'POST',
    body: { title: '做梦任务', prompt: '只输出结论', type: 'ops', instanceId: service.instance.id },
  }));
  ok(await call('/api/runtime/tasks/claim', { token: service.token, method: 'POST', body: {} }));
  ok(await call(`/api/runtime/tasks/${task.id}/complete`, {
    token: service.token,
    method: 'POST',
    body: {
      status: 'done',
      summary: '普通任务结果不应进入项目记忆',
      decisions: ['接口统一使用 snake_case'],
      lessons: ['部署前必须先运行迁移'],
    },
  }));
  const configured = ok(await call(`/api/projects/${project.id}/memory/dream`, {
    token: tokenLin,
    method: 'PATCH',
    body: { enabled: true, intervalMinutes: 60 },
  }));
  assert.equal(configured.intervalMinutes, 60);
  const status = ok(await call(`/api/projects/${project.id}/memory/dream`, { token: tokenLin }));
  assert.equal(status.pendingCount, 1);
  assert.equal(status.settings.intervalMinutes, 60);
  const run = ok(await call(`/api/projects/${project.id}/memory/dream/run`, {
    token: tokenLin,
    method: 'POST',
    body: {},
  }));
  assert.equal(run.run.status, 'completed');
  assert.equal(run.run.inputCount, 1);
  assert.ok(run.run.insightCount >= 1);
  assert.equal(run.status.pendingCount, 0);
  const after = ok(await call(`/api/projects/${project.id}/memories?limit=20`, { token: tokenLin }));
  assert.ok(after.memories.some((hit: Json) => hit.category === 'insight'));
  assert.ok(after.memories.some((hit: Json) => hit.source === 'task' && hit.status === 'archived'));
  const empty = ok(await call(`/api/projects/${project.id}/memory/dream/run`, {
    token: tokenLin,
    method: 'POST',
    body: {},
  }));
  assert.equal(empty.run.status, 'skipped');
  delete process.env.AIWO_DREAM_AI;
});

test('记忆批量删除', async () => {
  const project = ok(await call('/api/projects', {
    token: tokenLin,
    method: 'POST',
    body: { name: '批量删除项目', slug: 'bulk-delete-project', visibility: 'team', ownerTeamId: 'tm_platform', type: 'manual' },
  }));
  const one = ok(await call(`/api/projects/${project.id}/memories`, {
    token: tokenLin,
    method: 'POST',
    body: { content: '批量删除测试记忆一，内容足够长。', category: 'note' },
  }));
  const two = ok(await call(`/api/projects/${project.id}/memories`, {
    token: tokenLin,
    method: 'POST',
    body: { content: '批量删除测试记忆二，内容足够长。', category: 'note' },
  }));
  const removed = ok(await call(`/api/projects/${project.id}/memories`, {
    token: tokenLin,
    method: 'DELETE',
    body: { ids: [one.id, two.id] },
  }));
  assert.equal(removed.deleted, 2);
  const after = ok(await call(`/api/projects/${project.id}/memories?limit=20`, { token: tokenLin }));
  assert.equal(after.memories.length, 0);
});

test('账号体系：管理员创建账号、本地登录、改密与统一认证配置', async () => {
  const provider = ok(await call('/api/settings/auth-providers', {
    token: tokenLin,
    method: 'POST',
    body: {
      name: '测试 SSO',
      slug: 'test-sso',
      issuer: 'https://idp.example.invalid',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    },
  }));
  assert.equal(provider.slug, 'test-sso');
  const publicProviders = ok(await call('/api/auth/providers'));
  assert.ok(publicProviders.some((item: Json) => item.slug === 'test-sso'));

  const created = ok(await call('/api/settings/accounts', {
    token: tokenLin,
    method: 'POST',
    body: { name: '新同事', email: 'new.person@ryan.dev', password: 'new-password', title: '工程师' },
  }));
  assert.equal(created.email, 'new.person@ryan.dev');
  const newLogin = ok(await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'new.person@ryan.dev', password: 'new-password' },
  }));
  const newToken = newLogin.token as string;
  const account = ok(await call('/api/account', { token: newToken }));
  assert.equal(account.person.name, '新同事');
  assert.equal(account.hasPassword, true);
  assert.ok(account.availableProviders.some((item: Json) => item.slug === 'test-sso'));

  ok(await call('/api/account', {
    token: newToken,
    method: 'PATCH',
    body: { name: '新同事 B', title: '高级工程师' },
  }));
  ok(await call('/api/account/password', {
    token: newToken,
    method: 'POST',
    body: { currentPassword: 'new-password', newPassword: 'changed-password' },
  }));
  const relogin = ok(await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'new.person@ryan.dev', password: 'changed-password' },
  }));
  assert.equal(relogin.person.name, '新同事 B');

  ok(await call(`/api/settings/auth-providers/${provider.id}`, {
    token: tokenLin,
    method: 'DELETE',
  }));

  const selfDelete = await call('/api/settings/accounts/per_linwei', {
    token: tokenLin,
    method: 'DELETE',
  });
  assert.equal(selfDelete.status, 400);
  ok(await call(`/api/settings/accounts/${created.id}`, {
    token: tokenLin,
    method: 'DELETE',
  }));
  const afterDelete = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'new.person@ryan.dev', password: 'changed-password' },
  });
  assert.equal(afterDelete.status, 401);
});

test('统一认证：OIDC 登录自动创建人员并建立会话', async () => {
  const idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/.well-known/openid-configuration') {
      const base = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
      }));
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        res.statusCode = params.get('code') === 'test-code' ? 200 : 400;
        res.end(JSON.stringify({ access_token: 'test-access-token', token_type: 'Bearer' }));
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      res.end(JSON.stringify({ sub: 'sso-subject-1', email: 'sso.user@ryan.dev', name: 'SSO 用户' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  const idpPort = (idp.address() as { port: number }).port;
  try {
    ok(await call('/api/settings/auth-providers', {
      token: tokenLin,
      method: 'POST',
      body: {
        name: 'OIDC 测试',
        slug: 'oidc-sso',
        issuer: `http://127.0.0.1:${idpPort}`,
        clientId: 'oidc-client',
        clientSecret: 'oidc-secret',
      },
    }));
    const start = await fetch(`${base}/api/auth/sso/oidc-sso/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get('location') ?? '');
    assert.equal(authorization.pathname, '/authorize');
    const state = authorization.searchParams.get('state') ?? '';
    assert.ok(state);
    assert.ok(authorization.searchParams.get('code_challenge'));

    const callback = await fetch(`${base}/api/auth/sso/oidc-sso/callback?code=test-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(callback.status, 302);
    const location = callback.headers.get('location') ?? '';
    assert.ok(location.startsWith('/login#token='));
    const token = decodeURIComponent(location.slice('/login#token='.length));
    const me = ok(await call('/api/auth/me', { token }));
    assert.equal(me.person.email, 'sso.user@ryan.dev');
    const account = ok(await call('/api/account', { token }));
    assert.equal(account.hasPassword, false);
    assert.equal(account.identities[0].providerSlug, 'oidc-sso');
  } finally {
    idp.close();
  }
});

test('团队批量添加成员', async () => {
  const team = ok(await call('/api/teams', {
    token: tokenLin,
    method: 'POST',
    body: { name: '批量成员团队', slug: 'bulk-member-team' },
  }));
  const added = ok(await call(`/api/teams/${team.id}/members/bulk`, {
    token: tokenLin,
    method: 'POST',
    body: { personIds: ['per_zhouye', 'per_suyan'], role: 'member' },
  }));
  assert.equal(added.count, 2);
  const detail = ok(await call(`/api/teams/${team.id}`, { token: tokenLin }));
  assert.ok(detail.members.some((member: Json) => member.personId === 'per_zhouye'));
  assert.ok(detail.members.some((member: Json) => member.personId === 'per_suyan'));
});

test('团队负责人角色可调整且至少保留一位', async () => {
  const team = ok(await call('/api/teams', {
    token: tokenLin,
    method: 'POST',
    body: { name: '角色调整团队', slug: 'role-change-team', leadPersonId: 'per_linwei' },
  }));
  ok(await call(`/api/teams/${team.id}/members/bulk`, {
    token: tokenLin,
    method: 'POST',
    body: { personIds: ['per_zhouye'], role: 'member' },
  }));
  const promoted = ok(await call(`/api/teams/${team.id}/members/per_zhouye`, {
    token: tokenLin,
    method: 'PATCH',
    body: { role: 'lead' },
  }));
  assert.equal(promoted.role, 'lead');
  const detail = ok(await call(`/api/teams/${team.id}`, { token: tokenLin }));
  assert.equal(detail.team.leadPersonId, 'per_zhouye');
  assert.equal(detail.members.find((member: Json) => member.personId === 'per_linwei').role, 'member');
  const lastLead = await call(`/api/teams/${team.id}/members/per_zhouye`, {
    token: tokenLin,
    method: 'PATCH',
    body: { role: 'member' },
  });
  assert.equal(lastLead.status, 409);
});

test('项目工作区：本机服务可浏览，远端服务明确不可用', async () => {
  ok(await call('/api/projects/prj_calc/services', {
    token: tokenLin,
    method: 'PATCH',
    body: { serviceIds: ['ins_local', 'ins_remote'] },
  }));
  const local = ok(await call('/api/projects/prj_calc/services/ins_local/workspace', { token: tokenLin }));
  assert.equal(local.projectId, 'prj_calc');
  assert.equal(local.serviceId, 'ins_local');
  assert.equal(local.available, true);
  assert.ok(local.workspaceRoot.includes('prj_calc'));
  const remote = ok(await call('/api/projects/prj_calc/services/ins_remote/workspace', { token: tokenLin }));
  assert.equal(remote.available, false);
  assert.ok(remote.reason);
});

test('用户 API Key：创建、鉴权、吊销', async () => {
  const created = ok(await call('/api/account/api-keys', {
    token: tokenLin,
    method: 'POST',
    body: { name: 'DSH 测试' },
  }));
  assert.match(created.key, /^ryan_ak_/);
  const keys = ok(await call('/api/account/api-keys', { token: tokenLin }));
  assert.ok(keys.keys.some((key: Json) => key.id === created.id && key.prefix === created.key.slice(0, 16)));
  const me = ok(await call('/api/auth/me', { token: created.key }));
  assert.equal(me.person.id, 'per_linwei');
  ok(await call(`/api/account/api-keys/${created.id}`, { token: tokenLin, method: 'DELETE' }));
  assert.equal((await call('/api/auth/me', { token: created.key })).status, 401);
});

test('助手会话按账号隔离，支持创建/重命名/删除', async () => {
  const created = ok(await call('/api/assistant/conversations', {
    token: tokenLin,
    method: 'POST',
    body: { title: '我的活动会话', pathname: '/chats' },
  }));
  const id = created.conversation.id as string;
  const own = ok(await call('/api/assistant/conversations', { token: tokenLin }));
  assert.ok(own.conversations.some((item: Json) => item.id === id));
  const other = ok(await call('/api/assistant/conversations', { token: tokenChen }));
  assert.equal(other.conversations.some((item: Json) => item.id === id), false);
  assert.equal((await call(`/api/assistant/conversations/${id}`, { token: tokenChen })).status, 403);
  ok(await call(`/api/assistant/conversations/${id}`, {
    token: tokenLin,
    method: 'PATCH',
    body: { title: '重命名后的会话' },
  }));
  const detail = ok(await call(`/api/assistant/conversations/${id}`, { token: tokenLin }));
  assert.equal(detail.conversation.title, '重命名后的会话');
  ok(await call(`/api/assistant/conversations/${id}`, { token: tokenLin, method: 'DELETE' }));
  assert.equal((await call(`/api/assistant/conversations/${id}`, { token: tokenLin })).status, 404);
});
