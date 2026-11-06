import { useRef, useState } from 'react';
import type { EventType, InstanceStatus, TaskSource } from '@shared';
import { TASK_STATUSES } from '@shared';
import { Skeleton, type IconName, type Tone } from '@ui';
import { ApiError } from '../../lib/api.ts';
import { useAsync } from '../../lib/hooks.ts';

/**
 * 控制台核心页面共享的小工具。
 * 项目/团队/实例/任务页面都在此取色、取状态文案与错误态，避免各页重复。
 */

const TONES: Tone[] = ['violet', 'cyan', 'pink', 'amber', 'lime', 'blue'];

/** 从任意标识派生一个稳定的品牌色，用于头像 / 项目色块。 */
export function toneFor(seed: string): Tone {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  return TONES[hash % TONES.length] ?? 'violet';
}

/** 带 HTTP 状态码的 useAsync：页面据此区分 403 / 404。 */
export function useResource<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
  const [status, setStatus] = useState<number | null>(null);
  const generation = useRef(0);
  const state = useAsync(async () => {
    const mine = ++generation.current;
    try {
      const data = await fn();
      if (mine === generation.current) setStatus(null);
      return data;
    } catch (error) {
      if (mine === generation.current) setStatus(error instanceof ApiError ? error.status : null);
      throw error;
    }
  }, deps, enabled);
  return { ...state, status, reload: state.refresh };
}

/** 统一错误文案：403 / 404 给出可执行的中文提示。 */
export function errorText(status: number | null, error: string | null, subject: string): string {
  if (status === 403) return `需要项目/团队权限，无法访问${subject}。请联系组织管理员或相应负责人。`;
  if (status === 404) return `${subject}不存在，或已被删除。`;
  if (status === 401) return '登录状态已失效，请重新登录。';
  return error ?? '请求未成功，请稍后重试。';
}

/** 把 mutation 抛出的错误转成可展示的中文文案。 */
export function apiErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

/** 任务来源的展示元数据。 */
export const TASK_SOURCE_META: Record<TaskSource, { label: string; tone: Tone; icon: IconName }> = {
  human: { label: '人工', tone: 'violet', icon: 'user' },
  automation: { label: '自动化', tone: 'cyan', icon: 'zap' },
  webhook: { label: '仓库事件', tone: 'pink', icon: 'branch' },
  api: { label: 'API', tone: 'blue', icon: 'code' },
  seed: { label: '演示数据', tone: 'slate', icon: 'sparkles' },
};

/** 任务状态标签（复用 shared 常量）。 */
export function taskStatusMeta(status: string): { label: string; tone: Tone } {
  const meta = TASK_STATUSES.find((item) => item.value === status);
  return meta ? { label: meta.label, tone: meta.tone as Tone } : { label: status, tone: 'slate' };
}

/** 实例状态展示元数据。 */
export const INSTANCE_STATUS_META: Record<InstanceStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  online: { label: '在线', tone: 'green', pulse: true },
  offline: { label: '离线', tone: 'slate' },
  unconfigured: { label: '待安装插件', tone: 'amber' },
  error: { label: '异常', tone: 'red' },
  revoked: { label: '已吊销', tone: 'slate' },
};

export function instanceStatusMeta(status: string) {
  return INSTANCE_STATUS_META[status as InstanceStatus] ?? { label: status, tone: 'slate' as Tone };
}

/** 活动事件 → 图标 / 色调。 */
const ACTIVITY_META: Record<EventType, { icon: IconName; tone: Tone }> = {
  'task.created': { icon: 'plus', tone: 'blue' },
  'task.claimed': { icon: 'server', tone: 'violet' },
  'task.progress': { icon: 'activity', tone: 'cyan' },
  'task.completed': { icon: 'checkCircle', tone: 'green' },
  'task.failed': { icon: 'xCircle', tone: 'red' },
  'task.cancelled': { icon: 'x', tone: 'slate' },
  'task.runtime': { icon: 'terminal', tone: 'cyan' },
  'instance.online': { icon: 'server', tone: 'green' },
  'instance.offline': { icon: 'server', tone: 'slate' },
  'instance.registered': { icon: 'server', tone: 'violet' },
  'project.created': { icon: 'folder', tone: 'violet' },
};

export function activityMeta(type: string): { icon: IconName; tone: Tone } {
  return ACTIVITY_META[type as EventType] ?? { icon: 'activity', tone: 'slate' };
}

/** 卡片网格骨架屏，供各列表页加载态复用。 */
export function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid-cards">
      {Array.from({ length: count }, (_, index) => (
        <div className="card card-pad" key={index} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="hstack gap-12">
            <Skeleton w={38} h={38} />
            <div style={{ flex: 1 }}>
              <Skeleton w="62%" h={13} />
              <div style={{ height: 6 }} />
              <Skeleton w="42%" h={10} />
            </div>
          </div>
          <Skeleton h={11} />
          <Skeleton w="78%" h={11} />
          <Skeleton h={52} />
        </div>
      ))}
    </div>
  );
}

/** 表格卡片骨架屏。 */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} h={32} />
      ))}
    </div>
  );
}
