import type { WorkItem } from '@shared';
import { Badge, Icon } from '@ui';
import { fmtRelative } from '@lib/format.ts';
import { priorityMeta, taskSourceLabel, taskStatusMeta, taskTypeMeta } from './meta.ts';

export interface TaskCardProps {
  task: WorkItem;
  onClick: (task: WorkItem) => void;
}

/** 看板任务卡：标题、执行人（姓名@Ryan）、服务、状态、来源、优先级与时间。 */
export function TaskCard({ task, onClick }: TaskCardProps) {
  const status = taskStatusMeta(task.status);
  const priority = priorityMeta(task.priority);
  const type = taskTypeMeta(task.type);
  const at = task.lastMessageAt ?? task.startedAt ?? task.createdAt;
  const cardCount = task.promptCards?.length ?? task.promptCardIds?.length ?? 0;

  return (
    <button type="button" className="ws-task-card" onClick={() => onClick(task)}>
      <div className="ws-task-card-top">
        <span className="ws-task-card-title clamp-2">{task.title}</span>
        <span className="ws-task-card-badges">
          <Badge tone={type.tone} size="sm">
            {type.label}
          </Badge>
          <Badge tone={priority.tone} size="sm">
            {priority.label}
          </Badge>
        </span>
      </div>
      <div className="ws-task-card-agent">
        <Icon name="user" size={12} />
        <span className="truncate">{task.executorLabel || 'Ryan'}</span>
        <Badge tone={status.tone} size="sm" dot>
          {status.label}
        </Badge>
      </div>
      <div className="ws-task-card-foot">
        <span className="chip">{taskSourceLabel(task.source)}</span>
        {task.instanceName ? (
          <span className="chip">
            <Icon name="server" size={11} />
            {task.instanceName}
          </span>
        ) : null}
        {cardCount > 0 ? <span className="chip">{cardCount} 提示卡</span> : null}
        <span className="ws-task-card-stat ws-task-card-time">
          <Icon name="clock" size={11} />
          {fmtRelative(at)}
        </span>
      </div>
    </button>
  );
}
