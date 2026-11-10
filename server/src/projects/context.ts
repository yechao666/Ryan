/** 项目背景条目：逐条维护可复用的项目上下文，并在任务领取时注入。 */
import type { Db } from '../db/index.ts';

export const PROJECT_CONTEXT_CATEGORIES = [
  { value: 'repo', label: '仓库与代码' },
  { value: 'requirement', label: '基本要求' },
  { value: 'environment', label: '环境与运行' },
  { value: 'convention', label: '约定与规范' },
  { value: 'other', label: '其他背景' },
] as const;

export interface ProjectContextItem {
  id: string;
  projectId: string;
  title: string;
  content: string;
  category: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface ContextRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  category: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function mapContextRow(row: ContextRow): ProjectContextItem {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    category: row.category,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjectContext(db: Db, projectId: string): ProjectContextItem[] {
  const rows = db.prepare(
    'SELECT * FROM project_context_items WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC',
  ).all(projectId) as unknown as ContextRow[];
  return rows.map(mapContextRow);
}

/**
 * 项目执行简报：项目提示词 + 逐条背景。
 * 所有智能体通过同一份项目简报获得共享上下文；各自的工作区文件不在此处合并。
 */
export function buildProjectBrief(db: Db, projectId: string, projectPrompt = '', maxChars = 16_000): string {
  const items = listProjectContext(db, projectId);
  const sections: string[] = [];
  if (projectPrompt.trim()) sections.push(`## 项目提示词\n${projectPrompt.trim()}`);
  if (items.length > 0) {
    sections.push('## 项目背景与上下文');
    for (const item of items) {
      sections.push(`### ${item.title}\n${item.content}`);
    }
  }
  const text = sections.join('\n\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[项目背景已截断]`;
}

/** 兼容旧调用：只返回背景条目。 */
export function projectContextText(db: Db, projectId: string): string {
  const items = listProjectContext(db, projectId);
  if (items.length === 0) return '';
  return items.map((item) => `### ${item.title}\n${item.content}`).join('\n\n');
}
