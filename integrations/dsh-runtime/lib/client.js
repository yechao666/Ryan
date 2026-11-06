export class HiveApiError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.name = 'HiveApiError';
        this.status = status;
        this.code = code;
    }
}
export class HiveClient {
    resolve;
    constructor(resolve) {
        this.resolve = resolve;
    }
    async request(path, options = {}) {
        const config = this.resolve();
        const headers = { accept: 'application/json' };
        if (options.token)
            headers.authorization = `Bearer ${options.token}`;
        if (options.body !== undefined)
            headers['content-type'] = 'application/json';
        let response;
        try {
            response = await fetch(`${config.baseUrl}${path}`, {
                method: options.method ?? 'GET',
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new HiveApiError(0, 'NETWORK_ERROR', `无法连接 Hive（${config.baseUrl}）：${message}`);
        }
        if (response.status === 204)
            return undefined;
        const text = await response.text();
        let payload = null;
        if (text) {
            try {
                payload = JSON.parse(text);
            }
            catch {
                payload = text;
            }
        }
        if (!response.ok) {
            const body = payload;
            throw new HiveApiError(response.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? body?.message ?? `Hive 请求失败（${response.status}）`);
        }
        return payload;
    }
    register(agentToken, input) {
        return this.request('/api/runtime/instances/register', { method: 'POST', token: agentToken, body: input });
    }
    heartbeat(instanceToken) {
        return this.request('/api/runtime/instances/heartbeat', { method: 'POST', token: instanceToken });
    }
    claim(instanceToken) {
        return this.request('/api/runtime/tasks/claim', { method: 'POST', token: instanceToken });
    }
    progress(instanceToken, taskId, message, payload) {
        return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/progress`, {
            method: 'POST',
            token: instanceToken,
            body: { message, payload },
        });
    }
    sendMessage(instanceToken, taskId, content) {
        return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/messages`, {
            method: 'POST',
            token: instanceToken,
            body: { content },
        });
    }
    listMessages(instanceToken, taskId, since) {
        const query = since ? `?since=${encodeURIComponent(since)}` : '';
        return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/messages${query}`, { token: instanceToken });
    }
    complete(instanceToken, taskId, input) {
        return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/complete`, {
            method: 'POST',
            token: instanceToken,
            body: input,
            timeoutMs: 15_000,
        });
    }
    me(instanceToken) {
        return this.request('/api/runtime/me', { token: instanceToken });
    }
    /** 批量上报 DSH 运行时原始事件（实时日志）。 */
    appendRuntimeEvents(instanceToken, taskId, events) {
        return this.request(`/api/runtime/tasks/${encodeURIComponent(taskId)}/events`, {
            method: 'POST',
            token: instanceToken,
            body: { events },
        });
    }
    /** 直接读 Mnemos 的 `/v1/context`，失败返回 null（任务不应因记忆不可用而失败）。 */
    async fetchMemoryContext(memory, query, budgetTokens = 1200) {
        if (!memory?.enabled || !memory.baseUrl || !memory.apiKey)
            return null;
        try {
            const response = await fetch(`${memory.baseUrl.replace(/\/+$/, '')}/v1/context`, {
                method: 'POST',
                headers: { authorization: `Bearer ${memory.apiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify({ agent_id: memory.agentId, query, budget_tokens: budgetTokens }),
                signal: AbortSignal.timeout(4000),
            });
            if (!response.ok)
                return null;
            const payload = (await response.json());
            return typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt : null;
        }
        catch {
            return null;
        }
    }
}
