import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTaskPrompt,
  createAgentExecutor,
  extractMemoryItems,
  summarizeSession,
} from '../lib/index.js';

function taskInput(overrides = {}) {
  return {
    task: {
      task: {
        id: 'tsk_1',
        projectId: 'prj_1',
        projectName: 'Orion',
        agentId: 'agt_1',
        agentName: '开发智员',
        source: 'human',
        title: '拆分查询服务',
        prompt: '把查询拆到只读副本。',
        status: 'running',
        priority: 1,
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      project: { id: 'prj_1', name: 'Orion', slug: 'orion', type: 'gitlab', prompt: '项目约束：合并前必须跑测试。', repoUrl: 'https://gitlab/x' },
      agent: { id: 'agt_1', name: '开发智员', memoryAgentId: 'prj_1__coder', capabilities: [] },
      memory: { baseUrl: 'http://127.0.0.1:4380', projectId: 'prj_1', apiKey: 'k', agentId: 'prj_1__coder', enabled: true },
      messages: [
        { id: 'm1', authorType: 'person', authorName: '陈昊', content: '注意租户维度', createdAt: new Date().toISOString() },
      ],
    },
    config: {
      baseUrl: 'http://127.0.0.1:4400',
      agentToken: 'a',
      instanceName: 'test',
      host: 'host',
      workspacePath: '/tmp/workspace',
      autoClaim: true,
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 20000,
      executionMode: 'agent',
      commandTemplate: '',
      maxTaskMinutes: 1,
      stateFile: '/tmp/state.json',
      includeMemoryContext: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      announceToAgent: true,
      enabled: true,
    },
    memoryBrief: '项目约束：幂等键必须绑定业务单号。',
    messages: [],
    ...overrides,
  };
}

function fakeContext() {
  const events = [];
  const agent = {
    status: 'idle',
    session: { seq: 0, eventAt: (i) => events[i] },
    followup(message) {
      events.push({ type: 'turn/start', seq: events.length, data: {} });
      events.push({
        type: 'assistant/message',
        seq: events.length,
        data: { message: { content: [{ type: 'text', text: '已完成拆分。\n决策：写后读主库\n经验：缓存 key 带租户' }] } },
      });
      events.push({ type: 'turn/end', seq: events.length, data: { reason: { kind: 'completed' } } });
      agent.session.seq = events.length;
      agent.lastMessage = message;
    },
    async whenIdle() {},
    cancel() {},
  };
  const created = [];
  const ctx = {
    on() {
      return () => {};
    },
    get(name) {
      if (name === 'agents') {
        return {
          async create(options) {
            created.push(options);
            return { agent };
          },
        };
      }
      if (name === 'sessions') return { async flush() {} };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };
      if (name === 'fs') return { resolve: async () => ({}), processPath: () => '/tmp/workspace' };
      return undefined;
    },
  };
  return { ctx, agent, created };
}

test('agent 执行器：创建独立会话、注入简报与历史、提取摘要', async () => {
  const { ctx, created, agent } = fakeContext();
  const executor = createAgentExecutor(ctx);
  const progress = [];
  const result = await executor(taskInput(), { progress: (m) => progress.push(m), log() {} }, new AbortController().signal);
  assert.equal(result.summary.includes('已完成拆分'), true);
  assert.deepEqual(result.decisions, ['写后读主库']);
  assert.deepEqual(result.lessons, ['缓存 key 带租户']);
  assert.equal(created.length, 1);
  assert.equal(created[0].meta.cwd, '/tmp/workspace');
  assert.equal(created[0].agentOptions.model, 'deepseek-chat');
  assert.match(agent.lastMessage.content[0].text, /项目约束：幂等键必须绑定业务单号/);
  assert.match(agent.lastMessage.content[0].text, /注意租户维度/);
  assert.ok(progress.some((m) => m.includes('DSH 会话已就绪')));
});

test('prompt 包含项目、任务、记忆与人工消息', () => {
  const prompt = buildTaskPrompt(taskInput());
  assert.match(prompt, /Orion/);
  assert.match(prompt, /拆分查询服务/);
  assert.match(prompt, /幂等键/);
  assert.match(prompt, /陈昊/);
  assert.match(prompt, /项目提示词/);
  assert.match(prompt, /合并前必须跑测试/);
});

test('summary / memory 提取', () => {
  const events = [
    { type: 'turn/start', seq: 0 },
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '第一轮' }] } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '最终结论\n决策：A\n经验：B' }] } } },
    { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
  ];
  const session = { seq: events.length, eventAt: (i) => events[i] };
  const summary = summarizeSession(session, 0);
  assert.equal(summary, '最终结论\n决策：A\n经验：B');
  assert.deepEqual(extractMemoryItems(summary), { decisions: ['A'], lessons: ['B'] });
});
