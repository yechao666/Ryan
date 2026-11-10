import { Link } from 'react-router-dom';
import type { ActivityEvent } from '@shared';
import { Badge, EmptyState, ErrorState, Icon, Skeleton } from '@ui';
import { fmtRelative } from '@lib/format.ts';
import { activityMeta } from './meta.ts';

export interface ActivityFeedProps {
  events: ActivityEvent[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** 仅展示前 N 条（概览页使用）。 */
  limit?: number;
  /** 是否显示任务跳转链接。 */
  showTaskLink?: boolean;
  /** 链接到任务页时使用的项目 ID（缺省时回退到事件自身的 projectId）。 */
  projectId?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

/** 活动时间线：图标 + 摘要 + 操作人 + 相对时间。 */
export function ActivityFeed({
  events,
  loading,
  error,
  onRetry,
  limit,
  showTaskLink = false,
  projectId,
  emptyTitle = '暂无活动',
  emptyDescription = '当项目内创建任务、智能体接单或智能体上下线时，这里会出现实时记录。',
}: ActivityFeedProps) {
  const items = typeof limit === 'number' ? events.slice(0, limit) : events;

  if (loading && !events.length) {
    return (
      <div className="vstack gap-10">
        {[0, 1, 2, 3].map((i) => (
          <div className="hstack gap-10" key={i}>
            <Skeleton w={23} h={23} style={{ borderRadius: 8 }} />
            <div className="vstack gap-6 grow">
              <Skeleton w="70%" h={11} />
              <Skeleton w="40%" h={9} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error && !events.length) return <ErrorState message={error} onRetry={onRetry} />;

  if (!items.length) {
    return <EmptyState icon="activity" title={emptyTitle} description={emptyDescription} compact />;
  }

  return (
    <div className="timeline ws-activity-feed">
      {items.map((event) => {
        const meta = activityMeta(event.type);
        return (
          <div className="tl-item" key={event.id}>
            <span className={`tl-dot tone-${meta.tone}`}>
              <Icon name={meta.icon} size={13} />
            </span>
            <div className="tl-body">
              <div className="ws-activity-head">
                <span className="tl-title">
                  <strong>{event.summary}</strong>
                </span>
                <Badge tone={meta.tone} size="sm">
                  {meta.label}
                </Badge>
              </div>
              <div className="tl-time ws-activity-foot">
                <span className="hstack gap-4">
                  <Icon name="user" size={11} />
                  {event.actor}
                </span>
                <span>{fmtRelative(event.createdAt)}</span>
                {showTaskLink && event.taskId ? (
                  <Link
                    to={`/projects/${encodeURIComponent(projectId ?? event.projectId ?? '')}/tasks/${encodeURIComponent(event.taskId)}`}
                    className="ws-task-link"
                  >
                    打开任务
                    <Icon name="arrowRight" size={11} />
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
