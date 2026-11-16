import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import type { ProjectDetail } from '@lib/api.ts';
import { api, ApiError } from '@lib/api.ts';
import { Avatar, Badge, Button, ErrorState, Icon, Skeleton } from '@ui';
import { projectTypeMeta, visibilityMeta } from '../components/project/meta.ts';
import type { ProjectOutletContext } from '../components/project/context.ts';
import { useProject } from '../components/project/context.ts';

export type { ProjectOutletContext } from '../components/project/context.ts';
export { useProject } from '../components/project/context.ts';

/** 头部标签页配置。 */
interface TabItem {
  to: string;
  label: string;
  end?: boolean;
  count?: number;
  groupStart?: boolean;
  groupLabel?: string;
}

function ProjectSkeleton() {
  return (
    <div className="page ws-project">
      <Skeleton w={168} h={12} />
      <div className="hstack gap-16">
        <Skeleton w={54} h={54} style={{ borderRadius: 15 }} />
        <div className="vstack gap-8 grow">
          <Skeleton w={240} h={24} />
          <Skeleton w={320} h={12} />
          <Skeleton w={260} h={12} />
        </div>
        <Skeleton w={112} h={36} />
      </div>
      <Skeleton h={38} />
      <div className="kpi-grid">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} h={96} style={{ borderRadius: 16 }} />
        ))}
      </div>
      <Skeleton h={220} style={{ borderRadius: 16 }} />
    </div>
  );
}

/** 错误页：区分 403 / 404。 */
function ProjectError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const message =
    status === 403
      ? '你没有访问该项目的权限，请联系项目负责人申请加入。'
      : status === 404
        ? '项目不存在或已被删除，请返回项目列表重新选择。'
        : error instanceof Error
          ? error.message
          : '加载项目详情失败，请稍后重试。';
  return (
    <div className="page">
      <ErrorState message={message} onRetry={onRetry} />
    </div>
  );
}

/**
 * 项目工作区骨架：加载项目详情，渲染面包屑、项目头与页签，并向子页面注入
 * `{ detail, reload }` 上下文。
 */
export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async (): Promise<ProjectDetail | null> => {
    if (!projectId) return null;
    try {
      const next = await api.project(projectId);
      setDetail(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setDetail(null);
    setError(null);
    api
      .project(projectId ?? '')
      .then((next) => {
        if (!active) return;
        setDetail(next);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  if (!projectId) {
    return (
      <div className="page">
        <ErrorState message="缺少项目标识，无法加载项目工作区。" />
      </div>
    );
  }

  if (loading && !detail) return <ProjectSkeleton />;
  if (!detail) return <ProjectError error={error} onRetry={() => void reload()} />;

  const { project, team } = detail;
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const counts = project.counts ?? { promptCards: 0, tasks: 0, activeTasks: 0, instances: 0, members: 0 };
  const visibility = visibilityMeta(project.visibility);
  const type = projectTypeMeta(project.type);
  const teamName = project.ownerTeamName ?? team?.name;
  const tabs: TabItem[] = [
    { to: base, label: '概览', end: true, groupStart: true, groupLabel: '业务' },
    { to: `${base}/tasks`, label: '任务', count: counts.tasks || undefined },
    { to: `${base}/context`, label: '项目背景', groupStart: true },
    { to: `${base}/memory`, label: '记忆' },
    { to: `${base}/records`, label: '项目记录' },
    ...(detail.project.reportSettings.enabled ? [{ to: `${base}/retrospective`, label: '复盘总结' }] : []),
    { to: `${base}/prompt-cards`, label: '提示卡', count: counts.promptCards || undefined },
    { to: `${base}/services`, label: '智能体', count: counts.instances || undefined },
    { to: `${base}/wecom-bot`, label: '企微机器人' },
    { to: `${base}/automations`, label: '自动化' },
    { to: `${base}/members`, label: '成员', count: counts.members || undefined, groupStart: true, groupLabel: '管理' },
    { to: `${base}/settings`, label: '设置' },
  ];
  const context: ProjectOutletContext = { detail, reload };

  return (
    <div className="page ws-project">
      <div className="ws-crumbs">
        <Link to="/projects" className="crumb">
          <Icon name="folder" size={13} />
          项目
        </Link>
        <span className="crumb-sep">/</span>
        <span className="ws-crumb-current truncate">{project.name}</span>
      </div>

      <div className="ws-project-head">
        <div className="ws-project-mark" title={project.name}>
          {project.name.trim().slice(0, 1) || 'P'}
        </div>
        <div className="ws-project-head-main">
          <div className="ws-project-title-row">
            <h1 className="ws-project-title truncate">{project.name}</h1>
            <Badge tone={visibility.tone} size="sm">
              {visibility.label}
            </Badge>
            <Badge tone={type.tone} size="sm">
              {type.label}
            </Badge>
            {project.status === 'archived' ? (
              <Badge tone="slate" size="sm">
                已归档
              </Badge>
            ) : null}
          </div>
          {project.description ? <p className="ws-project-desc">{project.description}</p> : null}
          <div className="ws-project-meta">
            <span className="ws-project-meta-item">
              <Icon name="users" size={13} />
              {project.ownerTeamId && teamName ? (
                <Link to={`/teams/${encodeURIComponent(project.ownerTeamId)}`} className="ws-link">
                  {teamName}
                </Link>
              ) : (
                <span>{teamName ?? '未归属团队'}</span>
              )}
            </span>
            <span className="ws-project-meta-item">
              <Icon name="user" size={13} />
              <Avatar name={project.ownerPersonName || '未知'} tone="violet" size="sm" />
              <span>{project.ownerPersonName || '未知负责人'}</span>
            </span>
            <span className="ws-project-meta-item mono tiny">
              <Icon name="tag" size={13} />
              {project.slug}
            </span>
            <span className="ws-project-meta-item">
              <Icon name="book" size={13} />
              {counts.promptCards} 提示卡
            </span>
            <span className="ws-project-meta-item">
              <Icon name="server" size={13} />
              绑定智能体 {counts.instances}
            </span>
            {project.repoUrl ? (
              <a className="ws-project-meta-item ws-link" href={project.repoUrl} target="_blank" rel="noreferrer">
                <Icon name="external" size={13} />
                仓库地址
              </a>
            ) : null}
          </div>
        </div>
        <div className="ws-project-actions">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => navigate(`${base}/tasks?new=1`)}
          >
            新建任务
          </Button>
        </div>
      </div>

      <div className="ws-workspace">
        <nav className="tabs ws-tabs ws-side-nav" aria-label="项目页签">
          {tabs.map((tab) => (
            <Fragment key={tab.to}>
              {tab.groupStart ? <span className={`ws-tab-group${tab.groupLabel ? ' with-label' : ''}`}>{tab.groupLabel}</span> : null}
              <NavLink
                to={tab.to}
                end={tab.end}
                className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
              >
                {tab.label}
                {typeof tab.count === 'number' ? <span className="tab-count">{tab.count}</span> : null}
              </NavLink>
            </Fragment>
          ))}
        </nav>

        <div className="ws-workspace-content">
          <Outlet context={context} />
        </div>
      </div>
    </div>
  );
}
