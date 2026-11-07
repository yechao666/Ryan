/**
 * Aiwo 运行时 HTTP 客户端。
 * 服务 token 只放在 Authorization 头里，绝不出现在日志/错误信息中。
 */
export class ApiError extends Error {
  constructor(status, code, message, requestId, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

const USER_AGENT = 'aiwo-instance/0.1';

export class AiwoApi {
  /**
   * @param {{baseUrl: string, token: string, timeoutMs?: number, logger?: import('./log.mjs').Logger}} options
   */
  constructor({ baseUrl, token, timeoutMs = 30_000, logger }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  async request(method, path, { body, timeoutMs = this.timeoutMs } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ApiError(
        0,
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        timedOut ? `请求 ${method} ${path} 超时（${timeoutMs}ms）` : `无法连接 Aiwo ${this.baseUrl}：${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
      );
    }

    if (response.status === 204) return null;

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const err = payload && typeof payload === 'object' ? payload.error : undefined;
      throw new ApiError(
        response.status,
        err?.code ?? 'HTTP_ERROR',
        err?.message ? String(err.message) : `Aiwo 返回 ${response.status}`,
        err?.requestId,
        payload,
      );
    }
    return payload;
  }

  /** 注册/更新服务资源信息（服务 token 鉴权）。 */
  register(payload) {
    return this.request('POST', '/api/runtime/instances/register', { body: payload });
  }

  heartbeat() {
    return this.request('POST', '/api/runtime/instances/heartbeat', { body: {}, timeoutMs: 15_000 });
  }

  /** 领取任务；无任务时服务端返回 204 → null。 */
  claim() {
    return this.request('POST', '/api/runtime/tasks/claim', { body: {}, timeoutMs: 20_000 });
  }

  /** 服务侧轮询任务状态，用于感知控制台取消。 */
  taskStatus(taskId) {
    return this.request('GET', `/api/runtime/tasks/${encodeURIComponent(taskId)}/status`, {
      timeoutMs: 10_000,
    });
  }

  progress(taskId, message, payload) {
    return this.request('POST', `/api/runtime/tasks/${encodeURIComponent(taskId)}/progress`, {
      body: { message, payload },
      timeoutMs: 15_000,
    });
  }

  /** 批量上报运行时事件（服务端每批最多 100 条）。 */
  postEvents(taskId, events) {
    return this.request('POST', `/api/runtime/tasks/${encodeURIComponent(taskId)}/events`, {
      body: { events },
      timeoutMs: 20_000,
    });
  }

  complete(taskId, input) {
    return this.request('POST', `/api/runtime/tasks/${encodeURIComponent(taskId)}/complete`, {
      body: input,
      timeoutMs: 30_000,
    });
  }
}
