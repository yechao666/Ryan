import { Link, useNavigate } from 'react-router-dom';
import type { ActivityEvent, DashboardSummary, DshInstance, PromptCard, ProjectSummary } from '@shared';
import {
  ACTIVITY_LABELS,
  INSTANCE_KINDS,
  INSTANCE_STATUSES,
  PROMPT_CARD_CATEGORIES,
  PROMPT_CARD_SCOPES,
  PROJECT_TYPES,
  VISIBILITIES,
} from '@shared';
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
import { useAsync, useInterval } from '../lib/hooks.ts';

/**
 * Ryan 概览：项目、DSH 服务、提示卡与任务的总览。
 * 人员不再拥有「智员」，任务由人员 @Ryan 直接创建，由 DSH 服务领取执行。
 */
export function DashboardPage() {
  const { person } = useAuth();
  const navigate = useNavigate();
  const dashboard = useAsync(() => api.dashboard(), []);
  const promptCards = useAsync(() => api.promptCards(), []);
  useInterval(() => {
    void dashboard.refresh();
  }, 15_000);

  const data = dashboard.data;
  const displayName = data?.person.name ?? person?.name ?? '你好';
  const online = data ? data.instances.filter((instance) => instance.status === 'online').length : 0;

  return (
    <div className="page">
      <PageHead
        eyebrow="概览 · Overview"
        title={`${greeting()}，${displayName}`}
        desc={
          data
            ? `当前有 ${fmtInt(data.tasks.queued)} 个任务排队、${fmtInt(data.tasks.running)} 个正在执行，${fmtInt(online)} 个 DSH 服务在线。`
            : '项目、DSH 服务、提示卡与任务的总览。'
        }
        actions={
          <>
            <IconButton icon="refresh" label="刷新概览" onClick={() => void dashboard.refresh()} />
            <Button variant="primary" icon="plus" onClick={() => navigate('/projects?new=1')}>
              新建项目
            </Button>
          </>
        }
      />

      {dashboard.loading && !data ? (
        <DashboardSkeleton />
      ) : dashboard.error && !data ? (
        <ErrorState message={dashboard.error} onRetry={() => void dashboard.refresh()} />
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
              label="在线服务"
              value={fmtInt(online)}
              unit={`/ ${fmtInt(data.instances.length)}`}
              icon="server"
              tone="green"
              hint={`${fmtInt(data.instances.filter((item) => item.status === 'unconfigured').length)} 个待接入`}
            />
            <Stat
              label="执行中任务"
              value={fmtInt(data.tasks.running)}
              icon="zap"
              tone="amber"
              hint={`${fmtInt(data.tasks.queued)} 个排队 · ${fmtInt(data.tasks.waitingInput)} 个等待输入`}
            />
            <Stat
              label="提示卡"
              value={promptCards.loading ? '—' : fmtInt(promptCards.data?.length ?? 0)}
              icon="book"
              tone="cyan"
              hint="工作流 / 风格 / 标准 / 角色"
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
              gap: 16,
              alignItems: 'start',
            }}
          >
            <div className="cx-stack">
              <ProjectSection
                projects={data.projects}
                onOpen={(id) => navigate(`/projects/${encodeURIComponent(id)}`)}
              />
              <ActivitySection activity={data.activity} />
            </div>

            <div className="cx-stack">
              <InstancesSection instances={data.instances} />
              <PromptCardSection
                cards={promptCards.data ?? []}
                loading={promptCards.loading}
                error={promptCards.error}
                onRetry={() => void promptCards.refresh()}
              />
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

const TONES: Tone[] = ['violet', 'cyan', 'pink', 'amber', 'lime', 'blue'];

/** 从标识派生稳定的项目色块颜色。 */
function toneFor(seed: string): Tone {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  return TONES[hash % TONES.length] ?? 'violet';
}

function projectTypeMeta(type: ProjectSummary['type']) {
  return PROJECT_TYPES.find((item) => item.value === type) ?? { label: type, tone: 'slate' };
}

function visibilityMeta(visibility: ProjectSummary['visibility']) {
  return VISIBILITIES.find((item) => item.value === visibility) ?? { label: visibility, tone: 'slate' };
}

function instanceStatusMeta(status: DshInstance['status']) {
  return INSTANCE_STATUSES.find((item) => item.value === status) ?? { label: status, tone: 'slate' };
}

function instanceKindLabel(kind: DshInstance['kind']): string {
  return INSTANCE_KINDS.find((item) => item.value === kind)?.label ?? kind;
}

function promptCategoryMeta(category: PromptCard['category']) {
  return PROMPT_CARD_CATEGORIES.find((item) => item.value === category) ?? { label: category, tone: 'slate' };
}

function promptScopeLabel(card: PromptCard): string {
  const scope = PROMPT_CARD_SCOPES.find((item) => item.value === card.scope)?.label ?? card.scope;
  const target = card.scope === 'project' ? card.projectName : card.scope === 'team' ? card.teamName : undefined;
  return target ? `${scope} · ${target}` : scope;
}

const ACTIVITY_ICONS: Record<string, IconName> = {
  'task.created': 'plus',
  'task.claimed': 'server',
  'task.progress': 'activity',
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
  'task.created': 'blue',
  'task.claimed': 'violet',
  'task.progress': 'cyan',
  'task.completed': 'green',
  'task.failed': 'red',
  'task.cancelled': 'slate',
  'task.runtime': 'cyan',
  'instance.online': 'green',
  'instance.offline': 'slate',
  'instance.registered': 'violet',
  'project.created': 'violet',
};

function activityMeta(type: string): { icon: IconName; tone: Tone; label: string } {
  return {
    icon: ACTIVITY_ICONS[type] ?? 'activity',
    tone: ACTIVITY_TONES[type] ?? 'slate',
    label: ACTIVITY_LABELS[type] ?? type,
  };
}

function ProjectTile({ project, onOpen }: { project: ProjectSummary; onOpen: () => void }) {
  const tone = toneFor(project.id || project.slug || project.name);
  const type = projectTypeMeta(project.type);
  const visibility = visibilityMeta(project.visibility);
  const initial = (project.name.trim().slice(0, 1) || 'A').toUpperCase();
  const counts = project.counts;

  return (
    <article
      className="card card-hover project-card cx-project-card"
      role="button"
      tabIndex={0}
      aria-label={`打开项目 ${project.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="project-card-top">
        <div className={`project-mark tone-${tone}`} aria-hidden="true">
          {initial}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row-between" style={{ gap: 8 }}>
            <div className="project-name truncate">{project.name}</div>
            <Icon name="chevronRight" size={14} className="dim" />
          </div>
          <div className="project-slug truncate">{project.slug}</div>
        </div>
      </div>

      <p className="project-desc clamp-2">{project.description || '暂无项目描述'}</p>

      <div className="badge-dot-list">
        <Badge size="sm" tone={type.tone as Tone}>
          {type.label}
        </Badge>
        <Badge size="sm" tone={visibility.tone as Tone} dot>
          {visibility.label}
        </Badge>
        <span className="tiny dim truncate">{project.ownerTeamName ?? '个人项目'}</span>
      </div>

      <div className="project-metrics">
        <div>
          <div className="pm-value">{counts.promptCards}</div>
          <div className="pm-label">提示卡</div>
        </div>
        <div>
          <div className="pm-value">{counts.activeTasks}</div>
          <div className="pm-label">进行任务</div>
        </div>
        <div>
          <div className="pm-value">{counts.instances}</div>
          <div className="pm-label">DSH 服务</div>
        </div>
      </div>

      <div className="row-between cx-project-card__foot">
        <span className="tiny dim">
          成员 {counts.members} · 任务 {counts.tasks}
        </span>
        <span className="tiny dim" title={project.lastActivityAt ?? undefined}>
          最近活动 {fmtRelative(project.lastActivityAt)}
        </span>
      </div>
    </article>
  );
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
            description="创建第一个项目，把提示卡、DSH 服务与任务组织起来。"
            action={
              <Link to="/projects?new=1" className="btn btn-secondary btn-sm">
                新建项目
              </Link>
            }
          />
        </Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
            gap: 12,
          }}
        >
          {projects.slice(0, 4).map((project) => (
            <ProjectTile key={project.id} project={project} onOpen={() => onOpen(project.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function InstancesSection({ instances }: { instances: DshInstance[] }) {
  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">
            <Icon name="server" size={15} />
            DSH 服务
          </div>
          <div className="card-sub">
            {instances.filter((item) => item.status === 'online').length} 在线 · 共 {instances.length} 个
          </div>
        </div>
        <Link className="btn btn-ghost btn-sm" to="/instances">
          全部
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <div className="card-body">
        {instances.length ? (
          <div className="cx-row-list">
            {instances.slice(0, 5).map((instance) => {
              const status = instanceStatusMeta(instance.status);
              return (
                <Link key={instance.id} to="/instances" className="cx-row-link">
                  <div className="cx-agent-row">
                    <span className={`cx-metric-icon tone-${status.tone as Tone}`}>
                      <Icon name="server" size={14} />
                    </span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="cx-agent-row__name truncate">{instance.name}</div>
                      <div className="tiny dim truncate">
                        {instanceKindLabel(instance.kind)} · {instance.host || '未设置主机'}
                        {instance.port ? `:${instance.port}` : ''} ·{' '}
                        {instance.currentTask ? instance.currentTask.projectName : '空闲'}
                      </div>
                    </div>
                    <Badge size="sm" tone={status.tone as Tone} dot>
                      {status.label}
                    </Badge>
                  </div>
                </Link>
              );
            })}
            {instances.length > 5 ? (
              <div className="tiny dim" style={{ padding: '8px 10px 0' }}>
                还有 {instances.length - 5} 个服务，前往服务页查看
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            compact
            icon="server"
            title="还没有 DSH 服务"
            description="新增并接入 DSH 服务后，任务才会被领取执行。"
            action={
              <Link to="/instances?new=1" className="btn btn-secondary btn-sm">
                新增服务
              </Link>
            }
          />
        )}
      </div>
    </Card>
  );
}

function PromptCardSection({
  cards,
  loading,
  error,
  onRetry,
}: {
  cards: PromptCard[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <div className="card-head">
        <div>
          <div className="card-title">
            <Icon name="book" size={15} />
            提示卡
          </div>
          <div className="card-sub">{loading ? '正在加载…' : `共 ${cards.length} 张可复用卡片`}</div>
        </div>
        <Link className="btn btn-ghost btn-sm" to="/prompt-cards">
          全部
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <div className="card-body">
        {error ? (
          <div className="vstack" style={{ gap: 8, padding: '4px 0' }}>
            <div className="tiny muted">提示卡加载失败：{error}</div>
            <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : loading && !cards.length ? (
          <div className="stack" style={{ gap: 8 }}>
            {[0, 1, 2].map((item) => (
              <Skeleton key={item} h={32} />
            ))}
          </div>
        ) : cards.length ? (
          <div className="cx-row-list">
            {cards.slice(0, 5).map((card) => {
              const category = promptCategoryMeta(card.category);
              return (
                <Link key={card.id} to="/prompt-cards" className="cx-row-link">
                  <div className="cx-agent-row">
                    <span className={`cx-metric-icon tone-${category.tone as Tone}`}>
                      <Icon name="book" size={14} />
                    </span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="cx-agent-row__name truncate">{card.name}</div>
                      <div className="tiny dim truncate">
                        {category.label} · {promptScopeLabel(card)}
                      </div>
                    </div>
                    <Badge size="sm" tone={card.enabled ? 'green' : 'slate'} dot>
                      {card.enabled ? '启用' : '停用'}
                    </Badge>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <EmptyState
            compact
            icon="book"
            title="还没有提示卡"
            description="把工作流、风格、标准沉淀成卡片，任务引用后即可复用。"
            action={
              <Link to="/prompt-cards?new=1" className="btn btn-secondary btn-sm">
                新建卡片
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
          <MetricRow
            to="/tasks?status=queued"
            icon="clock"
            tone="slate"
            label="排队中"
            desc="等待 DSH 服务领取"
            value={tasks.queued}
          />
          <MetricRow
            to="/tasks?status=running"
            icon="zap"
            tone="violet"
            label="执行中"
            desc="DSH 服务正在处理"
            value={tasks.running}
          />
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
          <div className="card-sub">项目、任务与 DSH 服务的实时事件</div>
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
                  ? `/projects/${encodeURIComponent(event.projectId)}/tasks/${encodeURIComponent(event.taskId)}`
                  : event.projectId
                    ? `/projects/${encodeURIComponent(event.projectId)}`
                    : null;
              const body = (
                <>
                  <div className="tl-title truncate">{event.summary}</div>
                  <div className="tl-time">
                    {event.projectName ? `${event.projectName} · ` : ''}
                    {event.actor ? `${event.actor} · ` : ''}
                    {meta.label} · {fmtRelative(event.createdAt)}
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
    { to: '/instances?new=1', icon: 'server', tone: 'green', label: '新增服务' },
    { to: '/prompt-cards?new=1', icon: 'book', tone: 'cyan', label: '提示卡' },
    { to: '/tasks', icon: 'list', tone: 'amber', label: '查看任务' },
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
      <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
              gap: 16,
              alignItems: 'start',
            }}
          >
        <div className="cx-stack">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
              gap: 12,
            }}
          >
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
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} style={{ marginBottom: 12 }}>
              <Skeleton h={30} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
