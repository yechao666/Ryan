/**
 * 运行时主管：注册实例、心跳、claim、执行、上报。
 * 一个插件实例同一时刻只执行 1 个任务（Hive 侧也按实例限制 1 个 running）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HiveApiError, HiveClient } from './client.js';
import { createExecutor } from './executor.js';
export const RUNTIME_VERSION = '0.1.0';
const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16);
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export class HiveRuntime {
    ctx;
    resolve;
    client;
    logger;
    running = false;
    timer = null;
    heartbeatTimer = null;
    abortController = null;
    currentRun = null;
    state = null;
    currentTask = null;
    lastHeartbeatAt = null;
    registeredAt = null;
    stopped = true;
    constructor(ctx, resolve, client, logger) {
        this.ctx = ctx;
        this.resolve = resolve;
        this.client = client;
        this.logger = logger;
    }
    get instanceId() {
        return this.state?.instanceId ?? null;
    }
    get isRunning() {
        return this.running && !this.stopped;
    }
    snapshot() {
        return {
            running: this.isRunning,
            instanceId: this.state?.instanceId ?? null,
            baseUrl: this.state?.baseUrl ?? null,
            registeredAt: this.registeredAt,
            lastHeartbeatAt: this.lastHeartbeatAt,
            currentTask: this.currentTask
                ? { id: this.currentTask.task.id, title: this.currentTask.task.title }
                : null,
        };
    }
    async start() {
        if (this.running)
            return;
        const config = this.resolve();
        if (!config.enabled) {
            this.logger.info('dsh-hive-runtime 已禁用');
            return;
        }
        if (!config.agentToken.trim()) {
            this.logger.warn('dsh-hive-runtime 未配置 agentToken，跳过注册（设置 → 插件 → dsh-hive-runtime）');
            return;
        }
        this.running = true;
        this.stopped = false;
        await this.loadState();
        try {
            await this.ensureInstance();
        }
        catch (error) {
            this.logger.error('实例注册失败，将按退避重试', { error: errorMessage(error) });
            this.schedule(() => void this.ensureInstance().then(() => this.startLoops()).catch((err) => {
                this.logger.warn('重新注册失败', { error: errorMessage(err) });
                this.schedule(() => void this.ensureInstance().then(() => this.startLoops()), 10_000);
            }), 10_000);
            return;
        }
        this.startLoops();
    }
    async stop() {
        this.stopped = true;
        this.running = false;
        if (this.timer)
            clearTimeout(this.timer);
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.timer = null;
        this.heartbeatTimer = null;
        this.abortController?.abort();
        if (this.currentRun)
            await this.currentRun.catch(() => undefined);
        this.currentRun = null;
        this.currentTask = null;
    }
    // -------------------------------------------------------------------------
    // 注册 / 心跳
    // -------------------------------------------------------------------------
    async ensureInstance() {
        const config = this.resolve();
        const tokenPrint = fingerprint(config.agentToken);
        if (this.state &&
            this.state.baseUrl === config.baseUrl &&
            this.state.tokenFingerprint === tokenPrint) {
            try {
                await this.client.heartbeat(this.state.instanceToken);
                this.lastHeartbeatAt = new Date().toISOString();
                this.logger.info('复用已注册实例', { instanceId: this.state.instanceId });
                return;
            }
            catch (error) {
                if (!(error instanceof HiveApiError) || error.status !== 401)
                    throw error;
                this.logger.warn('实例令牌已失效，重新注册');
                this.state = null;
            }
        }
        const registered = await this.client.register(config.agentToken, {
            name: config.instanceName,
            host: config.host,
            workspacePath: config.workspacePath,
            version: `dsh-hive-runtime ${RUNTIME_VERSION}`,
        });
        this.state = {
            baseUrl: config.baseUrl,
            instanceId: registered.instance.id,
            instanceToken: registered.token,
            tokenFingerprint: tokenPrint,
        };
        this.registeredAt = new Date().toISOString();
        this.lastHeartbeatAt = new Date().toISOString();
        await this.saveState();
        this.logger.info('实例注册成功', { instanceId: registered.instance.id, name: config.instanceName });
    }
    startLoops() {
        if (this.stopped)
            return;
        const config = this.resolve();
        this.heartbeatTimer = setInterval(() => {
            void this.heartbeat();
        }, config.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
        this.schedule(() => void this.claimOnce(), 50);
    }
    async heartbeat() {
        if (!this.state || this.stopped)
            return;
        try {
            await this.client.heartbeat(this.state.instanceToken);
            this.lastHeartbeatAt = new Date().toISOString();
        }
        catch (error) {
            if (error instanceof HiveApiError && error.status === 401) {
                this.logger.warn('心跳 401，尝试重新注册');
                this.state = null;
                try {
                    await this.ensureInstance();
                }
                catch (renewError) {
                    this.logger.error('重新注册失败', { error: errorMessage(renewError) });
                }
            }
            else {
                this.logger.warn('心跳失败', { error: errorMessage(error) });
            }
        }
    }
    // -------------------------------------------------------------------------
    // claim / 执行 / 上报
    // -------------------------------------------------------------------------
    schedule(fn, delay) {
        if (this.stopped)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(fn, delay ?? this.resolve().pollIntervalMs);
        this.timer.unref?.();
    }
    async claimOnce() {
        if (this.stopped || !this.state)
            return;
        const config = this.resolve();
        if (!config.autoClaim) {
            this.schedule(() => void this.claimOnce());
            return;
        }
        if (this.currentRun) {
            this.schedule(() => void this.claimOnce());
            return;
        }
        try {
            const claimed = await this.client.claim(this.state.instanceToken);
            if (!claimed) {
                this.schedule(() => void this.claimOnce());
                return;
            }
            this.currentRun = this.runTask(claimed).finally(() => {
                this.currentRun = null;
            });
            // runTask 内部完成后会重新调度
        }
        catch (error) {
            if (error instanceof HiveApiError && error.status === 401) {
                this.logger.warn('claim 401，尝试重新注册');
                this.state = null;
                try {
                    await this.ensureInstance();
                }
                catch (renewError) {
                    this.logger.error('重新注册失败', { error: errorMessage(renewError) });
                }
            }
            else {
                this.logger.warn('claim 失败', { error: errorMessage(error) });
            }
            this.schedule(() => void this.claimOnce());
        }
    }
    // 任务为一次性 DSH goal：完成后不续聊，worker 不再查询 /conversations。
    async runTask(claimed) {
        const config = this.resolve();
        const runConfig = { ...config };
        this.currentTask = claimed;
        this.abortController = new AbortController();
        const { instanceToken } = this.state;
        const runtimeQueue = [];
        let runtimeTimer = null;
        const flushRuntime = async () => {
            if (runtimeTimer) {
                clearTimeout(runtimeTimer);
                runtimeTimer = null;
            }
            if (runtimeQueue.length === 0)
                return;
            const batch = runtimeQueue.splice(0, 100);
            try {
                await this.client.appendRuntimeEvents(instanceToken, claimed.task.id, batch);
            }
            catch (error) {
                this.logger.warn('上报运行时事件失败', { error: errorMessage(error) });
            }
        };
        this.logger.info('领取任务', { taskId: claimed.task.id, title: claimed.task.title, project: claimed.project.name });
        let lastProgressAt = 0;
        const hooks = {
            progress: (message, payload) => {
                const now = Date.now();
                // 工具调用类事件最多 2s 一条，避免刷爆控制台。
                if (now - lastProgressAt < 2000)
                    return;
                lastProgressAt = now;
                void this.client
                    .progress(instanceToken, claimed.task.id, message, payload)
                    .catch((error) => this.logger.warn('上报进展失败', { error: errorMessage(error) }));
            },
            log: (message, fields) => this.logger.info(message, fields),
            runtime: (event) => {
                runtimeQueue.push(event);
                if (runtimeQueue.length >= 20) {
                    void flushRuntime();
                }
                else if (!runtimeTimer) {
                    runtimeTimer = setTimeout(() => void flushRuntime(), 250);
                    runtimeTimer.unref?.();
                }
            },
        };
        let memoryBrief = null;
        if (runConfig.includeMemoryContext) {
            memoryBrief = await this.client.fetchMemoryContext(claimed.memory, `${claimed.task.title}\n${claimed.task.prompt.slice(0, 500)}`);
        }
        try {
            const executor = createExecutor(this.ctx, runConfig);
            const output = await executor({
                task: claimed,
                config: runConfig,
                memoryBrief,
            }, hooks, this.abortController.signal);
            if (this.stopped)
                return;
            await flushRuntime();
            await this.client.complete(instanceToken, claimed.task.id, {
                status: 'done',
                summary: output.summary,
                decisions: output.decisions,
                lessons: output.lessons,
                sessionId: output.sessionId,
            });
            this.logger.info('任务完成并上报', { taskId: claimed.task.id });
        }
        catch (error) {
            if (this.stopped)
                return;
            const message = errorMessage(error);
            this.logger.error('任务执行失败', { taskId: claimed.task.id, error: message });
            try {
                await this.client.complete(instanceToken, claimed.task.id, {
                    status: 'failed',
                    summary: '任务执行失败',
                    error: message.slice(0, 18_000),
                });
            }
            catch (reportError) {
                this.logger.error('失败状态上报失败', { taskId: claimed.task.id, error: errorMessage(reportError) });
            }
        }
        finally {
            await flushRuntime();
            this.currentTask = null;
            this.abortController = null;
            this.schedule(() => void this.claimOnce());
        }
    }
    // -------------------------------------------------------------------------
    // 持久化
    // -------------------------------------------------------------------------
    async loadState() {
        const config = this.resolve();
        try {
            const raw = await readFile(config.stateFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed.instanceId === 'string' &&
                typeof parsed.instanceToken === 'string' &&
                typeof parsed.baseUrl === 'string' &&
                typeof parsed.tokenFingerprint === 'string') {
                this.state = parsed;
            }
        }
        catch {
            this.state = null;
        }
    }
    async saveState() {
        if (!this.state)
            return;
        const config = this.resolve();
        try {
            await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 });
            const temp = `${config.stateFile}.tmp`;
            await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
            await rename(temp, config.stateFile);
            await chmod(config.stateFile, 0o600).catch(() => undefined);
        }
        catch (error) {
            this.logger.warn('实例状态写入失败（本次运行仍可用）', { error: errorMessage(error), path: config.stateFile });
        }
    }
}
