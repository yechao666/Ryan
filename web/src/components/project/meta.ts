import {
  ACTIVITY_LABELS,
  AUTOMATION_TRIGGERS,
  PROMPT_CARD_CATEGORIES,
  PROJECT_ROLES,
  PROJECT_TYPES,
  TASK_STATUSES,
  TASK_TYPES,
  VISIBILITIES,
} from '@shared';
import type { PromptCardCategory, TaskSource, TaskStatus, TaskType } from '@shared';
import type { IconName, Tone } from '@ui';

/* ================================================================== */
/* 任务状态 / 来源 / 优先级                                             */
/* ================================================================== */

const TASK_STATUS_ICONS: Record<TaskStatus, IconName> = {
  queued: 'clock',
  assigned: 'user',
  running: 'zap',
  waiting_input: 'info',
  done: 'checkCircle',
  failed: 'xCircle',
  cancelled: 'minus',
};

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: IconName;
}

/** 任务状态文案、色调与图标。 */
export const TASK_STATUS_META = Object.fromEntries(
  TASK_STATUSES.map((s) => [s.value, { label: s.label, tone: s.tone as Tone, icon: TASK_STATUS_ICONS[s.value] }]),
) as Record<TaskStatus, StatusMeta>;

export function taskStatusMeta(status: string): StatusMeta {
  return TASK_STATUS_META[status as TaskStatus] ?? { label: status, tone: 'slate', icon: 'info' };
}

export const TASK_SOURCE_LABELS: Record<TaskSource, string> = {
  human: '人工创建',
  automation: '自动化',
  webhook: '仓库事件',
  api: '接口调用',
  seed: '示例数据',
};

export function taskSourceLabel(source: string): string {
  return TASK_SOURCE_LABELS[source as TaskSource] ?? source;
}

/** 任务来源的展示元数据（文案 + 色调）。 */
const TASK_SOURCE_TONES: Record<string, Tone> = {
  human: 'violet',
  automation: 'cyan',
  webhook: 'pink',
  api: 'blue',
  seed: 'slate',
};

export function taskSourceMeta(source: string): { label: string; tone: Tone } {
  return { label: taskSourceLabel(source), tone: TASK_SOURCE_TONES[source] ?? 'slate' };
}

/* ------------------------------ 任务类型 ------------------------------ */

/** 类型缺失时的兜底类型（旧数据 / 旧后端）。 */
const DEFAULT_TASK_TYPE: TaskType = 'feature';

/** 任务类型 Badge 文案与色调；未知或缺失时回退到「需求」。 */
export function taskTypeMeta(type?: string): { label: string; tone: Tone } {
  const found = TASK_TYPES.find((item) => item.value === type);
  if (found) return { label: found.label, tone: found.tone as Tone };
  const fallback = TASK_TYPES.find((item) => item.value === DEFAULT_TASK_TYPE);
  return { label: fallback?.label ?? '需求', tone: (fallback?.tone as Tone | undefined) ?? 'violet' };
}

/** 类型筛选下拉：全部类型 + shared 中的任务类型。 */
export const TASK_TYPE_OPTIONS: { value: TaskType | 'all'; label: string }[] = [
  { value: 'all', label: '全部类型' },
  ...TASK_TYPES.map((item) => ({ value: item.value, label: item.label })),
];

/** 从 URL 参数解析类型筛选，非法值回退到 all。 */
export function parseTaskType(value: string | null | undefined): TaskType | 'all' {
  const found = TASK_TYPES.find((item) => item.value === value);
  return found ? found.value : 'all';
}

/* ------------------------------ 提示卡 ------------------------------ */

/** 提示卡分类的文案 / 色调 / 用途说明；未知分类回退到「其他」。 */
export function promptCardCategoryMeta(category?: string): { label: string; tone: Tone; desc: string } {
  const found = PROMPT_CARD_CATEGORIES.find((item) => item.value === category);
  if (found) return { label: found.label, tone: found.tone as Tone, desc: found.desc };
  const fallback = PROMPT_CARD_CATEGORIES.find((item) => item.value === 'other');
  return { label: fallback?.label ?? '其他', tone: (fallback?.tone as Tone | undefined) ?? 'slate', desc: fallback?.desc ?? '' };
}

