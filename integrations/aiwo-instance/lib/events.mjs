/**
 * 运行时事件批量上报：最多 100 条/批，1s 节流；失败保留队列并在下一轮重试。
 */

export class EventPump {
  constructor({ api, taskId, logger, intervalMs = 1_000, maxBatch = 100, maxQueue = 5_000 }) {
    this.api = api;
    this.taskId = taskId;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.maxBatch = maxBatch;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.total = 0;
    this.timer = null;
    this.sending = null;
    this.lastWarnAt = 0;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  push(type, payload = {}, at = new Date()) {
    const time = at instanceof Date ? at : new Date(at);
    this.queue.push({
      type,
      payload,
      at: Number.isNaN(time.getTime()) ? new Date().toISOString() : time.toISOString(),
    });
    this.total += 1;
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    if (this.queue.length >= this.maxBatch) void this.flush();
  }

  get count() {
    return this.total;
  }

  async flush() {
    if (this.sending) return this.sending;
    this.sending = this.drain().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  async drain() {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatch);
      try {
        await this.api.postEvents(this.taskId, batch);
      } catch (error) {
        this.queue.unshift(...batch);
        if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
        const now = Date.now();
        if (now - this.lastWarnAt > 5_000) {
          this.lastWarnAt = now;
          this.logger?.warn?.(`运行时事件上报失败（${this.queue.length} 条待重试）：${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
    }
  }

  /** 任务结束：停止定时器并尽力上报剩余事件。 */
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
