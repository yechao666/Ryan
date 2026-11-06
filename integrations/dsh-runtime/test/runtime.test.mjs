import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { HiveClient, HiveRuntime, resolveConfig } from '../lib/index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function taskPayload(id = 'tsk_test_1') {
  return {
    task: {
      id,
      projectId: 'prj_test',
      projectName: '测试项目',
      agentId: 'agt_test',
      agentName: '测试智员',
      source: 'human',
      title: '实现一个测试任务',
      prompt: '请完成 smoke 任务。',
      status: 'running',
      priority: 0,
      metadata: {},
      createdAt: new Date().toISOString(),
    },
    project: { id: 'prj_test', name: '测试项目', slug: 'test', type: 'manual' },
    agent: { id: 'agt_test', name: '测试智员', memoryAgentId: 'prj_test__agent', capabilities: [] },
    memory: { baseUrl: '', projectId: '', apiKey: '', agentId: 'prj_test__agent', enabled: false },
    messages: [],
  };
}

async function startMock(options = {}) {
  const state = {
    registrations: [],
    heartbeats: [],
    claims: [],
    progress: [],
    completed: [],
    tokens: 0,
    heartbeat401: options.heartbeat401 ?? 0,
    task: options.task === false ? null : taskPayload(),
    claimed: false,
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    const auth = String(req.headers.authorization ?? '').replace('Bearer ', '');
    const send = (status, payload) => {
      res.statusCode = status;
      if (payload === undefined) return res.end();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/api/runtime/instances/register' && req.method === 'POST') {
      state.registrations.push({ auth, body });
      state.tokens += 1;
      return send(201, {
        instance: { id: `ins_${state.tokens}`, agentId: 'agt_test', agentName: '测试智员', name: body.name, host: body.host, workspacePath: body.workspacePath, version: body.version, status: 'online' },
        token: `inst_token_${state.tokens}`,
      });
    }
    if (req.url === '/api/runtime/instances/heartbeat') {
      state.heartbeats.push({ auth });
      if (state.heartbeat401 > 0) {
        state.heartbeat401 -= 1;
        return send(401, { error: { code: 'UNAUTHORIZED', message: '实例令牌已失效' } });
      }
      return send(200, { ok: true, instance: { id: 'ins_1', name: 'test', lastSeenAt: new Date().toISOString() }, pending: { queued: 0 } });
    }
    if (req.url === '/api/runtime/tasks/claim' && req.method === 'POST') {
      state.claims.push({ auth });
      if (!state.task || state.claimed) return send(204);
      state.claimed = true;
      return send(200, state.task);
    }
    if (req.url?.includes('/progress')) {
      state.progress.push({ auth, body });
      return send(200, { ok: true, event: {} });
    }
    if (req.url?.includes('/messages') && req.method === 'GET') return send(200, []);
    if (req.url?.includes('/complete') && req.method === 'POST') {
      state.completed.push({ auth, body });
      return send(200, { id: 'tsk_test_1', status: body.status });
    }
    send(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('注册 → 心跳 → claim → echo 执行 → 完成上报', async () => {
  const mock = await startMock();
  const dir = await mkdtemp(join(tmpdir(), 'hive-runtime-'));
  const config = resolveConfig({
    baseUrl: mock.baseUrl,
    agentToken: 'agent-token-1',
    instanceName: 'test-dsh',
    workspacePath: '/tmp/test-workspace',
    autoClaim: true,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 1000,
    executionMode: 'echo',
    maxTaskMinutes: 1,
    stateFile: join(dir, 'state.json'),
    includeMemoryContext: false,
  });
  const runtime = new HiveRuntime({} , () => config, new HiveClient(() => config), silent);
  await runtime.start();
  for (let i = 0; i < 60 && mock.state.completed.length === 0; i += 1) await sleep(50);
  for (let i = 0; i < 30 && mock.state.heartbeats.length === 0; i += 1) await sleep(50);
  await runtime.stop();
  await mock.close();
  await rm(dir, { recursive: true, force: true });

  assert.equal(mock.state.registrations.length, 1);
  assert.equal(mock.state.registrations[0].auth, 'agent-token-1');
  assert.equal(mock.state.registrations[0].body.workspacePath, '/tmp/test-workspace');
  assert.ok(mock.state.heartbeats.length >= 1);
  assert.ok(mock.state.claims.length >= 1);
  assert.equal(mock.state.claims[0].auth, 'inst_token_1');
  assert.equal(mock.state.completed.length, 1);
  assert.equal(mock.state.completed[0].body.status, 'done');
  assert.match(mock.state.completed[0].body.summary, /echo 执行完成/);
  assert.ok(mock.state.progress.length >= 1);
});

test('心跳 401 → 自动重新注册并使用新 token', async () => {
  const mock = await startMock({ heartbeat401: 1 });
  const dir = await mkdtemp(join(tmpdir(), 'hive-runtime-'));
  const config = resolveConfig({
    baseUrl: mock.baseUrl,
    agentToken: 'agent-token-1',
    instanceName: 'test-dsh',
    autoClaim: false,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 1000,
    executionMode: 'echo',
    stateFile: join(dir, 'state.json'),
    includeMemoryContext: false,
  });
  const runtime = new HiveRuntime({}, () => config, new HiveClient(() => config), silent);
  await runtime.start();
  for (let i = 0; i < 80 && mock.state.registrations.length < 2; i += 1) await sleep(50);
  await runtime.stop();
  await mock.close();
  await rm(dir, { recursive: true, force: true });
  assert.equal(mock.state.registrations.length, 2);
  assert.equal(mock.state.heartbeats.length >= 1, true);
  assert.equal(mock.state.claims.length, 0);
});

test('autoClaim=false 时不领取任务', async () => {
  const mock = await startMock();
  const dir = await mkdtemp(join(tmpdir(), 'hive-runtime-'));
  const config = resolveConfig({
    baseUrl: mock.baseUrl,
    agentToken: 'agent-token-1',
    instanceName: 'test-dsh',
    autoClaim: false,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 1000,
    executionMode: 'echo',
    stateFile: join(dir, 'state.json'),
    includeMemoryContext: false,
  });
  const runtime = new HiveRuntime({}, () => config, new HiveClient(() => config), silent);
  await runtime.start();
  await sleep(400);
  await runtime.stop();
  await mock.close();
  await rm(dir, { recursive: true, force: true });
  assert.equal(mock.state.claims.length, 0);
});