/** 提示卡分类下拉（表单与筛选共用）。 */
export const PROMPT_CARD_CATEGORY_OPTIONS: { value: PromptCardCategory; label: string }[] = PROMPT_CARD_CATEGORIES.map(
  (item) => ({ value: item.value, label: item.label }),
);

export const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: '低' },
  { value: '2', label: '普通' },
  { value: '3', label: '高' },
  { value: '4', label: '紧急' },
];

export function priorityMeta(priority: number): { label: string; tone: Tone } {
  if (priority >= 4) return { label: '紧急', tone: 'red' };
  if (priority === 3) return { label: '高', tone: 'amber' };
  if (priority === 2) return { label: '普通', tone: 'slate' };
  return { label: '低', tone: 'slate' };
}

/** 任务是否处于进行中（需要关注）的状态。 */
export function isActiveTask(status: string): boolean {
  return status === 'queued' || status === 'assigned' || status === 'running' || status === 'waiting_input';
}

/* ================================================================== */
/* 活动事件                                                            */
/* ================================================================== */

export interface ActivityMeta {
  label: string;
  icon: IconName;
  tone: Tone;
}

const ACTIVITY_ICONS: Record<string, IconName> = {
  'task.created': 'plus',
  'task.claimed': 'server',
  'task.progress': 'activity',
  'task.message': 'send',
  'task.resumed': 'refresh',
  'task.completed': 'checkCircle',
  'task.failed': 'xCircle',
  'task.cancelled': 'x',
  'task.runtime': 'terminal',
  'instance.online': 'server',
  'instance.offline': 'server',
  'instance.registered': 'server',
  'project.created': 'folder',
};

const ACTIVITY_TONES: Record<string, Tone> = {
  'task.created': 'violet',
  'task.claimed': 'blue',
  'task.progress': 'cyan',
  'task.message': 'blue',
  'task.resumed': 'violet',
  'task.completed': 'green',
  'task.failed': 'red',
  'task.cancelled': 'slate',
  'task.runtime': 'cyan',
  'instance.online': 'green',
  'instance.offline': 'amber',
  'instance.registered': 'violet',
  'project.created': 'violet',
};

export function activityMeta(type: string): ActivityMeta {
  return {
    label: ACTIVITY_LABELS[type] ?? type,
    icon: ACTIVITY_ICONS[type] ?? 'info',
    tone: ACTIVITY_TONES[type] ?? 'slate',
  };
}

export type ActivityFilter = 'all' | 'task' | 'instance' | 'project';

export const ACTIVITY_FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'task', label: '任务' },
  { value: 'instance', label: '智能体' },
  { value: 'project', label: '项目' },
];

export function activityCategory(type: string): Exclude<ActivityFilter, 'all'> {
  if (type.startsWith('task.')) return 'task';
  if (type.startsWith('instance.')) return 'instance';
  return 'project';
}

/* ================================================================== */
/* 项目                                                               */
/* ================================================================== */

export function visibilityMeta(value: string): { label: string; tone: Tone; desc: string } {
  const found = VISIBILITIES.find((v) => v.value === value);
  return found
    ? { label: found.label, tone: found.tone as Tone, desc: found.desc }
    : { label: value, tone: 'slate', desc: '' };
}

export function projectTypeMeta(value: string): { label: string; tone: Tone } {
  const found = PROJECT_TYPES.find((t) => t.value === value);
  return found ? { label: found.label, tone: found.tone as Tone } : { label: value, tone: 'slate' };
}

export function projectRoleLabel(role: string): string {
  return PROJECT_ROLES.find((r) => r.value === role)?.label ?? role;
}

export const PROJECT_ROLE_OPTIONS = PROJECT_ROLES.map((role) => ({ value: role.value, label: role.label }));

/* ================================================================== */
/* 自动化 / Webhook                                                    */
/* ================================================================== */

const TRIGGER_TONES: Record<string, Tone> = {
  manual: 'slate',
  webhook: 'cyan',
  cron: 'violet',
};

export function automationTriggerMeta(value: string): { label: string; tone: Tone; desc: string } {
  const found = AUTOMATION_TRIGGERS.find((t) => t.value === value);
  return found
    ? { label: found.label, tone: TRIGGER_TONES[found.value] ?? 'slate', desc: found.desc }
    : { label: value, tone: 'slate', desc: '' };
}

