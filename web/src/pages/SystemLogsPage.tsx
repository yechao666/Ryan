import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ActivityEvent } from '@shared';
import { api } from '../lib/api.ts';
import { Button, Card, Dot, ErrorState, Icon, PageHead, Segmented, Select } from '@ui';
import { ActivityFeed } from '../components/project/ActivityFeed.tsx';
import { ACTIVITY_FILTERS, activityCategory, type ActivityFilter } from '../components/project/meta.ts';
import { useAsync } from '../lib/hooks.ts';

/** 系统日志：任务、智能体、运行时事件的全局只读审计流，不再作为项目业务页。 */
export function SystemLogsPage() {
  const [params, setParams] = useSearchParams();
  const projects = useAsync(() => api.projects(), []);
  const projectId = params.get('projectId') ?? '';
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
    setLoading(true); setError(null);
    try { setEvents(await api.activity(projectId || undefined, 100)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载系统日志失败'); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const off = api.subscribeEvents((event) => {
      if (projectId && event.projectId !== projectId) return;
      const item: ActivityEvent = {
        id: event.id, projectId: event.projectId, projectName: event.projectName,
        type: event.type, actor: event.actor, summary: event.summary,
        taskId: event.taskId, createdAt: event.at,
      };
      setEvents((prev) => prev.some((existing) => existing.id === item.id) ? prev : [item, ...prev].slice(0, 200));
      setError(null);
      if (pausedRef.current) setPending((value) => value + 1);
    }, projectId || undefined);
    return off;
  }, [projectId]);

  useEffect(() => { if (!paused && scroller.current) scroller.current.scrollTop = 0; }, [events, paused]);
  const filtered = useMemo(() => events.filter((event) => filter === 'all' || activityCategory(event.type) === filter), [events, filter]);
  const resume = () => { setPaused(false); setPending(0); if (scroller.current) scroller.current.scrollTop = 0; };
  const connectionTone = error ? 'red' : paused ? 'amber' : 'green';

  return (
    <div className="page">
      <PageHead
        title="系统日志"
        desc="任务、智能体和运行时事件的全局审计流。它是运行视图，不属于项目业务管理页；项目记录和复盘才是项目共享数据。"
        actions={<div className="hstack gap-8"><span className="ws-live-state"><Dot tone={connectionTone} pulse={!paused && !error} />{error ? '连接中断' : paused ? '已暂停' : '实时更新'}</span><Button variant="ghost" icon="refresh" onClick={() => void load()}>刷新</Button></div>}
      />
      <div className="toolbar">
        <div className="toolbar-left">
          <Select value={projectId} onChange={(event) => setParams(event.target.value ? { projectId: event.target.value } : {}, { replace: true })} options={[{ value: '', label: '全部项目' }, ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))]} />
          <Segmented options={ACTIVITY_FILTERS} value={filter} onChange={setFilter} />
          <span className="tiny dim">共 {filtered.length} 条</span>
        </div>
        <div className="toolbar-right">
          {paused && pending > 0 ? <Button size="sm" variant="outline" icon="play" onClick={resume}>{pending} 条新日志 · 恢复</Button> : null}
          <Button size="sm" variant={paused ? 'outline' : 'ghost'} icon={paused ? 'play' : 'clock'} onClick={() => paused ? resume() : setPaused(true)}>{paused ? '恢复自动滚动' : '暂停自动滚动'}</Button>
        </div>
      </div>
      {error && !events.length ? <Card><div style={{ padding: 18 }}><ErrorState message={error} onRetry={() => void load()} /></div></Card> : (
        <Card className="ws-activity-card"><div className="ws-activity-list" ref={scroller}><ActivityFeed events={filtered} loading={loading} error={error} onRetry={() => void load()} showTaskLink projectId={projectId || undefined} emptyTitle="暂无系统日志" emptyDescription="任务创建、领取、完成、失败和运行时事件会出现在这里。" /></div><div className="ws-activity-footbar"><span className="tiny dim hstack gap-6"><Icon name="activity" size={12} />最多保留最近 200 条事件</span><span className="tiny dim">运行视图 · 非项目业务页</span></div></Card>
      )}
    </div>
  );
}
