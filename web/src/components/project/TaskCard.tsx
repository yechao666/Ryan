import type { WorkItem } from '@shared';
import { Avatar, Badge, Icon } from '@ui';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { priorityMeta, taskSourceLabel, taskStatusMeta, taskTypeMeta, toneForName } from './meta.ts';

export interface TaskCardProps {
  task: WorkItem;
  onClick: (task: WorkItem) => void;
}

/** 看板任务卡：标题、智员、状态、来源、优先级、消息数与相对时间。 */
export function TaskCard({ task, onClick }: TaskCardProps) {
  const status = taskStatusMeta(task.status);
  const priority = priorityMeta(task.priority);
  const type = taskTypeMeta(task.type);
  const at = task.lastMessageAt ?? task.startedAt ?? task.createdAt;

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
        <Avatar name={task.agentName || '智员'} tone={toneForName(task.agentName || '智员')} size="sm" />
        <span className="truncate">{task.agentName || '未分配'}</span>
        <Badge tone={status.tone} size="sm" dot>
          {status.label}
        </Badge>
      </div>
      <div className="ws-task-card-foot">
        <span className="chip">{taskSourceLabel(task.source)}</span>
        <span className="ws-task-card-stat">
          <Icon name="mail" size={11} />
          {fmtInt(task.messageCount)}
        </span>
        <span className="ws-task-card-stat ws-task-card-time">
          <Icon name="clock" size={11} />
          {fmtRelative(at)}
        </span>
      </div>
    </button>
  );
}