/** 支持的仓库 Webhook 事件。 */
export const WEBHOOK_EVENTS: { value: string; label: string }[] = [
  { value: 'push', label: 'push' },
  { value: 'pull_request', label: 'pull_request' },
  { value: 'merge_request', label: 'merge_request' },
  { value: 'issues', label: 'issues' },
  { value: 'note', label: 'note' },
];

/** 提示词模板支持的占位符。 */
export const PROMPT_PLACEHOLDERS = ['{{project}}', '{{event}}', '{{title}}', '{{url}}', '{{actor}}', '{{branch}}'];

const RUN_STATUS_TONES: Record<string, Tone> = {
  success: 'green',
  succeeded: 'green',
  ok: 'green',
  failed: 'red',
  error: 'red',
  running: 'cyan',
  queued: 'slate',
};

export function runStatusMeta(status?: string): { label: string; tone: Tone } | null {
  if (!status) return null;
  const labels: Record<string, string> = {
    success: '成功',
    failed: '失败',
    running: '执行中',
    queued: '排队中',
    skipped: '已跳过',
  };
  return { label: labels[status] ?? status, tone: RUN_STATUS_TONES[status] ?? 'slate' };
}

/** 入站投递状态。 */
export const DELIVERY_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  accepted: { label: '已接收', tone: 'green' },
  ignored: { label: '已忽略', tone: 'slate' },
  duplicate: { label: '重复', tone: 'amber' },
  rejected: { label: '已拒绝', tone: 'red' },
  failed: { label: '失败', tone: 'red' },
};

export function deliveryStatusMeta(status: string): { label: string; tone: Tone } {
  return DELIVERY_STATUS_META[status] ?? { label: status, tone: 'slate' };
}

/** Webhook 事件集合展示文案。 */
export function webhookEventLabel(event: string): string {
  return WEBHOOK_EVENTS.find((e) => e.value === event)?.label ?? event;
}

/* ================================================================== */
/* 运行时长 / 开始时间筛选                                              */
/* ================================================================== */

export type DurationFilter = 'all' | 'lt1m' | 'm1to10' | 'm10to60' | 'gt60m';
export type StartedFilter = 'all' | 'today' | '7d' | '30d';

export const DURATION_FILTER_OPTIONS: { value: DurationFilter; label: string }[] = [
  { value: 'all', label: '全部时长' },
  { value: 'lt1m', label: '小于 1 分钟' },
  { value: 'm1to10', label: '1–10 分钟' },
  { value: 'm10to60', label: '10–60 分钟' },
  { value: 'gt60m', label: '超过 1 小时' },
];

export const STARTED_FILTER_OPTIONS: { value: StartedFilter; label: string }[] = [
  { value: 'all', label: '全部开始时间' },
  { value: 'today', label: '今天开始' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

export function parseDurationFilter(value: string | null): DurationFilter {
  return DURATION_FILTER_OPTIONS.some((item) => item.value === value) ? (value as DurationFilter) : 'all';
}

export function parseStartedFilter(value: string | null): StartedFilter {
  return STARTED_FILTER_OPTIONS.some((item) => item.value === value) ? (value as StartedFilter) : 'all';
}

/** 任务运行时长 ms；queued 返回 null，运行中按当前时刻算。 */
export function taskDurationMs(task: { startedAt?: string | null; finishedAt?: string | null }): number | null {
  if (!task.startedAt) return null;
  const start = Date.parse(task.startedAt);
  if (Number.isNaN(start)) return null;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

export function matchesDuration(task: { startedAt?: string | null; finishedAt?: string | null }, filter: DurationFilter): boolean {
  if (filter === 'all') return true;
  const ms = taskDurationMs(task);
  if (ms === null) return false;
  const minute = 60_000;
  if (filter === 'lt1m') return ms < minute;
  if (filter === 'm1to10') return ms >= minute && ms < 10 * minute;
  if (filter === 'm10to60') return ms >= 10 * minute && ms < 60 * minute;
  return ms >= 60 * minute;
}

export function matchesStarted(task: { startedAt?: string | null }, filter: StartedFilter): boolean {
  if (filter === 'all') return true;
  if (!task.startedAt) return false;
  const start = Date.parse(task.startedAt);
  if (Number.isNaN(start)) return false;
  if (filter === 'today') {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return start >= today;
  }
  const days = filter === '7d' ? 7 : 30;
  return start >= Date.now() - days * 86_400_000;
}
