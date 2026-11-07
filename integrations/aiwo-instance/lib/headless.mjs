/**
 * headless 回退执行器：`dsh --profile headless --json -`，任务经 stdin 传入，
 * 逐行解析 NDJSON 运行事件并映射为 Aiwo 运行时事件。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TaskAbortError } from './errors.mjs';
import { buildDshEnv } from './credentials.mjs';

function truncate(text, limit = 4_000) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function eventPayload(event) {
  const { type, ...rest } = event;
  return rest;
}

/**
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.prompt
 * @param {(type: string, payload: object) => void} options.onEvent
 * @param {AbortSignal} [options.signal]
 * @param {{info: Function, warn: Function, debug: Function}} options.logger
 */
export async function runHeadless({ config, prompt, onEvent, signal, logger }) {
  const args = ['--profile', config.headlessProfile, '--json'];
  if (config.memoryToolPatch) args.push('--patch', config.memoryToolPatch);
  args.push('-');
  const child = spawn(config.dshBin, args, {
    cwd: config.workspace,
    env: buildDshEnv(config),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let sessionId = '';
  let text = '';
  let finalText = null;
  let sawFinal = false;
  let errorMessage = '';
  let aborted = false;
  const stderrTail = [];

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const onLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      logger.debug(`[dsh headless] 非 JSON 输出：${trimmed.slice(0, 300)}`);
      return;
    }
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'session':
        sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
        onEvent('session', { sessionId, cwd: event.cwd ?? config.workspace, profile: config.headlessProfile });
        break;
      case 'thinking':
        onEvent('thinking', { text: String(event.text ?? '') });
        break;
      case 'text': {
        const chunk = String(event.text ?? '');
        text += chunk;
        onEvent('text', { text: chunk });
        break;
      }
      case 'tool_call':
      case 'tool_result':
        onEvent(event.type, eventPayload(event));
        break;
      case 'status':
        onEvent('status', {
          phase: event.phase,
          turn: event.turn,
          step: event.step,
          reason: event.reason,
          usage: event.usage,
        });
        break;
      case 'final':
        sawFinal = true;
        finalText = String(event.text ?? '');
        onEvent('final', { text: finalText, stopReason: 'end_turn', profile: config.headlessProfile });
        break;
      case 'error':
        errorMessage = String(event.message ?? 'headless 执行错误');
        onEvent('error', { message: errorMessage });
        break;
      default:
        onEvent('status', { phase: String(event.type ?? 'event') });
        break;
    }
  };

  rl.on('line', onLine);
  child.stderr.on('data', (chunk) => {
    const output = chunk.toString();
    stderrTail.push(output);
    if (stderrTail.length > 30) stderrTail.shift();
    for (const line of output.split(/\r?\n/)) {
      if (line.trim()) logger.debug(`[dsh headless] ${line.trim().slice(0, 500)}`);
    }
  });

  const abort = () => {
    aborted = true;
    try {
      if (child.exitCode === null) child.kill('SIGTERM');
    } catch {
      /* noop */
    }
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {
        /* noop */
      }
    }, 2_000);
    timer.unref?.();
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  try {
    child.stdin.write(prompt.endsWith('\n') ? prompt : `${prompt}\n`);
    child.stdin.end();
  } catch (error) {
    logger.debug(`写入 headless stdin 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const exit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ kind: 'error', error }));
    child.once('close', (code, sig) => resolve({ kind: 'close', code, signal: sig }));
  });
  signal?.removeEventListener?.('abort', abort);
  rl.close();

  if (aborted) throw signal?.reason ?? new TaskAbortError();

  const tail = stderrTail.join('').trim().split(/\r?\n/).slice(-3).join(' | ');
  if (exit.kind === 'error') {
    throw new Error(`无法启动 headless（${config.dshBin}）：${exit.error?.message ?? 'unknown'}`);
  }
  if (exit.code !== 0 && (!sawFinal || !finalText)) {
    throw new Error(
      `headless 退出码 ${exit.code}${exit.signal ? `（signal ${exit.signal}）` : ''}${errorMessage ? `：${errorMessage}` : ''}${tail ? `（${tail.slice(0, 300)}）` : ''}`,
    );
  }

  if (!sawFinal) {
    finalText = text;
    onEvent('final', { text: finalText, stopReason: 'end_turn', profile: config.headlessProfile });
  }
  if (finalText === null && errorMessage) throw new Error(errorMessage);

  return {
    sessionId,
    text: finalText ?? text,
    stopReason: 'end_turn',
  };
}

export { truncate as truncateHeadlessText };
