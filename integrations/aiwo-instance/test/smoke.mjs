#!/usr/bin/env node
/**
 * 冒烟测试：mock Aiwo HTTP + fake dsh（ACP / headless）。
 * 不依赖真实 Aiwo / DSH / 网络。
 *
 * 运行：node test/smoke.mjs（或 npm test）
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildPrompt, stripGoalPrefix } from '../lib/prompt.mjs';
import { normalizeClaim } from '../lib/claim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(here, '..', 'agent.mjs');
const FAKE_DSH = path.join(here, 'fixtures', 'fake-dsh.mjs');
chmodSync(FAKE_DSH, 0o755);

function makeClaim(overrides = {}) {
  return {
    task: {
      id: 'tsk_smoke',
      projectId: 'prj_demo',
      projectName: '演示项目',
      title: '冒烟任务',
      prompt: '/goal 完成冒烟测试',
      status: 'running',
      priority: 1,
      ...overrides.task,
    },
    project: {
      id: 'prj_demo',
      name: '演示项目',
      slug: 'demo',
      prompt: '项目提示词：只改必要文件，测试必须实际运行。',
      type: 'local',
      memoryAgentId: 'agent_demo',
      ...overrides.project,
    },
    executor: { personId: 'per_1', name: '张三', label: '张三@Aiwo', ...overrides.executor },
    promptCards: [
      { id: 'c1', name: '功能开发工作流', category: 'workflow', content: '卡片内容：先阅读项目提示词。' },
      ...(overrides.promptCards ?? []),
    ],
    memory: { baseUrl: '', projectId: '', apiKey: '', agentId: 'agent_demo', enabled: false, ...overrides.memory },
  };
}

async function startMock({ claim = null } = {}) {
  const state = {
    register: null,
    claims: 0,
    heartbeats: 0,
    events: [],
    eventBatches: [],
    progress: [],
    complete: null,
    completeCount: 0,
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
    }
    const url = req.url ?? '';
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url === '/api/runtime/instances/register') {
      state.register = body;
      json(200, { instance: { id: 'ins_mock', name: body?.name ?? 'mock', workspacePath: body?.workspacePath ?? '' } });
      return;
    }
    if (url === '/api/runtime/instances/heartbeat') {
      state.heartbeats += 1;
      json(200, { ok: true, instance: { id: 'ins_mock' }, pending: 0 });
      return;
    }
    if (url === '/api/runtime/tasks/claim') {
      state.claims += 1;
      if (state.claims === 1 && claim) json(200, claim);
      else {
        res.writeHead(204);
        res.end();
      }
      return;
    }
    if (/\/api\/runtime\/tasks\/[^/]+\/events$/.test(url)) {
      const events = Array.isArray(body?.events) ? body.events : [];
      state.eventBatches.push(events);
      state.events.push(...events);
      json(200, { ok: true, events: [] });
      return;
    }
    if (/\/api\/runtime\/tasks\/[^/]+\/progress$/.test(url)) {
      state.progress.push(body);
      json(200, { ok: true });
      return;
    }
    if (/\/api\/runtime\/tasks\/[^/]+\/complete$/.test(url)) {
      state.complete = body;
      state.completeCount += 1;
      json(200, { id: 'tsk_smoke', status: body?.status, result: body?.summary });
      return;
    }
    json(404, { error: { code: 'NOT_FOUND', message: 'mock: 未实现的路由' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    state,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runAgent({ port, workspace, env = {}, once = true, timeoutMs = 20_000, args = [] }) {
  const argv = [
    AGENT,
    '--base',
    `http://127.0.0.1:${port}`,
    '--token',
    'aiwo_ins_smoke_token',
    '--workspace',
    workspace,
    '--dsh-bin',
    FAKE_DSH,
    '--name',
    'smoke-agent',
    '--host',
    'smoke-host',
    '--poll',
    '100',
    '--heartbeat',
    '400',
    '--lease-renew',
    '0',
    '--no-credentials',
    ...(once ? ['--once'] : []),
    ...args,
  ];
  const child = spawn(process.execPath, argv, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agent 超时\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const results = [];
async function testCase(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS - ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`FAIL - ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

function workspaceTemp() {
  return mkdtempSync(path.join(tmpdir(), 'aiwo-instance-smoke-'));
}

/* ------------------------------------------------------------------ */
/* 1. 提示词组装 / claim 解析（纯函数）                                */
/* ------------------------------------------------------------------ */
await testCase('提示词组装：/goal 开头 + 项目/卡片/任务/执行者', () => {
  const claim = makeClaim();
  const prompt = buildPrompt(claim);
  assert.ok(prompt.startsWith('/goal'), 'prompt 必须以 /goal 开头');
  assert.equal((prompt.match(/\/goal/g) ?? []).length, 1, '只应有一个 /goal 标记');
  const order = ['项目提示词', '卡片内容', '完成冒烟测试', '张三@Aiwo'];
  let cursor = -1;
  for (const text of order) {
    const index = prompt.indexOf(text);
    assert.ok(index > cursor, `应包含且顺序正确：${text}`);
    cursor = index;
  }
  assert.ok(!prompt.includes('/goal 完成冒烟测试'), '任务原文的 /goal 前缀应被去掉后嵌入');
});

