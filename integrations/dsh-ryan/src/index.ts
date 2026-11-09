/**
 * dsh-ryan：用 Ryan 用户 API Key 把当前 DSH 接入 Ryan。
 *
 * 插件只负责注册服务与托管服务代理进程；任务领取、DSH 执行、
 * 进展/事件上报由随包携带的 agent 完成。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from './dsh-types.js';
import { Config, defaultStateFile, resolveConfig, RYAN_SETTINGS_NAMESPACE, type RawRyanPluginConfig, type RyanPluginConfig } from './config.js';

export const name = 'dsh-ryan';
export const inject: string[] = [];
export { Config, RYAN_SETTINGS_NAMESPACE, resolveConfig } from './config.js';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENT_ENTRY = join(PLUGIN_DIR, 'agent', 'agent.mjs');
const STATE_FILE = defaultStateFile();

interface State {
  instanceId?: string;
}

async function readState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State;
  } catch {
    return {};
  }
}

async function writeState(state: State): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(STATE_FILE, 0o600).catch(() => undefined);
}

function log(message: string, fields?: Record<string, unknown>): void {
  console.log(`[dsh-ryan] ${message}`, fields ?? '');
}

export function apply(ctx: Context, config?: RawRyanPluginConfig): void {
  let child: ChildProcess | null = null;
  let stopping = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let generation = 0;

  const current = (): RyanPluginConfig => resolveConfig(config);

  const stop = (): void => {
    stopping = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child && child.exitCode === null) child.kill('SIGTERM');
    child = null;
  };

  const scheduleRestart = (mine: number): void => {
    if (stopping || mine !== generation || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void start(mine);
    }, 5_000);
  };

  const start = async (mine: number): Promise<void> => {
    stopping = false;
    const cfg = current();
    if (mine !== generation) return;
    if (!cfg.enabled || !cfg.apiKey) {
      log('未启用或未配置 API Key');
      return;
    }
    try {
      const state = await readState();
      const response = await fetch(`${cfg.baseUrl}/api/runtime/instances/register-key`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          instanceId: state.instanceId,
          name: cfg.instanceName,
          kind: cfg.kind,
          host: cfg.host,
          workspacePath: cfg.workspaceRoot,
          workspaceRoot: cfg.workspaceRoot,
          pluginVersion: '0.1.0',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) as { instance?: { id?: string; name?: string }; token?: string; error?: { message?: string } } : {};
      if (!response.ok || !body.token || !body.instance?.id) {
        throw new Error(body.error?.message || `注册失败（${response.status}）`);
      }
      await writeState({ instanceId: body.instance.id });
      log(`服务已注册：${body.instance.name ?? cfg.instanceName}（${body.instance.id}）`);
      if (mine !== generation) return;
      await mkdir(cfg.workspaceRoot, { recursive: true });
      const args = [
        AGENT_ENTRY,
        '--base', cfg.baseUrl,
        '--token', body.token,
        '--workspace-root', cfg.workspaceRoot,
        '--workspace', cfg.workspaceRoot,
        '--name', cfg.instanceName,
        '--host', cfg.host,
      ];
      child = spawn(cfg.nodePath || 'node', args, {
        cwd: cfg.workspaceRoot,
        env: { ...process.env, AIWO_WORKSPACE_ROOT: cfg.workspaceRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[dsh-ryan-agent] ${chunk.toString()}`));
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[dsh-ryan-agent] ${chunk.toString()}`));
      child.on('exit', (code) => {
        log(`服务代理退出（${code ?? 'signal'}）`);
        child = null;
        scheduleRestart(mine);
      });
    } catch (error) {
      log('接入 Ryan 失败', { error: error instanceof Error ? error.message : String(error) });
      scheduleRestart(mine);
    }
  };

  let syncTimer: NodeJS.Timeout | null = null;
  const sync = (): void => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      const mine = ++generation;
      stop();
      void start(mine);
    }, 120);
  };

  ctx.effect(() => {
    sync();
    return () => stop();
  }, 'dsh-ryan: lifecycle');

  ctx.inject(['settings'], (sctx) => {
    try {
      const settings = sctx.get('settings', false) as { configure?: (options: { auto: boolean }, fiber: unknown) => void } | undefined;
      if (settings?.configure) {
        sctx.effect(() => settings.configure!({ auto: true }, ctx.fiber), 'dsh-ryan: settings form');
      }
      sctx.effect(
        () => sctx.on('settings/document-updated', (...args: unknown[]) => {
          if (String(args[0]) === RYAN_SETTINGS_NAMESPACE) sync();
        }),
        'dsh-ryan: settings subscription',
      );
    } catch (error) {
      log('设置服务不可用，仅按装配配置启动', { error: error instanceof Error ? error.message : String(error) });
    }
  });

  log('已加载');
}
