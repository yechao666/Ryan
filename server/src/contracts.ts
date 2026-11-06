import type { DatabaseSync } from 'node:sqlite';
import type { Env } from './env.ts';
import type { EventBus } from './lib/bus.ts';

/** 服务运行期依赖：数据库、环境配置、SSE 事件总线。 */
export interface AppContext {
  db: DatabaseSync;
  env: Env;
  bus: EventBus;
  startedAt: string;
}
