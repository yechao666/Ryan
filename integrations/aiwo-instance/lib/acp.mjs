/**
 * ACP 执行器：常驻 `dsh --profile acp` 子进程，通过 @agentclientprotocol/sdk 的
 * ClientApp + ndJsonStream 创建 session、发送 prompt、消费 session/update。
 *
 * 初始化失败（找不到 dsh / profile / SDK）会抛 AcpUnavailableError，由 agent 回退 headless。
 */
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { AcpUnavailableError, TaskAbortError } from './errors.mjs';
import { buildDshEnv } from './credentials.mjs';

let sdkPromise = null;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@agentclientprotocol/sdk')
      .then((mod) => ({ client: mod.client, ndJsonStream: mod.ndJsonStream }))
      .catch((error) => {
        throw new AcpUnavailableError(
          `无法加载 @agentclientprotocol/sdk：${error instanceof Error ? error.message : String(error)}（请在 integrations/aiwo-instance 执行 npm install）`,
          error,
        );
      });
  }
  return sdkPromise;
}

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AcpUnavailableError(`${label} 超时（${ms}ms）`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 让 promise 在 signal 中断时立即 reject（并清理 abort 监听）。 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new TaskAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new TaskAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function truncateJson(value, limit = 2_000) {
  if (value === undefined) return undefined;
  try {
    return truncate(JSON.stringify(value), limit);
  } catch {
    return undefined;
  }
}

/** 从 ACP content（文本块 / content 数组）提取纯文本。 */
export function contentToText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (item.type === 'text' && typeof item.text === 'string') return item.text;
        if (item.type === 'content') return contentToText(item.content);
        if (item.type === 'image' || item.type === 'audio') return `[${item.type}]`;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.content !== undefined) return contentToText(content.content);
  }
  return '';
}

/** 单条 session/update → 运行时事件（type, payload）。 */
export function mapSessionUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentToText(update.content);
      if (!text) return null;
      return { type: 'text', payload: { text, messageId: update.messageId } };
    }
    case 'agent_thought_chunk': {
      const text = contentToText(update.content);
      if (!text) return null;
      return { type: 'thinking', payload: { text, messageId: update.messageId } };
    }
    case 'tool_call':
      return {
        type: 'tool_call',
        payload: {
          toolCallId: update.toolCallId,
          tool: update.title || update.kind || 'tool',
          title: update.title,
          kind: update.kind,
          status: update.status,
          rawInput: truncateJson(update.rawInput),
        },
      };
    case 'tool_call_update': {
      const content = contentToText(update.content);
      const finished = update.status === 'completed' || update.status === 'failed';
      return {
        type: finished ? 'tool_result' : 'tool_call',
        payload: {
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status,
          content: truncate(content, 4_000),
        },
      };
    }
    case 'usage_update':
      return { type: 'status', payload: { phase: 'usage', used: update.used, size: update.size } };
    case 'plan':
      return { type: 'status', payload: { phase: 'plan', entries: update.entries } };
    case 'current_mode_update':
    case 'config_option_update':
    case 'available_commands_update':
      return { type: 'status', payload: { phase: update.sessionUpdate } };
    default:
      return { type: 'status', payload: { phase: String(update.sessionUpdate ?? 'update') } };
  }
}

