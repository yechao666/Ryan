import { Link, useNavigate } from 'react-router-dom';
import type { ActivityEvent, Agent, DashboardSummary, ProjectSummary } from '@shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  PageHead,
  SectionHead,
  Skeleton,
  Stat,
  type IconName,
  type Tone,
} from '@ui';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtInt, fmtRelative } from '../lib/format.ts';
import { activityMeta, errorText, useResource } from '../components/projects/helpers.tsx';
import { ProjectCard } from '../components/projects/index.tsx';
import { AgentListRow } from '../components/agents/index.tsx';

/** 概览页：可见项目、我的智员、任务与实例的总览与快捷入口。 */
export function DashboardPage() {
  const { person } = useAuth();
  const navigate = useNavigate();
  const { data, loading, error, status, reload } = useResource<DashboardSummary>(() => api.dashboard(), []);

  const displayName = data?.person.name ?? person?.name ?? '你好';

  return (
    <div className="page">
      <PageHead
        eyebrow="概览 · Overview"
        title={`${greeting()}，${displayName}`}
        desc={
          data
            ? `当前有 ${fmtInt(data.tasks.queued)} 个任务排队、${fmtInt(data.tasks.running)} 个正在执行，${onlineCount(data)} 个实例在线。`
            : '项目、智员、任务与实例的总览。'
        }
        actions={
          <>
            <IconButton icon="refresh" label="刷新概览" onClick={() => void reload()} />
            <Button variant="primary" icon="plus" onClick={() => navigate('/projects?new=1')}>
              新建项目
            </Button>
          </>
        }
      />

      {loading && !data ? (
        <DashboardSkeleton />
      ) : error && !data ? (
        <ErrorState message={errorText(status, error, '概览数据')} onRetry={() => void reload()} />
      ) : data ? (
        <>
          <div className="kpi-grid">
            <Stat
              label="可见项目"
              value={fmtInt(data.projects.length)}
              icon="folder"
              tone="violet"
              hint={`${fmtInt(data.teams.length)} 个团队`}
            />
            <Stat
              label="我的智员"
              value={fmtInt(data.agents.length)}
              icon="bot"
              tone="cyan"
              hint={`${fmtInt(data.agents.reduce((sum, agent) => sum + agent.stats.projects, 0))} 个项目绑定`}
            />
            <Stat
              label="执行中任务"
              value={fmtInt(data.tasks.running)}
              icon="zap"
              tone="amber"
              hint={`${fmtInt(data.tasks.queued)} 个排队 · ${fmtInt(data.tasks.waitingInput)} 个等待输入`}
            />
            <Stat
              label="在线实例"
              value={fmtInt(onlineCount(data))}
              unit={`/ ${fmtInt(data.instances.length)}`}
              icon="server"
              tone="green"
              hint={`离线 ${fmtInt(data.instances.length - onlineCount(data))} 个`}
            />
          </div>

          <div className="cx-dash-grid">
            <div className="cx-stack">
              <ProjectSection projects={data.projects} onOpen={(id) => navigate(`/projects/${id}`)} />
              <ActivitySection activity={data.activity} />
            </div>

            <div className="cx-stack">
              <AgentSection agents={data.agents} />
              <TaskSummary tasks={data.tasks} />
              <QuickLinks />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function onlineCount(data: DashboardSummary): number {
  return data.instances.filter((instance) => instance.status === 'online').length;
}

function ProjectSection({ projects, onOpen }: { projects: ProjectSummary[]; onOpen: (id: string) => void }) {
  return (
    <section className="cx-section">
      <SectionHead
        title="我的项目"
        desc={projects.length ? `共 ${projects.length} 个可见项目` : '按可见性展示你有权访问的项目'}
        actions={
          <Link className="btn btn-ghost btn-sm" to="/projects">
            全部项目
            <Icon name="arrowRight" size={13} />
          </Link>
        }
      />
      {projects.length === 0 ? (
        <Card>
          <EmptyState
            compact
            icon="folder"
            title="还没有可见项目"
            description="创建第一个项目，把智员加入项目并派发任务。"
            action={
              <Link to="/projects?new=1" className="btn btn-secondary btn-sm">
                新建项目
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="cx-project-grid">
          {projects.slice(0, 4).map((project) => (
            <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentSection({ agents }: { agents: Agent[] }) {
  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">
            <Icon name="bot" size={15} />
            我的智员
          </div>
          <div className="card-sub">共 {agents.length} 位数字员工</div>
        </div>
        <Link className="btn btn-ghost btn-sm" to="/agents">
          全部
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <div className="card-body">
        {agents.length ? (
          <div className="cx-row-list">
            {agents.slice(0, 5).map((agent) => (
              <Link key={agent.id} to={`/agents/${agent.id}`} className="cx-row-link">
                <AgentListRow agent={agent} />
              </Link>
            ))}
            {agents.length > 5 ? (
              <div className="tiny dim" style={{ padding: '8px 10px 0' }}>
                还有 {agents.length - 5} 位智员，前往智员页查看
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            compact
            icon="bot"
            title="还没有智员"
            description="创建智员后，可将其加入项目并绑定记忆身份。"
            action={
              <Link to="/agents?new=1" className="btn btn-secondary btn-sm">
                创建智员
              </Link>
            }
          />
        )}
      </div>
    </Card>
  );
}

function TaskSummary({ tasks }: { tasks: DashboardSummary['tasks'] }) {
  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">
            <Icon name="list" size={15} />
            任务摘要
          </div>
          <div className="card-sub">
            今日完成 {fmtInt(tasks.doneToday)} · 失败 {fmtInt(tasks.failedToday)}
          </div>
        </div>
        <Link className="btn btn-ghost btn-sm" to="/tasks">
          全部任务
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <div className="card-body">
        <div className="cx-metric-list">
          <MetricRow to="/tasks?status=queued" icon="clock" tone="slate" label="排队中" desc="等待实例领取" value={tasks.queued} />
          <MetricRow to="/tasks?status=running" icon="zap" tone="violet" label="执行中" desc="实例正在处理" value={tasks.running} />
          <MetricRow
            to="/tasks?status=waiting_input"
            icon="info"
            tone="amber"
            label="等待输入"
            desc="需要人工回复"
            value={tasks.waitingInput}
          />
        </div>
      </div>
    </Card>
  );
}

function MetricRow({
  to,
  icon,
  tone,
  label,
  desc,
  value,
}: {
  to: string;
  icon: IconName;
  tone: Tone;
  label: string;
  desc: string;
  value: number;
}) {
  return (
    <Link to={to} className={`cx-metric-row tone-${tone}`}>
      <span className="cx-metric-icon">
        <Icon name={icon} size={14} />
      </span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="cx-metric-label">{label}</span>
        <span className="cx-metric-desc">{desc}</span>
      </span>
      <span className="cx-metric-value">{fmtInt(value)}</span>
      <Icon name="chevronRight" size={13} className="dim" />
    </Link>
  );
}

function ActivitySection({ activity }: { activity: ActivityEvent[] }) {
  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">
            <Icon name="activity" size={15} />
            最近活动
          </div>
          <div className="card-sub">项目、任务与实例的实时事件</div>
        </div>
        <Badge size="sm" tone="slate">
          {activity.length} 条
        </Badge>
      </div>
      <div className="card-body">
        {activity.length ? (
          <div className="timeline">
            {activity.slice(0, 8).map((event) => {
              const meta = activityMeta(event.type);
              const target =
                event.taskId && event.projectId
                  ? `/projects/${event.projectId}/tasks/${event.taskId}`
                  : event.projectId
                    ? `/projects/${event.projectId}`
                    : null;
              const body = (
                <>
                  <div className="tl-title truncate">{event.summary}</div>
                  <div className="tl-time">
                    {event.projectName ? `${event.projectName} · ` : ''}
                    {event.actor ? `${event.actor} · ` : ''}
                    {fmtRelative(event.createdAt)}
                  </div>
                </>
              );
              return (
                <div className="tl-item" key={event.id}>
                  <span className={`tl-dot tone-${meta.tone}`}>
                    <Icon name={meta.icon} size={12} />
                  </span>
                  {target ? (
                    <Link to={target} className="tl-body">
                      {body}
                    </Link>
                  ) : (
                    <div className="tl-body">{body}</div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState compact icon="activity" title="暂无活动" description="创建项目或派发任务后，这里会显示实时动态。" />
        )}
      </div>
    </Card>
  );
}

function QuickLinks() {
  const links: { to: string; icon: IconName; tone: Tone; label: string }[] = [
    { to: '/projects?new=1', icon: 'plus', tone: 'violet', label: '新建项目' },
    { to: '/agents?new=1', icon: 'bot', tone: 'cyan', label: '创建智员' },
    { to: '/tasks', icon: 'list', tone: 'amber', label: '查看任务' },
    { to: '/instances', icon: 'server', tone: 'green', label: '注册实例' },
  ];
  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">
            <Icon name="command" size={15} />
            快捷入口
          </div>
          <div className="card-sub">常用操作一步直达</div>
        </div>
      </div>
      <div className="card-body">
        <div className="cx-quick-grid">
          {links.map((link) => (
            <Link key={link.to} to={link.to} className={`cx-quick tone-${link.tone}`}>
              <span className="cx-quick__icon">
                <Icon name={link.icon} size={14} />
              </span>
              <span>{link.label}</span>
              <Icon name="arrowRight" size={12} className="cx-quick__arrow" />
            </Link>
          ))}
        </div>
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="cx-stack" style={{ gap: 16 }}>
      <div className="kpi-grid">
        {[0, 1, 2, 3].map((item) => (
          <div className="kpi" key={item}>
            <Skeleton w="42%" h={11} />
            <div style={{ height: 14 }} />
            <Skeleton w="58%" h={24} />
            <div style={{ height: 10 }} />
            <Skeleton w="74%" h={10} />
          </div>
        ))}
      </div>
      <div className="cx-dash-grid">
        <div className="cx-stack">
          <div className="cx-project-grid">
            {[0, 1].map((item) => (
              <div className="card card-pad" key={item}>
                <Skeleton w={42} h={42} />
                <div style={{ height: 12 }} />
                <Skeleton h={13} />
                <div style={{ height: 8 }} />
                <Skeleton h={11} />
                <div style={{ height: 8 }} />
                <Skeleton h={52} />
              </div>
            ))}
          </div>
          <div className="card card-pad">
            <Skeleton w="30%" h={12} />
            <div style={{ height: 14 }} />
            {[0, 1, 2, 3].map((item) => (
              <div key={item} style={{ marginBottom: 12 }}>
                <Skeleton h={11} />
              </div>
            ))}
          </div>
        </div>
        <div className="card card-pad">
          <Skeleton w="34%" h={12} />
          <div style={{ height: 14 }} />
          {[0, 1, 2, 3].map((item) => (
            <div key={item} style={{ marginBottom: 12 }}>
              <Skeleton h={30} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
