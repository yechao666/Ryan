import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@lib/api.ts';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Callout,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  SectionHead,
  Skeleton,
  Stat,
} from '@ui';
import { ActivityFeed } from '../../components/project/ActivityFeed.tsx';
import { isActiveTask, priorityMeta, taskStatusMeta } from '../../components/project/meta.ts';
import { useProject } from '../ProjectLayout.tsx';

/** 项目概览：核心指标、正在工作的任务、最近任务、最近活动与记忆简报。 */
export function ProjectOverviewPage() {
  const { detail } = useProject();
  const navigate = useNavigate();
  const projectId = detail.project.id;
  const counts = detail.project.counts ?? { promptCards: 0, tasks: 0, activeTasks: 0, instances: 0, members: 0 };

  const tasks = useAsync(() => api.tasks({ projectId, limit: 60 }), [projectId]);
  const activity = useAsync(() => api.activity(projectId, 8), [projectId]);

  const taskList = tasks.data ?? [];
  const workingTasks = useMemo(
    () =>
      [...taskList]
        .filter((task) => task.status === 'running' || task.status === 'waiting_input')
        .sort((a, b) =>
          (b.lastMessageAt ?? b.startedAt ?? b.createdAt).localeCompare(
            a.lastMessageAt ?? a.startedAt ?? a.createdAt,
          ),
        ),
    [taskList],
  );
  const recentTasks = useMemo(
    () => [...taskList].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6),
    [taskList],
  );
  const queuedCount = taskList.filter((task) => isActiveTask(task.status) && task.status !== 'running').length;
  const waitingCount = taskList.filter((task) => task.status === 'waiting_input').length;

  const memoryAgentId = detail.project.memoryAgentId;
  const memoryBrief = useAsync(
    () => api.memoryBrief(projectId),
    [projectId],
    true,
  );

  const preview = useMemo(() => {
    const prompt = memoryBrief.data?.text ?? '';
    if (!prompt.trim()) return '';
    const lines = prompt.split('\n');
    return lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '');
  }, [memoryBrief.data]);

  const base = `/projects/${encodeURIComponent(projectId)}`;
  const openTask = (taskId: string) => navigate(`${base}/tasks/${encodeURIComponent(taskId)}`);

  return (
    <div className="ws-page">
      <div className="section-head">
        <div>
          <div className="section-title">
            <Icon name="dashboard" size={15} />
            项目概览
          </div>
          <div className="card-sub">实时掌握任务进展、DSH 服务与项目记忆状态。</div>
        </div>
        <div className="hstack gap-8">
          <Link className="ws-link small" to={`${base}/tasks`}>
            查看全部任务
            <Icon name="arrowRight" size={12} />
          </Link>
        </div>
      </div>

      <div className="kpi-grid">
        <Stat
          label="任务总数"
          value={fmtInt(counts.tasks)}
          icon="list"
          tone="violet"
          hint={`${queuedCount} 个排队中`}
        />
        <Stat
          label="正在工作"
          value={fmtInt(workingTasks.length)}
          icon="zap"
          tone="cyan"
          hint={waitingCount > 0 ? `${waitingCount} 个等待输入` : `${queuedCount} 个排队中`}
        />
        <Stat
          label="提示卡"
          value={fmtInt(counts.promptCards)}
          icon="book"
          tone="pink"
          hint="项目级提示卡"
        />
        <Stat
          label="DSH 服务"
          value={fmtInt(counts.instances)}
          icon="server"
          tone="green"
          hint="项目绑定、参与公平调度的服务"
        />
      </div>

      <div className="ws-overview-grid">
        <div className="ws-stack">
          <Card className="card-pad">
            <SectionHead
              title={
                <>
                  <Icon name="zap" size={14} />
                  正在工作
                </>
              }
              desc="执行中或等待人工输入的任务"
              actions={
                <Link className="ws-link small" to={`${base}/tasks`}>
                  任务看板
                  <Icon name="arrowRight" size={12} />
                </Link>
              }
            />
            <div className="mt-12">
              {tasks.loading && !tasks.data ? (
                <div className="vstack gap-8">
                  {[0, 1, 2].map((item) => (
                    <Skeleton key={item} h={48} style={{ borderRadius: 10 }} />
                  ))}
                </div>
              ) : tasks.error ? (
                <ErrorState message={tasks.error} onRetry={() => void tasks.refresh()} />
              ) : workingTasks.length === 0 ? (
                <EmptyState
                  icon="list"
                  title="当前没有正在执行的任务"
                  description="创建任务后，在线 DSH 服务会从共享调度池领取并交给 Aiwo 执行。"
                  action={
                    <Link className="btn btn-sm btn-outline" to={`${base}/tasks?new=1`}>
                      <Icon name="plus" size={13} />
                      新建任务
                    </Link>
                  }
                  compact
                />
              ) : (
                <div className="ws-working-list">
                  {workingTasks.map((task) => {
                    const status = taskStatusMeta(task.status);
                    const priority = priorityMeta(task.priority);
                    const at = task.lastMessageAt ?? task.startedAt ?? task.createdAt;
                    return (
                      <button
                        type="button"
                        key={task.id}
                        className="ws-working-row"
                        onClick={() => openTask(task.id)}
                      >
                        <span className={`ws-working-icon tone-${status.tone}`}>
                          <Icon name={status.icon} size={14} />
                        </span>
                        <span className="ws-working-main">
                          <span className="ws-working-title truncate">{task.title}</span>
                          <span className="tiny dim ws-working-sub">
                            {task.executorLabel || 'Aiwo'}
                            {task.instanceName ? ` · ${task.instanceName}` : ''} · {fmtRelative(at)}
                          </span>
                        </span>
                        <Badge tone={status.tone} size="sm" dot>
                          {status.label}
                        </Badge>
                        <Badge tone={priority.tone} size="sm">
                          {priority.label}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          <Card className="card-pad">
            <SectionHead
              title={
                <>
                  <Icon name="activity" size={14} />
                  最近活动
                </>
              }
              desc="项目内任务与服务的最新动态"
              actions={
                <Link className="ws-link small" to={`${base}/activity`}>
                  实时活动
                  <Icon name="arrowRight" size={12} />
                </Link>
              }
            />
            <div className="mt-12">
              <ActivityFeed
                events={activity.data ?? []}
                loading={activity.loading}
                error={activity.error}
                onRetry={() => void activity.refresh()}
                limit={8}
                showTaskLink
                projectId={projectId}
              />
            </div>
          </Card>
        </div>

        <div className="ws-stack">
          <Card className="card-pad">
            <SectionHead
              title={
                <>
                  <Icon name="list" size={14} />
                  最近任务
                </>
              }
              desc={`${taskList.length} 个任务，按创建时间倒序`}
              actions={
                <Link className="ws-link small" to={`${base}/tasks`}>
                  查看全部
                  <Icon name="arrowRight" size={12} />
                </Link>
              }
            />
            <div className="mt-12">
              {tasks.loading && !tasks.data ? (
                <div className="vstack gap-8">
                  {[0, 1].map((item) => (
                    <Skeleton key={item} h={44} style={{ borderRadius: 10 }} />
                  ))}
                </div>
              ) : tasks.error ? (
                <ErrorState message={tasks.error} onRetry={() => void tasks.refresh()} />
              ) : !recentTasks.length ? (
                <EmptyState
                  icon="list"
                  title="还没有任务"
                  description="创建第一个任务，由 DSH 服务交给 Aiwo 执行。"
                  action={
                    <Link className="btn btn-sm btn-outline" to={`${base}/tasks?new=1`}>
                      <Icon name="plus" size={13} />
                      新建任务
                    </Link>
                  }
                  compact
                />
              ) : (
                <div className="ws-working-list">
                  {recentTasks.map((task) => {
                    const status = taskStatusMeta(task.status);
                    return (
                      <button
                        type="button"
                        key={task.id}
                        className="ws-working-row"
                        onClick={() => openTask(task.id)}
                      >
                        <span className={`ws-working-icon tone-${status.tone}`}>
                          <Icon name={status.icon} size={14} />
                        </span>
                        <span className="ws-working-main">
                          <span className="ws-working-title truncate">{task.title}</span>
                          <span className="tiny dim ws-working-sub">
                            {task.executorLabel || 'Aiwo'}
                            {task.instanceName ? ` · ${task.instanceName}` : ''} · {fmtRelative(task.createdAt)}
                          </span>
                        </span>
                        <Badge tone={status.tone} size="sm" dot>
                          {status.label}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          <Card className="card-pad">
            <SectionHead
              title={
                <>
                  <Icon name="brain" size={14} />
                  记忆简报
                </>
              }
              desc="任务需要时通过工具检索的项目记忆"
              actions={
                <Link className="ws-link small" to={`${base}/memory`}>
                  记忆中心
                  <Icon name="arrowRight" size={12} />
                </Link>
              }
            />
            <div className="mt-12">
              {memoryBrief.loading && !memoryBrief.data ? (
                <Skeleton h={124} style={{ borderRadius: 10 }} />
              ) : memoryBrief.error ? (
                <ErrorState message={memoryBrief.error} onRetry={() => void memoryBrief.refresh()} />
              ) : memoryBrief.data ? (
                <>
                  <div className="tiny dim" style={{ marginBottom: 8 }}>
                    记忆身份{' '}
                    <span className="mono">{memoryAgentId || `aiwo_${detail.project.slug.replace(/-/g, '_')}`}</span>
                  </div>
                  <pre className="ws-mem-preview">{preview || '（当前没有可用的记忆上下文）'}</pre>
                  <div className="ws-mem-foot">
                    <span className="tiny dim">{memoryBrief.data.count} 条最近记忆 · 上限 {memoryBrief.data.maxChars} 字</span>
                    <div className="hstack gap-4">
                      <CopyButton value={memoryBrief.data.text} label="复制" />
                      <Link className="ws-link small" to={`${base}/memory`}>
                        查看完整
                        <Icon name="arrowRight" size={12} />
                      </Link>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
