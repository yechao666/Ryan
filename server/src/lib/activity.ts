import type { Db } from '../db/index.ts';
import type { EventBus } from './bus.ts';
import type { EventType, LiveEvent } from '../../../shared/src/types.ts';
import { newId, nowIso } from './ids.ts';

export interface ActivityInput {
  projectId?: string;
  projectName?: string;
  type: EventType;
  actor: string;
  summary: string;
  taskId?: string;
  agentId?: string;
}

/** 写活动表并广播 SSE（控制台实时流与仪表盘共用）。 */
export function recordActivity(db: Db, bus: EventBus, input: ActivityInput): LiveEvent {
  const at = nowIso();
  const id = newId('act');
  db.prepare(
    `INSERT INTO activity_events
       (id, project_id, project_name, type, actor, summary, task_id, agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    input.projectName ?? null,
    input.type,
    input.actor,
    input.summary,
    input.taskId ?? null,
    input.agentId ?? null,
    at,
  );
  const event: LiveEvent = {
    id,
    type: input.type,
    projectId: input.projectId,
    projectName: input.projectName,
    taskId: input.taskId,
    agentId: input.agentId,
    actor: input.actor,
    summary: input.summary,
    at,
  };
  bus.publish(event);
  return event;
}
