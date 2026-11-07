/**
 * 项目记忆“做梦”调度器：每 60 秒检查一次到期项目。
 * 增量：runDream 只处理 dreamed_at 为空的新记忆。
 */
import type { AppContext } from '../contracts.ts';
import { dueDreamProjects, runDream } from './dream.ts';

const TICK_MS = 60_000;
let currentTimer: NodeJS.Timeout | null = null;

export function startMemoryDreamScheduler(app: AppContext): () => void {
  if (currentTimer) return stop;
  if (process.env.AIWO_DREAM_SCHEDULER === '0') return () => {};
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const due = dueDreamProjects(app.db).slice(0, 5);
        for (const projectId of due) {
          const run = await runDream(app.db, projectId, 'schedule');
          if (run && run.status === 'completed') {
            console.log(`[aiwo] 项目 ${projectId} 做梦完成：${run.inputCount} 条新记忆 → ${run.insightCount} 条洞见`);
          }
        }
      } catch (error) {
        console.warn(`[aiwo] 做梦调度失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
      }
    })();
  };
  currentTimer = setInterval(tick, TICK_MS);
  currentTimer.unref?.();
  return stop;
}

function stop(): void {
  if (currentTimer) {
    clearInterval(currentTimer);
    currentTimer = null;
  }
}
