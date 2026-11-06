#!/usr/bin/env node
/**
 * Hive 端到端冒烟：身份/可见性、项目/智员/实例、任务队列、运行时协议、
 * 自动化、GitLab Webhook 验签、Mnemos 记忆检索与写回、SSE。
 * 用法：node scripts/smoke.mjs [baseUrl]
 */
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4400';
let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push({ name, ok: true });
  } else {
    fail += 1;
    results.push({ name, ok: false, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { token, method = 'GET', body, headers = {} } = {}) {
  const h = new Headers(headers);
  if (token) h.set('authorization', `Bearer ${token}`);
  if (body !== undefined) h.set('content-type', 'application/json');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function login(email) {
  const res = await call('/api/auth/login', { method: 'POST', body: { email, password: 'hive-demo' } });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status}`);
  return res.body.token;
}

console.log(`Hive smoke → ${BASE}`);

const lin = await login('lin.wei@hive.dev');
const chen = await login('chen.hao@hive.dev');
const zhou = await login('zhou.ye@hive.dev');
const su = await login('su.yan@hive.dev');
check('登录：林薇/陈昊/周野/苏妍', Boolean(lin && chen && zhou && su));

const meta = await call('/api/meta');
check('元信息与演示账号', meta.status === 200 && meta.body.demoAccounts?.length === 4);

const dash = await call('/api/dashboard', { token: lin });
check('Dashboard 返回人员/项目/智员/活动', dash.status === 200 && dash.body.person.name === '林薇' && dash.body.projects.length >= 4);
check('Dashboard 任务统计存在', typeof dash.body.tasks?.queued === 'number');

const projects = await call('/api/projects', { token: chen });
check('陈昊仅能看到 3 个可见项目', projects.status === 200 && projects.body.length === 3, `got ${projects.body?.length}`);
const helios = await call('/api/projects/prj_helios', { token: chen });
check('私有项目对非成员 403', helios.status === 403);
const heliosZhou = await call('/api/projects/prj_helios', { token: zhou });
check('私有项目对负责人 200', heliosZhou.status === 200);
const atlasSu = await call('/api/projects/prj_atlas', { token: su });
check('团队项目对非成员 403', atlasSu.status === 403);

const project = await call('/api/projects/prj_orion', { token: chen });
check('项目详情含成员/团队/计数', project.status === 200 && project.body.project.id === 'prj_orion' && Array.isArray(project.body.members));
check('项目 Mnemos 已配置且不泄露 Key', project.body.project.mnemosConfigured === true && !JSON.stringify(project.body).includes('mnemos_live_demo'));

const agents = await call('/api/agents?scope=mine', { token: chen });
check('我的智员列表', agents.status === 200 && agents.body.length >= 1);
const agentId = agents.body[0].id;

const bindings = await call('/api/projects/prj_orion/agents', { token: chen });
check('项目智员含 memoryAgentId', bindings.status === 200 && bindings.body.some((b) => b.memoryAgentId.startsWith('prj_orion_python__')));

const instances = await call('/api/instances', { token: chen });
check('实例列表含在线/离线状态', instances.status === 200 && instances.body.length >= 1 && ['online', 'offline'].includes(instances.body[0].status));

const tasks = await call('/api/tasks?projectId=prj_orion', { token: chen });
check('任务列表', tasks.status === 200 && tasks.body.length >= 2);
const templateTask = tasks.body.find((t) => t.status === 'queued') ?? tasks.body[0];
const detail = await call(`/api/tasks/${templateTask.id}`, { token: chen });
check('任务详情含消息/事件/记忆信息', detail.status === 200 && Array.isArray(detail.body.messages) && Array.isArray(detail.body.events) && detail.body.memory.configured === true);

const message = await call(`/api/tasks/${templateTask.id}/messages`, {
  token: chen,
  method: 'POST',
  body: { content: 'smoke：先跑只读副本，注意写后读。' },
});
check('人员给任务发消息', message.status === 200 && message.body.content.includes('smoke'));

const created = await call('/api/projects/prj_orion/tasks', {
  token: chen,
  method: 'POST',
  body: { agentId, title: '[smoke] 验证任务队列', prompt: '这是 smoke 脚本创建的任务，用于验证 claim/progress/complete。', priority: 9 },
});
check('创建任务', created.status === 200 && created.body.status === 'queued');

// 运行时：用演示 Agent 令牌注册一个全新实例，走完整 claim → progress → complete
const registered = await call('/api/runtime/instances/register', {
  token: 'hive_agt_demo_orion_coder_7f3a2c',
  method: 'POST',
  body: { name: `smoke-dsh-${Date.now()}`, host: 'smoke-host', workspacePath: '/tmp/smoke', version: 'dsh smoke' },
});
check('实例注册返回一次性 token', registered.status === 201 && registered.body.token?.startsWith('hive_inst_'));
const instanceToken = registered.body.token;
const instanceId = registered.body.instance.id;

const beat = await call('/api/runtime/instances/heartbeat', { token: instanceToken, method: 'POST' });
check('实例心跳', beat.status === 200 && beat.body.ok === true);

const claim = await call('/api/runtime/tasks/claim', { token: instanceToken, method: 'POST' });
check('实例领取任务（高优先级 smoke 任务）', claim.status === 200 && claim.body.task?.title.includes('[smoke]'), `status ${claim.status}`);
const claimed = claim.body?.task;
check('领取返回记忆配置', claim.body?.memory?.enabled === true && claim.body?.memory?.agentId?.startsWith('prj_orion_python__'));

const progress = await call(`/api/runtime/tasks/${claimed.id}/progress`, {
  token: instanceToken,
  method: 'POST',
  body: { message: 'smoke：已完成 60%', payload: { progress: 60 } },
});
check('实例上报进展', progress.status === 200 && progress.body.event.type === 'task.progress');

const agentMessage = await call(`/api/runtime/tasks/${claimed.id}/messages`, {
  token: instanceToken,
  method: 'POST',
  body: { content: 'smoke：实现完成，正在补测试。' },
});
check('实例回复消息', agentMessage.status === 200 && agentMessage.body.authorType === 'agent');

const complete = await call(`/api/runtime/tasks/${claimed.id}/complete`, {
  token: instanceToken,
  method: 'POST',
  body: {
    status: 'done',
    summary: 'smoke 验证完成：队列、进展、完成与记忆写回均正常。',
    decisions: ['只读副本 + 写后读主库'],
    lessons: ['smoke 任务结束请重新 seed'],
  },
});
check('实例完成任务', complete.status === 200 && complete.body.status === 'done');

await sleep(300);
const memory = await call('/api/projects/prj_orion/memory/search?q=smoke%20%E9%AA%8C%E8%AF%81%E5%AE%8C%E6%88%90&topK=3', { token: chen });
check('Mnemos 检索可用', memory.status === 200 && memory.body.configured === true);
check('任务完成后写回项目记忆', memory.body.hits?.some((h) => h.content.includes('smoke 验证完成')) === true);

const context = await call('/api/projects/prj_orion/memory/context?agentId=agt_orion_coder&q=%E5%B9%82%E7%AD%89', { token: chen });
check('任务简报生成 prompt', context.status === 200 && context.body.configured === true && (context.body.prompt?.length ?? 0) > 50);

const automations = await call('/api/projects/prj_orion/automations', { token: chen });
check('自动化列表', automations.status === 200 && automations.body.length >= 1);
const auto = automations.body[0];
const run = await call(`/api/automations/${auto.id}/run`, { token: chen, method: 'POST' });
check('手动运行自动化创建任务', run.status === 200 && run.body.task?.source === 'automation');

const workflowBody = JSON.stringify({ object_kind: 'merge_request', object_attributes: { title: 'smoke MR', url: 'https://gitlab.acme.com/order/orion/-/merge_requests/99' }, user: { name: '陈昊' } });
const gitlab = await call('/api/integrations/gitlab/prj_orion', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-gitlab-token': 'demo-gitlab-secret', 'x-gitlab-event': 'merge_request', 'x-gitlab-event-uuid': `smoke-${Date.now()}` },
  body: workflowBody,
});
check('GitLab Webhook 验签并创建任务', gitlab.status === 202 && gitlab.body.status === 'accepted');
const badWebhook = await call('/api/integrations/gitlab/prj_orion', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-gitlab-token': 'wrong', 'x-gitlab-event': 'merge_request' },
  body: workflowBody,
});
check('错误 Webhook token 被拒', badWebhook.status === 401);

// SSE：连接后创建任务，应收到 task.created
const sseController = new AbortController();
const sseEvents = [];
fetch(`${BASE}/api/events?token=${encodeURIComponent(chen)}&projectId=prj_orion`, { signal: sseController.signal })
  .then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          try {
            sseEvents.push(JSON.parse(dataLine.slice(6)));
          } catch {
            /* ignore */
          }
        }
      }
    }
  })
  .catch(() => {});
await sleep(500);
await call('/api/projects/prj_orion/tasks', {
  token: chen,
  method: 'POST',
  body: { agentId, title: '[smoke] SSE 事件', prompt: '验证实时流', priority: 1 },
});
await sleep(1200);
sseController.abort();
check('SSE 实时推送 task.created', sseEvents.some((e) => e.type === 'task.created' && e.projectId === 'prj_orion'));

// 清理：删除 smoke 实例（吊销），保留任务供观察；seed 会整体重置
await call(`/api/instances/${instanceId}`, { token: chen, method: 'DELETE' });

console.log('');
console.log(`结果：${pass}/${pass + fail} 项通过，失败 ${fail}`);
if (fail > 0) {
  console.error(JSON.stringify(results.filter((r) => !r.ok), null, 2));
  process.exit(1);
}
