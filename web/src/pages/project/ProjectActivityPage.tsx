import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEvent } from '@shared';
import { api } from '@lib/api.ts';
import {
  Button,
  Card,
  Dot,
  ErrorState,
  Icon,
  PageHead,
  Segmented,
} from '@ui';
import { ActivityFeed } from '../../components/project/ActivityFeed.tsx';
import {
  ACTIVITY_FILTERS,
  activityCategory,
  type ActivityFilter,
} from '../../components/project/meta.ts';
import { useProject } from '../ProjectLayout.tsx';

/** 项目实时活动：历史活动 + SSE 增量插入，支持类型筛选与自动滚动暂停。 */
export function ProjectActivityPage() {
  const { detail } = useProject();
  const projectId = detail.project.id;

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await api.activity(projectId, 50);
      setEvents(items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载活动失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 实时事件：去重后插入到列表顶部；暂停时只累计计数。
  useEffect(() => {
    const off = api.subscribeEvents((event) => {
      if (event.projectId && event.projectId !== projectId) return;
      // 运行时细粒度事件只在任务抽屉展示，避免刷屏项目活动流。
      if (event.type === 'task.runtime') return;
      const item: ActivityEvent = {
        id: event.id,
        projectId: event.projectId,
        projectName: event.projectName,
        type: event.type,
        actor: event.actor,
        summary: event.summary,
        taskId: event.taskId,
        createdAt: event.at,
      };
      setEvents((prev) => (prev.some((existing) => existing.id === item.id) ? prev : [item, ...prev].slice(0, 150)));
      setError(null);
      if (pausedRef.current) setPending((value) => value + 1);
    }, projectId);
    return off;
  }, [projectId]);

  // 未暂停时，新活动到达后回到顶部。
  useEffect(() => {
    if (paused) return;
    const element = scroller.current;
    if (element) element.scrollTop = 0;
  }, [events, paused]);

  const filtered = useMemo(
    () => events.filter((event) => filter === 'all' || activityCategory(event.type) === filter),
    [events, filter],
  );

  const resume = () => {
    setPaused(false);
    setPending(0);
    const element = scroller.current;
    if (element) element.scrollTop = 0;
  };

  const connectionTone = error ? 'red' : paused ? 'amber' : 'green';
  const connectionLabel = error ? '连接中断' : paused ? '已暂停' : '实时更新';

  return (
    <div className="ws-page">
      <PageHead
        title="实时活动"
        desc="任务、智能体与项目事件的实时流；新事件会自动插入顶部。"
        actions={
          <div className="hstack gap-8">
            <span className="ws-live-state">
              <Dot tone={connectionTone} pulse={!paused && !error} />
              {connectionLabel}
            </span>
            <Button variant="ghost" icon="refresh" onClick={() => void load()}>
              刷新
            </Button>
          </div>
        }
      />

      <div className="toolbar">
        <div className="toolbar-left">
          <Segmented options={ACTIVITY_FILTERS} value={filter} onChange={setFilter} />
          <span className="tiny dim">共 {filtered.length} 条</span>
        </div>
        <div className="toolbar-right">
          {paused && pending > 0 ? (
            <Button size="sm" variant="outline" icon="play" onClick={resume}>
              {pending} 条新活动 · 恢复自动滚动
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={paused ? 'outline' : 'ghost'}
            icon={paused ? 'play' : 'clock'}
            onClick={() => {
              if (paused) resume();
              else setPaused(true);
            }}
          >
            {paused ? '恢复自动滚动' : '暂停自动滚动'}
          </Button>
        </div>
      </div>

      {error && !events.length ? (
        <Card>
          <div style={{ padding: 18 }}>
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        </Card>
      ) : (
        <Card className="ws-activity-card">
          <div className="ws-activity-list" ref={scroller}>
            <ActivityFeed
              events={filtered}
              loading={loading}
              error={error}
              onRetry={() => void load()}
              showTaskLink
              projectId={projectId}
              emptyTitle={filter === 'all' ? '暂无活动' : '该类型暂无活动'}
              emptyDescription="任务创建、智能体接单、智能体上下线等事件会实时出现在这里。"
            />
          </div>
          <div className="ws-activity-footbar">
            <span className="tiny dim hstack gap-6">
              <Icon name="activity" size={12} />
              最多保留最近 150 条实时事件
            </span>
            <span className="tiny dim">连接状态：{connectionLabel}</span>
          </div>
        </Card>
      )}
    </div>
  );
}
