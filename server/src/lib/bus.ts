import type { LiveEvent } from '../../../shared/src/types.ts';

export type LiveEventListener = (event: LiveEvent) => void;

/** 进程内事件总线：控制台 SSE 实时流。 */
export class EventBus {
  private listeners = new Set<LiveEventListener>();
  private buffer: LiveEvent[] = [];
  private readonly bufferSize: number;

  constructor(bufferSize = 100) {
    this.bufferSize = bufferSize;
  }

  subscribe(listener: LiveEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: LiveEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
  }

  recent(limit = 30): LiveEvent[] {
    return this.buffer.slice(-limit).reverse();
  }

  get size(): number {
    return this.listeners.size;
  }
}
