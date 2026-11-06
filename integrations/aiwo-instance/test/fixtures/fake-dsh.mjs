#!/usr/bin/env node
/**
 * 测试用 fake dsh：
 * - `--version` → fake-dsh 0.0.1
 * - `--profile acp` → 极简 ACP v1 JSON-RPC agent（initialize / session/new / session/prompt）
 * - `--profile headless --json -` → 输出 NDJSON 运行事件
 *
 * 通过环境变量控制行为：
 *   FAKE_ACP_UNAVAILABLE=1   启动即退出（验证 ACP 回退）
 *   FAKE_ACP_PROMPT_ERROR=1  session/prompt 返回 JSON-RPC error
 *   FAKE_ACP_PERMISSION=1    发送 session/request_permission，再根据客户端回复输出结果
 *   FAKE_ACP_TEXT=...        ACP 最终文本
 *   FAKE_HEADLESS_TEXT=...   headless 最终文本
 *   FAKE_HEADLESS_FAIL=1     headless 以失败退出
 *   FAKE_PROMPT_FILE=...     把收到的 prompt 写入文件（验证提示词组装）
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const hasArg = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (hasArg('--version')) {
  process.stdout.write('fake-dsh 0.0.1\n');
  process.exit(0);
}

const profile = valueOf('--profile');
if (profile === 'acp') {
  runAcp();
} else if (profile === 'headless') {
  runHeadless();
} else {
  process.stderr.write(`fake-dsh: 未知 profile：${profile ?? '(空)'}\n`);
  process.exit(2);
}

function writePromptFile(prompt) {
  const file = process.env.FAKE_PROMPT_FILE;
  if (file) {
    try {
      writeFileSync(file, prompt, 'utf8');
    } catch {
      /* noop */
    }
  }
}

function runAcp() {
  if (process.env.FAKE_ACP_UNAVAILABLE === '1') {
    process.stderr.write('fake-dsh: ACP unavailable\n');
    process.exit(1);
  }
  let buffer = '';
  let pending = null;

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  const finishPrompt = (promptId, sessionId, text) => {
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text },
      },
    });
    notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used: 100, size: 100000 } });
    respond(promptId, { stopReason: 'end_turn' });
  };

  const handlePrompt = (message) => {
    const sessionId = message.params?.sessionId ?? 'fake-session-1';
    const prompt = Array.isArray(message.params?.prompt)
      ? message.params.prompt.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('')
      : '';
    writePromptFile(prompt);
    if (process.env.FAKE_ACP_PROMPT_ERROR === '1') {
      respondError(message.id, -32000, 'fake prompt failure');
      return;
    }
    notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', messageId: 'msg-1', content: { type: 'text', text: 'fake thinking' } },
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'bash',
        kind: 'other',
        status: 'in_progress',
        rawInput: { command: 'echo fake' },
      },
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'fake tool output' } }],
      },
    });

    if (process.env.FAKE_ACP_PERMISSION === '1') {
      pending = { promptId: message.id, sessionId };
      send({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'call-2', title: 'bash' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      return;
    }

    finishPrompt(message.id, sessionId, process.env.FAKE_ACP_TEXT || 'FAKE-ACP-OK');
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method === 'initialize') {
        respond(message.id, {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp', version: '0.0.1' },
          agentCapabilities: {},
        });
      } else if (message.method === 'session/new') {
        respond(message.id, { sessionId: 'fake-session-1' });
      } else if (message.method === 'session/prompt') {
        handlePrompt(message);
      } else if (message.id === 'perm-1' && pending) {
        const optionId = message.result?.outcome?.selected?.optionId ?? message.result?.outcome?.optionId;
        const text = optionId === 'allow-once' ? 'PERMISSION-ALLOWED' : 'PERMISSION-REJECTED';
        finishPrompt(pending.promptId, pending.sessionId, text);
        pending = null;
      } else if (message.method) {
        notify('session/update', {
          sessionId: 'fake-session-1',
          update: { sessionUpdate: 'status', phase: `fake:${message.method}` },
        });
      } else if (message.id !== undefined) {
        respond(message.id, {});
      }
    }
  });
  process.stdin.on('end', () => {
    process.exitCode = 0;
  });
}

function runHeadless() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    writePromptFile(input);
    const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
    if (process.env.FAKE_HEADLESS_FAIL === '1') {
      send({ type: 'error', message: 'fake headless failure' });
      process.exitCode = 1;
      return;
    }
    const text = process.env.FAKE_HEADLESS_TEXT || 'FAKE-HEADLESS-OK';
    send({ type: 'session', sessionId: 'fake-headless-session', cwd: process.cwd() });
    send({ type: 'status', phase: 'turn_start', turn: 1 });
    send({ type: 'thinking', text: 'fake headless thinking' });
    send({ type: 'text', text });
    send({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
    send({ type: 'final', text });
    process.exitCode = 0;
  });
}
