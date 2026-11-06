/**
 * 真实 Hive 联调：创建 Agent 令牌 → 建任务 → 运行时 echo claim/complete → 校验。
 * 仅操作 prj_lab（未接 Mnemos），结束后吊销实例与令牌；任务用 seed 重置。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HiveClient, HiveRuntime, resolveConfig } from '../lib/index.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4400';
let pass = 0;
const check = (name, ok) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) process.exitCode = 1;
  else pass += 1;
};

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const login = await api('/api/auth/login', { method: 'POST', body: { email: 'lin.wei@hive.dev', password: 'hive-demo' } });
const token = login.body.token;
const created = await api('/api/agents/agt_platform_ops/tokens', { token, method: 'POST', body: { label: 'runtime-smoke' } });
const agentToken = created.body.secret;
check('创建 Agent 令牌', [200, 201].includes(created.status) && agentToken?.startsWith('hive_agt_'));

const task = await api('/api/projects/prj_lab/tasks', {
  token,
  method: 'POST',
  body: {
    agentId: 'agt_platform_ops',
    title: '[runtime smoke] 数字员工执行链路',
    prompt: '这是一条运行时冒烟任务：验证注册、心跳、claim、echo 执行与完成上报。',
    priority: 99,
  },
});
check('创建任务', task.status === 200 && task.body.id);
const taskId = task.body.id;

const dir = await mkdtemp(join(tmpdir(), 'hive-runtime-live-'));
const config = resolveConfig({
  baseUrl: BASE,
  agentToken,
  instanceName: `runtime-smoke-${Date.now()}`,
  workspacePath: '/tmp/hive-runtime-smoke',
  autoClaim: true,
  pollIntervalMs: 500,
  heartbeatIntervalMs: 1000,
  executionMode: 'echo',
  maxTaskMinutes: 1,
  stateFile: join(dir, 'state.json'),
  includeMemoryContext: false,
  announceToAgent: false,
});
const runtime = new HiveRuntime({}, () => config, new HiveClient(() => config), {
  info: () => {},
  warn: console.warn,
  error: console.error,
});
await runtime.start();
const instanceId = runtime.instanceId;
check('实例注册', Boolean(instanceId));

let detail;
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  detail = await api(`/api/tasks/${taskId}`, { token });
  if (detail.body?.task?.status === 'done' || detail.body?.task?.status === 'failed') break;
}
await runtime.stop();
check('任务被运行时领取并完成', detail.body?.task?.status === 'done');
check('完成摘要来自执行器', String(detail.body?.task?.result ?? '').includes('echo 执行完成'));
check('Agent 消息已写入任务线程', (detail.body?.messages ?? []).some((m) => m.authorType === 'agent' && String(m.content).includes('echo')));

await api(`/api/instances/${instanceId}`, { token, method: 'DELETE' });
await api(`/api/agents/agt_platform_ops/tokens/${created.body.id}`, { token, method: 'DELETE' });
await rm(dir, { recursive: true, force: true });
console.log(`\n结果：${pass}/6 通过；实例与令牌已吊销（任务保留待 seed 重置）`);
