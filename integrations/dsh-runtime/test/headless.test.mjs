import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createHeadlessExecutor } from '../lib/index.js';

function baseInput(config = {}) {
  return {
    task: {
      task: {
        id: 'tsk_headless', projectId: 'prj_1', projectName: 'Orion', agentId: 'agt_1', agentName: '开发智员',
        source: 'human', title: 'headless 任务', prompt: '执行测试', status: 'running', priority: 0, metadata: {}, createdAt: new Date().toISOString(),
      },
      project: { id: 'prj_1', name: 'Orion', slug: 'orion', type: 'manual' },
      agent: { id: 'agt_1', name: '开发智员', memoryAgentId: 'm1', capabilities: [] },
      memory: { baseUrl: '', projectId: '', apiKey: '', agentId: 'm1', enabled: false },
      messages: [],
    },
    config: {
      baseUrl: 'http://127.0.0.1:4400', agentToken: 'a', instanceName: 'test', host: 'h', workspacePath: tmpdir(),
      autoClaim: true, pollIntervalMs: 5000, heartbeatIntervalMs: 20000, executionMode: 'headless',
      commandTemplate: '', dshBin: 'dsh', dshHome: '/tmp', headlessProfile: 'headless', useDshCredentials: false,
      credentialsFile: '', maxTaskMinutes: 1, stateFile: '/tmp/state.json', includeMemoryContext: false,
      provider: '', model: '', announceToAgent: false, enabled: true,
      ...config,
    },
    memoryBrief: null,
  };
}

async function fakeDsh(dir, exitCode = 0) {
  const script = join(dir, 'fake-dsh.mjs');
  await writeFile(script, `#!/usr/bin/env node
let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'session', sessionId:'session-test', cwd:process.cwd()}));
  console.log(JSON.stringify({type:'tool_call', tool:'bash', input:{command:'ls'}}));
  console.log(JSON.stringify({type:'text', text:'中间文本'}));
  console.log(JSON.stringify({type:'final', text:'最终答案：任务完成'}));
  process.exit(${exitCode});
});
`);
  await chmod(script, 0o755);
  return script;
}

test('headless 执行器：spawn 子进程、解析 NDJSON、返回 final', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-headless-'));
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    const script = await fakeDsh(dir);
    const progress = [];
    const executor = createHeadlessExecutor();
    const result = await executor(baseInput({ dshBin: script }), { progress: (m) => progress.push(m), log() {} }, new AbortController().signal);
    assert.equal(result.summary, '最终答案：任务完成');
    assert.ok(progress.some((m) => m.includes('headless 会话已启动')));
    assert.ok(progress.some((m) => m.includes('调用工具 bash')));
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('headless 执行器：子进程快速退出也不会挂起（close 竞态回归）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-headless-'));
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    const script = join(dir, 'fast-exit.mjs');
    await writeFile(script, '#!/usr/bin/env node\nprocess.exit(0);\n');
    await chmod(script, 0o755);
    const executor = createHeadlessExecutor();
    const outcome = await Promise.race([
      executor(baseInput({ dshBin: script }), { progress() {}, log() {} }, new AbortController().signal).then(
        () => ({ kind: 'resolved' }),
        (error) => ({ kind: 'rejected', message: error.message }),
      ),
      sleep(4000).then(() => ({ kind: 'timeout' })),
    ]);
    assert.equal(outcome.kind, 'rejected');
    assert.match(outcome.message, /没有输出文本/);
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('headless 执行器：非 0 退出码失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-headless-'));
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    const script = await fakeDsh(dir, 1);
    const executor = createHeadlessExecutor();
    await assert.rejects(
      () => executor(baseInput({ dshBin: script }), { progress() {}, log() {} }, new AbortController().signal),
      /headless 退出码 1/,
    );
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});
