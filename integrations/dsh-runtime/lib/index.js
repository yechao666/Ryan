/**
 * dsh-hive-runtime：把当前 DSH 实例接入 Hive 数字员工平台。
 *
 * 职责：
 * 1. 用 Agent token 注册实例（实例 token 持久化，重启复用）；
 * 2. 定时心跳；
 * 3. 自动 claim 任务，在独立 DSH 会话中执行（executionMode=agent），
 *    或调用外部命令/回显（command/echo）；
 * 4. 上报进展、注入人工消息、回写完成/失败。
 *
 * 不 import 任何 harness bundle 包；所有宿主服务通过 ctx.get 惰性取得。
 */
import { hostname } from 'node:os';
import { Config, HIVE_RUNTIME_SETTINGS_NAMESPACE, resolveConfig, } from './config.js';
import { HiveClient } from './client.js';
import { HiveRuntime } from './runtime.js';
export const name = 'dsh-hive-runtime';
export const inject = [];
export { Config, HIVE_RUNTIME_SETTINGS_NAMESPACE, resolveConfig } from './config.js';
export { HiveRuntime } from './runtime.js';
export { HiveClient, HiveApiError } from './client.js';
export { buildTaskPrompt, createHeadlessExecutor, createAgentExecutor, createCommandExecutor, createEchoExecutor, createExecutor, extractMemoryItems, summarizeSession, } from './executor.js';
const SECTION_ORDER = 160;
export const HIVE_RUNTIME_GUIDANCE = '本 DSH 实例已接入 Hive 数字员工运行时（dsh-hive-runtime）：插件会在独立会话中自动领取并执行项目任务，' +
    '当前对话不需要手动接单。运行时配置在「设置 → 插件 → dsh-hive-runtime」；' +
    '任务与实例状态可在 Hive 控制台查看。遇到需要人工确认的任务，运行时会在结果中明确标注。';
function consoleLogger() {
    return {
        debug: (message, fields) => console.debug(`[dsh-hive-runtime] ${message}`, fields ?? ''),
        info: (message, fields) => console.log(`[dsh-hive-runtime] ${message}`, fields ?? ''),
        warn: (message, fields) => console.warn(`[dsh-hive-runtime] ${message}`, fields ?? ''),
        error: (message, fields) => console.error(`[dsh-hive-runtime] ${message}`, fields ?? ''),
    };
}
export function apply(ctx, config) {
    // headless 子进程会带这个 env；若 profile 误装插件，直接跳过，避免递归注册。
    if (process.env.DSH_HIVE_RUNTIME_DISABLED === '1')
        return;
    const resolve = () => resolveConfig(config ?? {});
    const logger = consoleLogger();
    const client = new HiveClient(resolve);
    const runtime = new HiveRuntime(ctx, resolve, client, logger);
    let generation = 0;
    const sync = async () => {
        const mine = ++generation;
        await runtime.stop();
        if (mine !== generation)
            return;
        const value = resolve();
        if (!value.enabled) {
            logger.info('dsh-hive-runtime 已禁用');
            return;
        }
        try {
            await runtime.start();
        }
        catch (error) {
            logger.error('dsh-hive-runtime 启动失败', { error: error instanceof Error ? error.message : String(error) });
        }
    };
    ctx.effect(() => {
        void sync();
        return () => {
            void runtime.stop();
        };
    }, 'dsh-hive-runtime: lifecycle');
    // 设置页：导出 Config + 自动表单；保存后重建运行时（token/模式变更即时生效）。
    ctx.inject(['settings'], (sctx) => {
        try {
            const settings = sctx.get('settings', false);
            if (settings?.configure) {
                sctx.effect(() => settings.configure({ auto: true }, ctx.fiber), 'dsh-hive-runtime: settings form');
            }
            sctx.effect(() => sctx.on('settings/document-updated', (...args) => {
                if (String(args[0]) === HIVE_RUNTIME_SETTINGS_NAMESPACE)
                    void sync();
            }), 'dsh-hive-runtime: settings subscription');
        }
        catch (error) {
            logger.warn('设置服务不可用，运行时仅按装配配置启动', { error: error instanceof Error ? error.message : String(error) });
        }
    });
    // 系统提示：告知当前 Agent 存在自动任务运行时（可关）。
    if (resolve().announceToAgent) {
        ctx.inject(['systemPrompt'], (sctx) => {
            try {
                const systemPrompt = sctx.get('systemPrompt', false);
                if (!systemPrompt)
                    return;
                sctx.effect(() => systemPrompt.section({
                    name: 'plugin:dsh-hive-runtime',
                    order: SECTION_ORDER,
                    text: HIVE_RUNTIME_GUIDANCE,
                }), 'dsh-hive-runtime: prompt section');
            }
            catch {
                /* 提示段失败不影响运行时 */
            }
        });
    }
    logger.info('dsh-hive-runtime 已加载', {
        host: hostname(),
        mode: resolve().executionMode,
        autoClaim: resolve().autoClaim,
    });
}
