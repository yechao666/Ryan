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
  const result = ok(await call('/api/auth/login', { method: 'POST', body: { email, password: 'aiwo-demo' } }));
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
  tokenLin = await login('lin.wei@aiwo.dev');
  tokenChen = await login('chen.hao@aiwo.dev');
});

after(() => {
  server?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('Aiwo 基础：登录、仪表盘无智员、实例与项目', async () => {
  assert.ok(tokenLin);
  const dash = ok(await call('/api/dashboard', { token: tokenLin }));
  assert.equal(dash.person.name, '林薇');
  assert.equal(dash.agents, undefined, 'Aiwo 不应返回 agents');
  assert.ok(Array.isArray(dash.instances));
  assert.equal(dash.projects.length, 1);
  assert.equal(dash.projects[0].counts.promptCards, 4);

  const instances = ok(await call('/api/instances', { token: tokenLin }));
  assert.equal(instances.length, 2);
  assert.equal(instances.find((item: Json) => item.id === 'ins_local').kind, 'local');
});

test('提示词卡片：项目可引用卡片、创建组织卡片、任务引用写入', async () => {
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
      title: 'Aiwo 测试任务',
      prompt: '只回复 AIWO_OK',
      priority: 99,
      promptCardIds: [created.id],
      instanceId: 'ins_local',
      type: 'ops',
    },
  }));
  assert.equal(task.executorLabel, '林薇@Aiwo');
  assert.deepEqual(task.promptCardIds, [created.id]);
  assert.equal(task.promptCards[0].name, 'AI 测试卡片');
});

test('运行时：实例领取、返回提示词卡片、完成写回', async () => {
  const queued = ok(await call('/api/tasks?projectId=prj_calc&status=queued', { token: tokenLin }));
  const target = queued.find((task: Json) => task.title === 'Aiwo 测试任务');
  assert.ok(target, '找不到测试任务');

  const claimed = ok(await call('/api/runtime/tasks/claim', {
    token: 'aiwo_ins_demo_local_7f3a2c',
    method: 'POST',
  }));
  assert.equal(claimed.task.id, target.id);
  assert.equal(claimed.executor.label, '林薇@Aiwo');
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

test('自动化任务也固定由人员@Aiwo 执行', async () => {
  const run = ok(await call('/api/automations/aut_demo_daily/run', { token: tokenLin, method: 'POST' }));
  assert.equal(run.task.executorLabel, '林薇@Aiwo');
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
  assert.equal(manifest.name, 'Aiwo API');
  assert.ok(Array.isArray(manifest.endpoints));
  assert.ok(manifest.endpoints.some((item: Json) => item.method === 'POST' && item.path === '/api/projects/:id/tasks'));
  assert.ok(manifest.endpoints.some((item: Json) => item.path === '/api/assistant/manifest'));
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