await testCase('claim 解析：保留字段 / 缺字段报错 / 去 /goal', () => {
  const claim = normalizeClaim(makeClaim());
  assert.equal(claim.task.id, 'tsk_smoke');
  assert.equal(claim.project.prompt.includes('项目提示词'), true);
  assert.equal(claim.promptCards.length, 1);
  assert.equal(claim.executor.label, '张三@Aiwo');
  assert.equal(stripGoalPrefix('/goal 做点什么'), '做点什么');
  assert.equal(stripGoalPrefix('/goal'), '');
  assert.equal(stripGoalPrefix('没有前缀'), '没有前缀');
  assert.throws(() => normalizeClaim({}), /task\.id/);
  assert.throws(() => normalizeClaim({ task: { id: 't', prompt: '' } }), /prompt/);
});

/* ------------------------------------------------------------------ */
/* 2. ACP 正常执行 + 事件上报 + complete                               */
/* ------------------------------------------------------------------ */
await testCase('ACP：claim → 提示词 → session/update → complete(done)', async () => {
  const claim = makeClaim();
  const mock = await startMock({ claim });
  const workspace = workspaceTemp();
  const promptFile = path.join(workspace, 'prompt.txt');
  try {
    const { done } = runAgent({
      port: mock.port,
      workspace,
      env: { FAKE_PROMPT_FILE: promptFile, FAKE_ACP_TEXT: 'FAKE-ACP-OK' },
    });
    const { code, signal, stdout, stderr } = await done;
    assert.equal(code, 0, `agent 退出码 ${code}/${signal}\n${stdout}\n${stderr}`);

    assert.deepEqual(
      {
        name: mock.state.register?.name,
        host: mock.state.register?.host,
        workspacePath: mock.state.register?.workspacePath,
        pluginVersion: mock.state.register?.pluginVersion,
      },
      { name: 'smoke-agent', host: 'smoke-host', workspacePath: workspace, pluginVersion: '0.1.0' },
    );
    assert.match(mock.state.register?.version ?? '', /fake-dsh/);
    assert.ok(mock.state.heartbeats >= 1, '应至少有一次心跳');
    assert.ok(mock.state.claims >= 1, '应至少 claim 一次');

    assert.equal(mock.state.complete?.status, 'done');
    assert.match(mock.state.complete?.summary ?? '', /FAKE-ACP-OK/);
    assert.equal(mock.state.complete?.sessionId, 'fake-session-1');
    assert.equal(mock.state.completeCount, 1, 'complete 只应上报一次');

    const types = new Set(mock.state.events.map((event) => event.type));
    for (const type of ['session', 'thinking', 'tool_call', 'tool_result', 'text', 'final']) {
      assert.ok(types.has(type), `缺少运行时事件类型：${type}`);
    }
    assert.ok(mock.state.eventBatches.every((batch) => batch.length <= 100), '每批事件不能超过 100 条');
    assert.ok(mock.state.eventBatches.every((batch) => batch.every((event) => event.type && event.at)), '事件需带 type/at');

    const sentPrompt = readFileSync(promptFile, 'utf8');
    assert.ok(sentPrompt.startsWith('/goal'), 'stdin 提示词必须以 /goal 开头');
    for (const text of ['项目提示词', '卡片内容', '完成冒烟测试', '张三@Aiwo']) {
      assert.ok(sentPrompt.includes(text), `stdin 提示词应包含：${text}`);
    }
  } finally {
    await mock.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 3. ACP 权限请求自动允许                                             */
/* ------------------------------------------------------------------ */
await testCase('ACP：权限请求按策略自动允许', async () => {
  const mock = await startMock({ claim: makeClaim() });
  const workspace = workspaceTemp();
  try {
    const { done } = runAgent({ port: mock.port, workspace, env: { FAKE_ACP_PERMISSION: '1' } });
    const { code, stdout, stderr } = await done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(mock.state.complete?.summary ?? '', /PERMISSION-ALLOWED/);
    assert.equal(mock.state.complete?.status, 'done');
  } finally {
    await mock.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 4. ACP 不可用 → headless 回退                                       */
/* ------------------------------------------------------------------ */
await testCase('回退：ACP 不可用时使用 headless 并完成', async () => {
  const mock = await startMock({ claim: makeClaim() });
  const workspace = workspaceTemp();
  try {
    const { done } = runAgent({
      port: mock.port,
      workspace,
      env: { FAKE_ACP_UNAVAILABLE: '1', FAKE_HEADLESS_TEXT: 'FAKE-HEADLESS-OK' },
    });
    const { code, stdout, stderr } = await done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(`${stdout}\n${stderr}`, /回退 headless/, '日志应记录 fallback');
    assert.equal(mock.state.complete?.status, 'done');
    assert.match(mock.state.complete?.summary ?? '', /FAKE-HEADLESS-OK/);
    assert.equal(mock.state.complete?.sessionId, 'fake-headless-session');
    const types = new Set(mock.state.events.map((event) => event.type));
    assert.ok(types.has('session'), 'headless 也应上报 session 事件');
    assert.ok(types.has('final'), 'headless 也应上报 final 事件');
  } finally {
    await mock.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 5. ACP prompt 失败 → complete(failed)                               */
/* ------------------------------------------------------------------ */
await testCase('失败：ACP prompt 错误上报 failed', async () => {
  const mock = await startMock({ claim: makeClaim() });
  const workspace = workspaceTemp();
  try {
    const { done } = runAgent({ port: mock.port, workspace, env: { FAKE_ACP_PROMPT_ERROR: '1' } });
    const { code, stdout, stderr } = await done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.equal(mock.state.complete?.status, 'failed');
    assert.match(mock.state.complete?.error ?? '', /fake prompt failure/);
    assert.match(mock.state.complete?.summary ?? '', /任务失败/);
    assert.equal(mock.state.completeCount, 1);
  } finally {
    await mock.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 6. headless 失败 → complete(failed)                                 */
/* ------------------------------------------------------------------ */
await testCase('失败：headless 失败上报 failed', async () => {
  const mock = await startMock({ claim: makeClaim() });
  const workspace = workspaceTemp();
  try {
    const { done } = runAgent({
      port: mock.port,
      workspace,
      env: { FAKE_ACP_UNAVAILABLE: '1', FAKE_HEADLESS_FAIL: '1' },
    });
    const { code, stdout, stderr } = await done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.equal(mock.state.complete?.status, 'failed');
    assert.match(mock.state.complete?.error ?? '', /fake headless failure/);
  } finally {
    await mock.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 7. SIGTERM 优雅停止（空闲轮询）                                     */
/* ------------------------------------------------------------------ */
await testCase('信号：空闲时 SIGTERM 优雅退出', async () => {
  const mock = await startMock({ claim: null });
  const workspace = workspaceTemp();
  try {
    const { child, done } = runAgent({ port: mock.port, workspace, once: false, timeoutMs: 10_000 });
    assert.ok(await waitFor(() => mock.state.claims >= 1), '应开始轮询 claim');
    child.kill('SIGTERM');
    const { code, signal, stdout, stderr } = await done;
    assert.equal(code, 0, `退出码 ${code}/${signal}\n${stdout}\n${stderr}`);
    assert.match(stdout, /停止领取新任务/);
    assert.equal(mock.state.completeCount, 0, '空闲退出不应上报 complete');
  } finally {
    await mock.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
const failed = results.filter((result) => !result.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error('失败用例：');
  for (const item of failed) console.error(`- ${item.name}`);
  process.exitCode = 1;
}