export class AcpRunner {
  /**
   * @param {object} config
   * @param {{info: Function, warn: Function, debug: Function}} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.child = null;
    this.connection = null;
    this.connected = false;
    this.closing = false;
    this.stderrTail = [];
  }

  async ensureConnected() {
    if (this.connected && this.child && this.child.exitCode === null) return;
    await this.startChild();
  }

  async startChild() {
    const { client, ndJsonStream } = await loadSdk();
    this.closing = false;
    if (this.child) this.killChild();

    const child = spawn(this.config.dshBin, ['--profile', this.config.profile], {
      cwd: this.config.workspace,
      env: buildDshEnv(this.config),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail = [];

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderrTail.push(text);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.logger.debug(`[dsh acp] ${line.trim().slice(0, 500)}`);
      }
    });

    child.on('exit', (code, signal) => {
      const wasCurrent = this.child === child;
      if (wasCurrent) {
        this.child = null;
        this.connection = null;
        this.connected = false;
      }
      if (wasCurrent && !this.closing) {
        const tail = this.stderrTail.join('').trim().split(/\r?\n/).slice(-2).join(' | ');
        this.logger.warn(`DSH ACP 进程退出（code=${code ?? '-'}, signal=${signal ?? '-'}）${tail ? `：${tail.slice(0, 300)}` : ''}`);
      }
    });

    const spawnError = new Promise((_, reject) => {
      child.once('error', (error) => {
        reject(new AcpUnavailableError(`无法启动 DSH（${this.config.dshBin}）：${error.message}`, error));
      });
    });

    try {
      const app = client({ name: 'aiwo-instance' });
      app.onRequest('session/request_permission', (context) => {
        const params = context?.params ?? {};
        const options = Array.isArray(params.options) ? params.options : [];
        const tool = params.toolCall?.title ?? params.toolCall?.toolCallId ?? 'tool';
        this.logger.info(`ACP 权限请求：${String(tool).slice(0, 120)}（策略 ${this.config.permission}）`);
        if (this.config.permission === 'reject') return { outcome: { outcome: 'cancelled' } };
        const allow =
          options.find((option) => option.kind === 'allow_once') ??
          options.find((option) => option.kind === 'allow_always') ??
          options.find((option) => option.kind && !String(option.kind).startsWith('reject'));
        return allow
          ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' } };
      });

      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
      const connection = app.connect(stream);
      this.connection = connection;

      const initPromise = connection.agent.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      const init = await Promise.race([
        withTimeout(initPromise, this.config.acpInitTimeoutMs, 'ACP initialize'),
        spawnError,
      ]);
      if (!init || typeof init !== 'object') {
        throw new AcpUnavailableError('ACP initialize 返回为空');
      }
      this.connected = true;
      this.logger.info(`ACP 已连接（${init.agentInfo?.name ?? 'dsh'} ${init.agentInfo?.version ?? ''}）`);
    } catch (error) {
      this.killChild();
      if (error instanceof AcpUnavailableError) throw error;
      const tail = this.stderrTail.join('').trim().split(/\r?\n/).slice(-3).join(' | ');
      throw new AcpUnavailableError(
        `ACP 初始化失败：${error instanceof Error ? error.message : String(error)}${tail ? `（${tail.slice(0, 300)}）` : ''}`,
        error,
      );
    }
  }

  async cancelSession(sessionId) {
    if (!sessionId || !this.connection) return;
    try {
      await this.connection.agent.notify('session/cancel', { sessionId });
    } catch (error) {
      this.logger.debug(`发送 session/cancel 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 执行一个任务 prompt，读取 session/update 直到 stop。
   * @returns {Promise<{sessionId: string, text: string, stopReason: string|null}>}
   */
  async runTask({ prompt, onEvent, signal }) {
    await this.ensureConnected();
    const session = await raceAbort(this.connection.agent.buildSession(this.config.workspace).start(), signal);
    const sessionId = session.sessionId;
    onEvent('session', { sessionId, cwd: this.config.workspace, profile: this.config.profile });

    let text = '';
    let stopReason = null;
    const promptPromise = session.prompt(prompt);
    // 避免 prompt 提前 reject 造成 unhandled rejection；真正错误在循环里抛出。
    promptPromise.catch(() => {});
    const promptError = promptPromise.then(
      () => new Promise(() => {}),
      (error) => {
        throw error;
      },
    );

    try {
      for (;;) {
        const message = await raceAbort(Promise.race([session.nextUpdate(), promptError]), signal);
        if (message.kind === 'stop') {
          stopReason = message.stopReason ?? null;
          break;
        }
        const mapped = mapSessionUpdate(message.update);
        if (!mapped) continue;
        if (mapped.type === 'text') {
          text += typeof mapped.payload.text === 'string' ? mapped.payload.text : '';
        }
        onEvent(mapped.type, mapped.payload);
      }
      await promptPromise.catch(() => {});
      onEvent('final', { text, stopReason, profile: this.config.profile });
      return { sessionId, text, stopReason };
    } catch (error) {
      if (signal?.aborted) {
        await this.cancelSession(sessionId);
        throw signal.reason ?? new TaskAbortError();
      }
      onEvent('error', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      try {
        session.dispose?.();
      } catch {
        /* noop */
      }
    }
  }

  killChild() {
    const child = this.child;
    this.child = null;
    this.connection = null;
    this.connected = false;
    if (!child) return;
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
  }

  close() {
    this.closing = true;
    this.killChild();
  }
}
