#!/usr/bin/env node
/**
 * Aiwo DSH 实例代理。
 *
 * - outbound 连接 Aiwo 运行时：注册 → 心跳 → 轮询 claim → 执行 → 上报事件 → complete
 * - 执行优先用常驻 `dsh --profile acp` 子进程（ACP v1 over stdio），
 *   ACP 不可用时自动回退 `dsh --profile headless --json -`
 * - 单任务串行；SIGINT/SIGTERM 优雅停止
 */
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseConfig, usage, PLUGIN_VERSION } from './lib/config.mjs';
import { createLogger, sleep } from './lib/log.mjs';
import { AiwoApi, ApiError } from './lib/http.mjs';
import { normalizeClaim } from './lib/claim.mjs';
import { buildPrompt } from './lib/prompt.mjs';
import { EventPump } from './lib/events.mjs';
import { AcpRunner } from './lib/acp.mjs';
import { runHeadless } from './lib/headless.mjs';
import { AcpUnavailableError, TaskAbortError, TaskTimeoutError } from './lib/errors.mjs';
import { buildDshEnv } from './lib/credentials.mjs';

const MAX_SUMMARY = 20_000;

function runCapture(command, args, { cwd, env, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* noop */
      }
      finish('');
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', () => finish(''));
    child.on('close', (code) => finish(code === 0 ? output.trim() : ''));
  });
}

class Agent {
  constructor(config) {
    this.config = config;
    this.logger = createLogger({ verbose: config.verbose });
    this.api = new AiwoApi({ baseUrl: config.base, token: config.token, logger: this.logger });
    this.mode = config.forceHeadless ? 'headless' : 'acp';
    this.runner = null;
    this.instance = null;
    this.stopping = false;
    this.stopReason = '';
    this.active = null;
    this.heartbeatTimer = null;
    this.heartbeatBusy = false;
    this.sleepCancel = null;
  }

  async probeDshVersion() {
    const version = await runCapture(this.config.dshBin, ['--version'], {
      cwd: this.config.workspace,
      env: buildDshEnv(this.config),
      timeoutMs: 5_000,
    });
    return version.split(/\r?\n/)[0]?.trim() ?? '';
  }

