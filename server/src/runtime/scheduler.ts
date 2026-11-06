/**
 * 自动化调度器：每 30s 检查 enabled 的 cron 自动化并到点触发。
 *
 * 规则：
 * - 5 段 cron（分 时 日 月 周），非法表达式直接跳过；
 * - 同一分钟只触发一次（用 last_run_at 的本地分钟键判断，启动时不立即触发）；
 * - 触发 = 创建 source=automation 任务 + automation_runs + 更新 last_run_at/status。
 */
import type { AppContext } from '../contracts.ts';
import { matchesCronFields, parseCron, type CronFields } from './cron.ts';
import {
  AUTOMATION_SELECT,
  createAutomationTask,
  parseTriggerConfig,
  type AutomationRow,
} from '../http/routes/automations.ts';

const TICK_MS = 30_000;
const ACTOR = '定时调度';

let currentTimer: NodeJS.Timeout | null = null;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时区的分钟键，例如 2026-11-06T09:05。 */
function minuteKeyOf(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

function firedThisMinute(lastRunAt: string | null, now: Date): boolean {
  if (!lastRunAt) return false;
  const last = new Date(lastRunAt);
  if (Number.isNaN(last.getTime())) return false;
  return minuteKeyOf(last) === minuteKeyOf(now);
}

/** 执行一轮检查，返回本轮触发的自动化数量（导出便于集成测试 / 手动触发）。 */
export function runDueAutomations(app: AppContext, now: Date = new Date()): number {
  const rows = app.db
    .prepare(`${AUTOMATION_SELECT} WHERE a.enabled = 1 AND a.trigger_type = 'cron'`)
    .all() as unknown as AutomationRow[];

  let triggered = 0;
  for (const row of rows) {
    const config = parseTriggerConfig(row.trigger_config);
    const schedule = config.schedule;
    if (!schedule) continue;

    let fields: CronFields;
    try {
      fields = parseCron(schedule);
    } catch {
      // 非法 cron 表达式：跳过，不影响其他自动化。
      continue;
    }
    if (!matchesCronFields(fields, now)) continue;
    if (firedThisMinute(row.last_run_at, now)) continue;

    try {
      createAutomationTask(app.db, app.bus, row, {
        trigger: 'cron',
        actorName: ACTOR,
        createdBy: row.created_by ?? null,
        at: now.toISOString(),
        variables: {
          project: row.project_name ?? '',
          event: 'schedule',
          title: row.name,
          url: '',
          actor: ACTOR,
          branch: config.branch ?? '',
        },
      });
      triggered += 1;
    } catch (error) {
      console.warn(
        `[hive] 定时自动化 ${row.id} 触发失败：${error instanceof Error ? error.message : String(error)}`,
      );
      // 记录失败并占用本分钟，避免每 30s 重复重试。
      const at = now.toISOString();
      app.db
        .prepare("UPDATE automations SET last_run_at = ?, last_run_status = 'failed', updated_at = ? WHERE id = ?")
        .run(at, at, row.id);
    }
  }
  return triggered;
}

function stopScheduler(): void {
  if (currentTimer) {
    clearInterval(currentTimer);
    currentTimer = null;
  }
}

/**
 * 启动调度器（由 main.ts 接线）。返回停止函数；重复调用不会重复启动。
 * 注意：启动时不立即执行，第一轮在 30s 后。
 */
export function startAutomationScheduler(app: AppContext): () => void {
  if (currentTimer) return stopScheduler;

  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    try {
      runDueAutomations(app);
    } catch (error) {
      console.warn(
        `[hive] 自动化调度器执行失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      busy = false;
    }
  };

  currentTimer = setInterval(tick, TICK_MS);
  currentTimer.unref?.();
  return stopScheduler;
}
