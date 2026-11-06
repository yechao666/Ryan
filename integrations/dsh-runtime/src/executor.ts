/**
 * 任务执行器：
 *  - agent：在 DSH 进程内用 `agents.create` 起一个独立会话执行（真正的数字员工运行时）
 *  - command：执行外部命令（如 `dsh --profile headless ...`），适合隔离/无 agent 服务的场景
 *  - echo：只回显任务，用于联调与冒烟
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Context, AgentLike, AgentsService, AgentDefaultModelService, FsService, SessionsService, SessionEventLike, SubagentsService } from './dsh-types.js';
import type { HiveRuntimeConfig } from './config.js';
import { type HiveClaimedTask } from './client.js';
import { resolveDeepseekApiKey } from './credentials.js';

export interface TaskExecutionInput {
  task: HiveClaimedTask;
  config: HiveRuntimeConfig;
  memoryBrief?: string | null;
}

export interface ExecutionHooks {
  progress(message: string, payload?: Record<string, unknown>): void;
  log(message: string, fields?: Record<string, unknown>): void;
  /** 转发 DSH headless NDJSON 事件到 Hive，控制台实时展示。 */
  runtime?(event: { type: string; payload: Record<string, unknown>; at?: string }): void;
}

export interface ExecutionOutput {
  summary: string;
  decisions?: string[];
  lessons?: string[];
  /** headless 会话 id，服务端保存后用于任务完成后的追问。 */
  sessionId?: string;
}

export type TaskExecutor = (
  input: TaskExecutionInput,
  hooks: ExecutionHooks,
  signal: AbortSignal,
) => Promise<ExecutionOutput>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** headless 输入必须以 /goal 开头；任务提示词已统一带 /goal 前缀。 */
function ensureGoalCommand(prompt: string): string {
  const trimmed = prompt.trimStart();
  return /^\/goal(?:\s|$)/i.test(trimmed) ? trimmed : `/goal\n${prompt}`;
}

/** 中文提示词：任务 + 项目 + 记忆简报 + 历史消息。 */
export function buildTaskPrompt(input: TaskExecutionInput): string {
  const { task, memoryBrief } = input;
  const lines: string[] = [
    '你正在作为 Hive 数字员工执行一个项目任务。',
    `项目：${task.project.name}（${task.project.id}${task.project.repoUrl ? `，仓库 ${task.project.repoUrl}` : ''}）`,
    ...(task.project.prompt?.trim()
      ? ['', '项目提示词（项目基本面，必须遵守）：', task.project.prompt.trim()]
      : []),
    `任务：#${task.task.id} ${task.task.title}`,
    `来源：${task.task.source}　优先级：${task.task.priority}`,
    '',
    '任务要求：',
    task.task.prompt,
  ];
  if (memoryBrief?.trim()) {
    lines.push('', '项目记忆简报（来自 Mnemos，可作为背景参考）：', memoryBrief.trim());
  }
  if (task.messages.length > 0) {
    lines.push('', '历史消息：');
    for (const message of task.messages.slice(-10)) {
      lines.push(`- [${message.authorType}] ${message.authorName}：${message.content}`);
    }
  }
  lines.push(
    '',
    '执行要求：',
    '- 直接在当前工作区完成工作；不要等待用户输入，除非确实缺少无法推断的关键信息。',
    '- 完成后用中文输出：结论、关键决策、踩坑经验（如有）。',
    '- 需要人工确认的步骤，请在结果中明确写出「需要人工确认：…」。',
  );
  return lines.join('\n');
}

/** 从 Session 持久事件里提取本轮最后的助手文本与结束原因。 */
export function summarizeSession(session: { seq: number; eventAt(index: number): SessionEventLike | undefined }, firstSeq: number): string {
  let started = false;
  let text = '';
  let error: unknown;
  for (let seq = firstSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? [];
      const joined = Array.isArray(content)
        ? content.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text ?? '')).join('')
        : '';
      if (joined.trim()) text = joined;
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason;
      if (reason?.kind === 'error') error = reason.error ?? new Error('Agent 执行失败');
    }
  }
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return text.trim() || '任务结束，但 Agent 没有产生文本输出。';
}

