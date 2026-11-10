import type { Db } from '../db/index.ts';
import { newId, nowIso } from './ids.ts';

/** 插入一条站内通知。 */
export function createTaskNotification(
  db: Db,
  input: {
    personId: string;
    taskId?: string | null;
    projectId?: string | null;
    type: string;
    title: string;
    body?: string;
  },
): void {
  db.prepare(
    `INSERT INTO task_notifications (id, person_id, task_id, project_id, type, title, body, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    newId('ntf'),
    input.personId,
    input.taskId ?? null,
    input.projectId ?? null,
    input.type,
    input.title,
    input.body ?? '',
    nowIso(),
  );
}
