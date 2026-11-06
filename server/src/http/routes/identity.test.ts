import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
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
    body: { name: '测试实例', kind: 'remote', host: '10.0.0.2', projectIds: ['prj_calc'] },
  }));
  assert.match(created.token, /^aiwo_ins_/);
  assert.ok(created.command.includes('aiwo-instance/agent.mjs'));
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