  async register(version) {
    const payload = {
      name: this.config.name,
      host: this.config.host,
      workspacePath: this.config.workspace,
      version,
      pluginVersion: this.config.pluginVersion,
    };
    if (this.config.kind) payload.kind = this.config.kind;
    if (this.config.port !== undefined) payload.port = this.config.port;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const result = await this.api.register(payload);
        this.instance = result?.instance ?? null;
        this.logger.info(
          `实例已注册：${this.instance?.name ?? this.config.name}（${this.instance?.id ?? '未知 id'}）`,
        );
        if (this.instance?.workspacePath && this.instance.workspacePath !== this.config.workspace) {
          this.logger.warn(`服务端工作区为 ${this.instance.workspacePath}，本进程使用 ${this.config.workspace}`);
        }
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          this.logger.error('注册失败：实例 token 无效或已吊销（需要 aiwo_ins_...）');
          throw error;
        }
        this.logger.warn(`注册失败（第 ${attempt}/5 次）：${error instanceof Error ? error.message : String(error)}`);
        if (attempt === 5) throw error;
        await sleep(2_000);
      }
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const tick = () => {
      void this.sendHeartbeat();
    };
    this.heartbeatTimer = setInterval(tick, this.config.heartbeatMs);
    this.heartbeatTimer.unref?.();
    tick();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async sendHeartbeat() {
    if (this.heartbeatBusy || this.stopping) return;
    this.heartbeatBusy = true;
    try {
      const result = await this.api.heartbeat();
      const pending =
        typeof result?.pending === 'number'
          ? result.pending
          : typeof result?.pending?.queued === 'number'
            ? result.pending.queued
            : 0;
      this.logger.debug(`心跳正常（排队任务 ${pending}）`);
    } catch (error) {
      this.logger.warn(`心跳失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.heartbeatBusy = false;
    }
  }

  sleepInterruptible(ms) {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sleepCancel = null;
        resolve();
      }, ms);
      this.sleepCancel = () => {
        clearTimeout(timer);
        this.sleepCancel = null;
        resolve();
      };
    });
  }

  requestStop(reason) {
    if (this.stopping) {
      this.logger.warn('再次收到停止信号，强制退出');
      process.exit(130);
    }
    this.stopping = true;
    this.stopReason = reason;
    this.logger.info(`收到 ${reason}，停止领取新任务`);
    this.stopHeartbeat();
    this.sleepCancel?.();
    if (this.active) {
      this.active.abortReason = reason;
      this.active.controller.abort(new TaskAbortError(`实例收到 ${reason}`));
    }
  }

  async run() {
    mkdirSync(this.config.workspace, { recursive: true });
    this.logger.info(
      `Aiwo 实例代理 v${PLUGIN_VERSION} 启动：base=${this.config.base} workspace=${this.config.workspace} mode=${this.mode} poll=${this.config.pollMs}ms heartbeat=${this.config.heartbeatMs}ms`,
    );

    const dshVersion = await this.probeDshVersion();
    if (dshVersion) this.logger.info(`DSH 版本：${dshVersion}`);
    else this.logger.warn(`无法读取 DSH 版本（${this.config.dshBin} --version）`);

    await this.register(dshVersion);
    this.startHeartbeat();

    try {
      while (!this.stopping) {
        let raw;
        try {
          raw = await this.api.claim();
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            this.logger.error('实例 token 无效，停止代理');
            throw error;
          }
          this.logger.warn(`claim 失败：${error instanceof Error ? error.message : String(error)}`);
          await this.sleepInterruptible(this.config.pollMs);
          continue;
        }
        if (!raw) {
          await this.sleepInterruptible(this.config.pollMs);
          continue;
        }

        let claim;
        try {
          claim = normalizeClaim(raw);
        } catch (error) {
          this.logger.error(`claim 响应解析失败：${error instanceof Error ? error.message : String(error)}`);
          await this.sleepInterruptible(this.config.pollMs);
          continue;
        }

        await this.execute(claim);
        if (this.config.once) break;
      }
    } finally {
      await this.close();
    }
  }

  async execute(claim) {
    const task = claim.task;
    const projectLabel = claim.project.name || task.projectName || task.projectId || '';
    this.logger.info(`领到任务 ${task.id}「${String(task.title ?? '').slice(0, 80)}」${projectLabel ? `（${projectLabel}）` : ''}`);

    const prompt = buildPrompt(claim);
    this.logger.debug(`提示词 ${prompt.length} 字符，执行模式 ${this.mode}`);

    const pump = new EventPump({
      api: this.api,
      taskId: task.id,
      logger: this.logger,
    }).start();

    const controller = new AbortController();
    const active = {
      taskId: task.id,
      controller,
      pump,
      abortReason: '',
      progressBusy: false,
      mode: this.mode,
    };
    this.active = active;

    let timeoutTimer = null;
    if (this.config.taskTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        active.abortReason = '任务超时';
        controller.abort(new TaskTimeoutError(`任务执行超时（${this.config.taskTimeoutMs}ms）`));
      }, this.config.taskTimeoutMs);
      timeoutTimer.unref?.();
    }

    const progressTimer = this.config.leaseRenewMs > 0
      ? setInterval(() => {
          void this.sendProgress(active);
        }, this.config.leaseRenewMs)
      : null;
    progressTimer?.unref?.();

    let sessionId = '';
    let summary = '';

    try {
      const result = await this.runTaskWithFallback(prompt, active);
      sessionId = result.sessionId ?? '';
      summary = String(result.text ?? '').trim();
      if (!summary) summary = '任务完成（DSH 未输出文本）';
      await pump.flush();
      await this.finishTask(task.id, {
        status: 'done',
        summary: summary.slice(0, MAX_SUMMARY),
        sessionId: sessionId || undefined,
      });
    } catch (error) {
      const aborted = error instanceof TaskAbortError || error?.name === 'TaskAbortError';
      let message = error instanceof Error ? error.message : String(error);
      if (error instanceof TaskTimeoutError) message = '任务执行超时';
      else if (aborted) {
        message = active.abortReason
          ? `实例停止（${active.abortReason}），任务中断`
          : '任务被中断';
      }
      const failureSummary = `任务失败：${message}`.slice(0, MAX_SUMMARY);
      pump.push('error', { message });
      await pump.flush();
      await this.finishTask(task.id, {
        status: 'failed',
        summary: failureSummary,
        error: message.slice(0, MAX_SUMMARY),
        sessionId: sessionId || undefined,
      });
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      await pump.stop();
      this.active = null;
    }
  }

  async runTaskWithFallback(prompt, active) {
    if (this.mode === 'headless') {
      return this.runHeadlessTask(prompt, active);
    }
    try {
      const runner = this.ensureRunner();
      const result = await runner.runTask({
        prompt,
        signal: active.controller.signal,
        onEvent: (type, payload) => active.pump.push(type, payload),
      });
      return result;
    } catch (error) {
      if (error instanceof AcpUnavailableError) {
        this.logger.warn(`ACP 不可用，回退 headless：${error.message}`);
        this.mode = 'headless';
        active.mode = 'headless';
        this.runner?.close();
        this.runner = null;
        active.pump.push('status', { phase: 'fallback', reason: error.message });
        return this.runHeadlessTask(prompt, active);
      }
      throw error;
    }
  }

  runHeadlessTask(prompt, active) {
    return runHeadless({
      config: { ...this.config, profile: this.config.profile },
      prompt,
      signal: active.controller.signal,
      logger: this.logger,
      onEvent: (type, payload) => active.pump.push(type, payload),
    });
  }

  ensureRunner() {
    if (!this.runner) this.runner = new AcpRunner(this.config, this.logger);
    return this.runner;
  }

  async sendProgress(active) {
    if (!active || this.active !== active || active.progressBusy) return;
    active.progressBusy = true;
    try {
      await this.api.progress(active.taskId, `执行中：已上报 ${active.pump.count} 条事件`, {
        mode: active.mode,
        events: active.pump.count,
      });
      this.logger.debug('任务租约已续期');
    } catch (error) {
      this.logger.warn(`续租失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      active.progressBusy = false;
    }
  }

  async finishTask(taskId, input) {
    const payload = { status: input.status, summary: input.summary };
    if (input.error) payload.error = input.error;
    if (input.sessionId) payload.sessionId = input.sessionId;
    try {
      await this.api.complete(taskId, payload);
      this.logger.info(`任务 ${taskId} 已上报 ${input.status}`);
      return true;
    } catch (error) {
      this.logger.error(`任务 ${taskId} 完成上报失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async close() {
    this.stopping = true;
    this.stopHeartbeat();
    this.sleepCancel?.();
    if (this.active) {
      this.active.controller.abort(new TaskAbortError('实例关闭'));
    }
    this.runner?.close();
    this.runner = null;
  }
}

async function main() {
  let config;
  try {
    config = parseConfig(process.argv.slice(2));
  } catch (error) {
    console.error(`[aiwo-instance] ${error instanceof Error ? error.message : String(error)}`);
    console.error('[aiwo-instance] 使用 --help 查看用法');
    process.exit(2);
  }

  if (config.action === 'help') {
    process.stdout.write(usage());
    return;
  }
  if (config.action === 'version') {
    console.log(PLUGIN_VERSION);
    return;
  }

  const agent = new Agent(config);
  let signals = 0;
  const onSignal = (name) => {
    signals += 1;
    if (signals > 1) {
      console.error('[aiwo-instance] 强制退出');
      process.exit(130);
    }
    agent.requestStop(name);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    await agent.run();
  } catch (error) {
    agent.logger.error(`代理退出：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await agent.close();
  }
}

await main();