export function extractMemoryItems(summary: string): { decisions: string[]; lessons: string[] } {
  const decisions: string[] = [];
  const lessons: string[] = [];
  for (const line of summary.split('\n')) {
    const trimmed = line.replace(/^[-*\d.\s]+/, '').trim();
    if (/^(决策|关键决策)[:：]/.test(trimmed)) decisions.push(trimmed.replace(/^(决策|关键决策)[:：]\s*/, '').slice(0, 4000));
    if (/^(经验|教训|踩坑)[:：]/.test(trimmed)) lessons.push(trimmed.replace(/^(经验|教训|踩坑)[:：]\s*/, '').slice(0, 4000));
  }
  return { decisions: decisions.filter(Boolean).slice(0, 50), lessons: lessons.filter(Boolean).slice(0, 50) };
}

/** 联调用：不真正调用 LLM。 */
export function createEchoExecutor(): TaskExecutor {
  return async (input, hooks) => {
    hooks.progress(`echo：已领取「${input.task.task.title}」`, { phase: 'echo' });
    await sleep(120);
    const summary = `echo 执行完成：${input.task.task.title}\n${input.task.task.prompt.slice(0, 500)}`;
    return { summary, ...extractMemoryItems(summary) };
  };
}

/** 外部命令执行器：任务通过环境变量注入，stdout 作为结果。 */
export function createCommandExecutor(): TaskExecutor {
  return async (input, hooks, signal) => {
    const template = input.config.commandTemplate.trim();
    if (!template) throw new Error('executionMode=command 但 commandTemplate 为空；例如：dsh --profile headless \"$HIVE_TASK_PROMPT\"');
    const env = {
      ...process.env,
      HIVE_TASK_ID: input.task.task.id,
      HIVE_TASK_TITLE: input.task.task.title,
      HIVE_TASK_PROMPT: buildTaskPrompt(input),
      HIVE_PROJECT_ID: input.task.project.id,
      HIVE_PROJECT_NAME: input.task.project.name,
      HIVE_INSTANCE_NAME: input.config.instanceName,
    };
    await mkdir(input.config.workspacePath, { recursive: true });
    hooks.progress('启动外部执行命令', { phase: 'spawn' });
    const child = spawn(template, {
      shell: true,
      cwd: input.config.workspacePath || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let lastReport = Date.now();
    let lastLine = '';
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.trim().split('\n');
      const line = lines[lines.length - 1]?.trim() ?? '';
      if (line && line !== lastLine && Date.now() - lastReport > 3000) {
        lastLine = line;
        lastReport = Date.now();
        hooks.progress(line.slice(0, 500), { phase: 'output' });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(exitCode));
    }).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) throw new Error('运行时已停止，任务被中断');
    if (code !== 0) {
      throw new Error(`命令退出码 ${String(code)}：${(stderr || stdout).trim().slice(-2000) || '无输出'}`);
    }
    const summary = stdout.trim().slice(0, 18_000) || '命令执行完成，无输出。';
    return { summary, ...extractMemoryItems(summary) };
  };
}

/**
 * headless 执行器（默认）：每个任务一个 `dsh --profile headless --json -` 子进程。
 * 任务经 stdin 传入，NDJSON 事件用于进展上报，final 事件作为最终答案。
 * 子进程环境会禁用本插件，避免递归注册。
 *
 * 会话延续仅限运行中的任务：本轮结束后用 `--session-id` 继续跑，直到没有新消息。
 * 任务完成即结束，不再续聊。
 */
