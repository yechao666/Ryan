import { Badge, Button, Card, EmptyState, ErrorState, Icon, PageHead, Skeleton, useToast } from '@ui';
import { api } from '../lib/api.ts';
import { fmtRelative } from '../lib/format.ts';
import { useAsync } from '../lib/hooks.ts';
import { Link } from 'react-router-dom';

/** 站内通知：任务完成与接力目标。 */
export function NotificationsPage() {
  const toast = useToast();
  const query = useAsync(() => api.notifications(), []);
  const notifications = query.data?.notifications ?? [];
  const unread = query.data?.unread ?? 0;

  const markOne = async (id: string): Promise<void> => {
    await api.readNotification(id);
    await query.refresh();
  };

  const markAll = async (): Promise<void> => {
    try {
      await api.readAllNotifications();
      toast.success('已全部标记为已读');
      await query.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '标记失败');
    }
  };

  return (
    <div className="page">
      <PageHead
        title="通知"
        desc="任务完成、接力与提醒。"
        actions={unread > 0 ? <Button variant="outline" size="sm" icon="check" onClick={() => void markAll()}>全部已读</Button> : undefined}
      />
      {query.loading && !query.data ? (
        <div className="vstack gap-8"><Skeleton h={70} /><Skeleton h={70} /><Skeleton h={70} /></div>
      ) : query.error && !query.data ? (
        <ErrorState message={query.error} onRetry={() => void query.refresh()} />
      ) : notifications.length === 0 ? (
        <Card className="card-pad"><EmptyState icon="activity" title="暂无通知" description="任务完成或接力时，相关通知会出现在这里。" /></Card>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {notifications.map((item) => (
            <Card className={`card-pad${item.readAt ? '' : ' notification-unread'}`} key={item.id}>
              <div className="row-between gap-12 wrap">
                <div className="hstack gap-10" style={{ minWidth: 0 }}>
                  <span className={`cx-metric-icon tone-${item.readAt ? 'slate' : 'violet'}`}><Icon name="activity" size={14} /></span>
                  <div style={{ minWidth: 0 }}>
                    <div className="hstack gap-8">
                      <span className="strong">{item.title}</span>
                      {!item.readAt ? <Badge size="sm" tone="violet">未读</Badge> : null}
                    </div>
                    <div className="tiny dim" style={{ marginTop: 3 }}>{item.body}</div>
                    <div className="tiny dim" style={{ marginTop: 4 }}>
                      {item.projectName ? `${item.projectName} · ` : ''}{fmtRelative(item.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="hstack gap-6">
                  {item.projectId && item.taskId ? (
                    <Link className="btn btn-sm btn-ghost" to={`/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.taskId)}`}>
                      查看任务
                    </Link>
                  ) : null}
                  {!item.readAt ? <Button size="sm" variant="ghost" onClick={() => void markOne(item.id)}>标为已读</Button> : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