export function createHeadlessExecutor(): TaskExecutor {
  return async (input, hooks, signal) => {
    const config = input.config;

    const runTurn = async (prompt: string, resumeSessionId?: string): Promise<{ text: string; sessionId?: string }> => {
      await mkdir(config.workspacePath, { recursive: true });
      const credentials = await resolveDeepseekApiKey(config);
      if (!credentials.apiKey) {
        throw new Error(
          'headless 模式需要 DEEPSEEK_API_KEY：请在启动 DSH 的环境中导出，或把 key 写入 ' +
            `${config.dshHome}/.credentials.yaml 的 refs.DEEPSEEK_API_KEY`,
        );
      }
      const args = ['--profile', config.headlessProfile, '--json'];
      if (resumeSessionId) args.push('--session-id', resumeSessionId);
      args.push('-');
      hooks.log('headless 启动', { bin: config.dshBin, profile: config.headlessProfile, cwd: config.workspacePath, resume: Boolean(resumeSessionId) });
      const child = spawn(config.dshBin, args, {
        cwd: config.workspacePath || process.cwd(),
        env: {
          ...process.env,
          DSH_HOME: config.dshHome,
          DEEPSEEK_API_KEY: credentials.apiKey,
          DSH_HIVE_RUNTIME_DISABLED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      hooks.log('headless 进程已创建', { pid: child.pid });

      // 必须在写 stdin 之前绑定 exit/close：极快失败时 close 可能早于 Promise 创建。
      const exitPromise = new Promise<number | null>((resolve, reject) => {
        let settled = false;
        const done = (code: number | null) => {
          if (settled) return;
          settled = true;
          resolve(code);
        };
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          reject(new Error(`无法启动 ${config.dshBin}：${error.message}`));
        });
        child.once('close', (code) => done(code));
        // close 理论上是可靠的；exit 作为兜底，避免某些 stdio 场景下 close 丢失。
        child.once('exit', (code) => setTimeout(() => done(code), 300));
      });
      child.stdin.on('error', () => undefined);

      let stdout = '';
      let stderr = '';
      let buffer = '';
      let finalText: string | null = null;
      let lastText = '';
      let sessionId: string | undefined;
      let failure: Error | null = null;
      let killed = false;

      const report = (message: string, payload?: Record<string, unknown>) => hooks.progress(message, payload);
      const handleEvent = (event: any): void => {
        if (!event || typeof event.type !== 'string') return;
        try {
          hooks.runtime?.({ type: event.type, payload: event as Record<string, unknown> });
        } catch {
          /* 上报失败不影响执行 */
        }
        switch (event.type) {
          case 'session':
            if (typeof event.sessionId === 'string') sessionId = event.sessionId;
            report(`DSH headless 会话已启动（${String(event.sessionId ?? '').slice(0, 24)}）`, {
              phase: 'session',
              sessionId: event.sessionId,
            });
            return;
          case 'tool_call':
            report(`调用工具 ${String(event.tool ?? 'tool')}`, { phase: 'tool', tool: event.tool });
            return;
          case 'text':
            if (typeof event.text === 'string' && event.text.trim()) lastText = event.text;
            return;
          case 'final':
            if (typeof event.text === 'string') finalText = event.text;
            return;
          case 'status':
            if (event.phase === 'turn_end' && event.reason?.kind === 'error') {
              failure = new Error(event.reason.error?.message ?? 'headless Agent 执行失败');
            }
            return;
          case 'error':
            failure = new Error(String(event.message ?? 'headless 执行失败'));
            return;
          default:
            return;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            handleEvent(JSON.parse(trimmed));
          } catch {
            /* 忽略非 JSON 诊断行 */
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });

      const kill = () => {
        if (killed) return;
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      };
      const onAbort = () => kill();
      signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(kill, config.maxTaskMinutes * 60_000);
      timeout.unref?.();

      try {
        child.stdin.end(ensureGoalCommand(prompt));
        const code = await exitPromise;
        hooks.log('headless 退出', { code, taskSession: resumeSessionId });
        if (buffer.trim()) {
          try {
            handleEvent(JSON.parse(buffer.trim()));
          } catch {
            /* ignore */
          }
        }
        if (signal.aborted) throw new Error('运行时已停止，任务被中断');
        if (failure) throw failure;
        if (code !== 0) {
          throw new Error(`headless 退出码 ${String(code)}：${(stderr || stdout).trim().slice(-2000) || '无输出'}`);
        }
        const summary = (finalText ?? lastText ?? stdout).trim().slice(0, 18_000);
        if (!summary) throw new Error('headless 执行完成但没有输出文本');
        return { text: summary, sessionId };
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (child.exitCode === null) kill();
      }
    };

    hooks.progress('启动 DSH headless 执行器', {
      phase: 'spawn',
      profile: config.headlessProfile,
      mode: 'headless',
    });
    const result = await runTurn(buildTaskPrompt(input));
    const lastText = result.text;
    if (!lastText) throw new Error('headless 执行完成但没有输出文本');
    return { summary: lastText.slice(0, 18_000), sessionId: result.sessionId, ...extractMemoryItems(lastText) };
  };
}

/**
 * DSH 进程内执行器：每任务一个独立 Session，完成后写回摘要。
 * 服务全部从宿主 ctx 惰性获取，不 import harness bundle 包。
 */
export function createAgentExecutor(ctx: Context): TaskExecutor {
  return async (input, hooks, signal) => {
    const agents = ctx.get<AgentsService>('agents', false);
    const sessions = ctx.get<SessionsService>('sessions', false);
    const defaultModel = ctx.get<AgentDefaultModelService>('agentDefaultModel', false);
    const fs = ctx.get<FsService>('fs', false);
    const subagents = ctx.get<SubagentsService>('subagents', false);
    if (!agents || !sessions) {
      throw new Error('executionMode=agent 需要 DSH 的 agents/sessions 服务；当前宿主不可用，请改用 command 模式');
    }
    const selection = defaultModel?.currentSelection?.();
    const provider = input.config.provider || selection?.provider;
    const model = input.config.model || selection?.model;
    if (!provider || !model) throw new Error('无法确定模型：请在插件设置中填写 provider/model，或确认 agentDefaultModel 可用');
    const cwd = input.config.workspacePath || (fs ? fs.processPath(await fs.resolve('.')) : process.cwd());
    const sessionId = `session-hive-${input.task.task.id}-${randomUUID().slice(0, 8)}`;
    hooks.progress('创建 DSH 任务会话', { phase: 'create', sessionId });
    const { agent } = await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider, model },
    });
    const firstSeq = agent.session.seq;
    let agentError: unknown;
    const disposers: (() => void)[] = [];
    disposers.push(
      ctx.on('agent/error', (payload: { agent?: AgentLike; error?: unknown }) => {
        if (payload?.agent === agent) agentError = payload.error ?? new Error('Agent 执行失败');
      }),
    );
    disposers.push(
      ctx.on('session/event', (session: unknown, event: SessionEventLike) => {
        if (session !== agent.session) return;
        if (event.type === 'tool/call') {
          const name = event.data?.name ?? event.data?.toolName ?? 'tool';
          hooks.progress(`调用工具 ${String(name)}`, { phase: 'tool', tool: String(name) });
        }
      }),
    );
    const onAbort = () => {
      try {
        agent.cancel?.(new Error('Hive 运行时停止'));
      } catch {
        /* noop */
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const messageObject = (text: string) => ({
      id: randomUUID(),
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      source: { kind: 'user' as const },
    });

    const timeoutMs = input.config.maxTaskMinutes * 60_000;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error(`任务执行超过 ${input.config.maxTaskMinutes} 分钟，已取消`)), timeoutMs);
      timeoutTimer.unref?.();
    });
    try {
      hooks.progress('DSH 会话已就绪，开始执行', { phase: 'start', sessionId });
      agent.followup(messageObject(buildTaskPrompt(input)));
      await Promise.race([agent.whenIdle(), timeout]);
      while (subagents?.waitForChildren ? await subagents.waitForChildren(agent) : false) {
        await agent.whenIdle();
      }
      await sessions.flush(agent.session);
      if (signal.aborted) throw new Error('运行时已停止，任务被中断');
      if (agentError) throw agentError instanceof Error ? agentError : new Error(String(agentError));
      const summary = summarizeSession(agent.session, firstSeq);
      return { summary: summary.slice(0, 18_000), ...extractMemoryItems(summary) };
    } catch (error) {
      // 超时 / 宿主卸载 / 执行异常：取消仍在运行的 Agent，避免后台继续烧 token。
      try {
        agent.cancel?.(error);
      } catch {
        /* noop */
      }
      throw error;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbort);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* noop */
        }
      }
    }
  };
}

export function createExecutor(ctx: Context, config: HiveRuntimeConfig): TaskExecutor {
  if (config.executionMode === 'echo') return createEchoExecutor();
  if (config.executionMode === 'command') return createCommandExecutor();
  if (config.executionMode === 'agent') return createAgentExecutor(ctx);
  return createHeadlessExecutor();
}
