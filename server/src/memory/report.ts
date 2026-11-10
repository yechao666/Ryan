/** Ryan 项目周报/月报：把决策、进展、经验和洞见按自然周期聚合为 Markdown。 */
import type { Db } from '../db/index.ts';
import type { MemoryReport, MemoryReportPeriod, MemoryReportSection } from '../../../shared/src/types.ts';

interface ReportRow {
  id: string;
  title: string;
  content: string;
  category: string;
  created_at: string;
  task_id: string | null;
  metadata: string;
}

const SECTION_META: Array<{ key: MemoryReportSection['key']; title: string; categories: string[] }> = [
  { key: 'progress', title: '关键进展', categories: ['progress', 'task_result'] },
  { key: 'decisions', title: '重要决策', categories: ['decision'] },
  { key: 'lessons', title: '经验教训', categories: ['lesson'] },
  { key: 'risks', title: '风险与阻塞', categories: ['risk'] },
  { key: 'changes', title: '变更', categories: ['change'] },
  { key: 'acceptance', title: '验收与质量', categories: ['acceptance'] },
  { key: 'assumptions', title: '假设与待确认', categories: ['assumption'] },
  { key: 'dependencies', title: '依赖与承诺', categories: ['dependency'] },
  { key: 'insights', title: '复盘总结', categories: ['insight'] },
];

function reportRange(period: MemoryReportPeriod, anchor?: string, now = new Date()): { start: number; end: number } {
  const base = anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor)
    ? new Date(`${anchor}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') {
    const day = (base.getUTCDay() + 6) % 7;
    const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - day);
    return { start, end: start + 7 * 86_400_000 };
  }
  return {
    start: Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1),
    end: Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1),
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function buildMemoryReport(db: Db, projectId: string, period: MemoryReportPeriod, anchor?: string): MemoryReport {
  const range = reportRange(period, anchor);
  const start = new Date(range.start).toISOString();
  const end = new Date(range.end).toISOString();
  const categories = SECTION_META.flatMap((section) => section.categories);
  const placeholders = categories.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT id, title, content, category, created_at, task_id, metadata FROM project_memories
      WHERE project_id = ? AND status IN ('durable', 'candidate') AND category IN (${placeholders})
        AND created_at >= ? AND created_at < ?
      ORDER BY created_at DESC LIMIT 300`,
  ).all(projectId, ...categories, start, end) as unknown as ReportRow[];

  const items = rows.map((row) => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* ignore */ }
    return {
    id: row.id,
    ...(row.title ? { title: row.title } : {}),
    content: row.content,
    category: row.category,
    createdAt: row.created_at,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(typeof metadata.status === 'string' ? { status: metadata.status } : {}),
    ...(typeof metadata.severity === 'string' ? { severity: metadata.severity } : {}),
    };
  });
  const sections = SECTION_META.map((section) => {
    const sectionItems = items.filter((item) => section.categories.includes(item.category));
    return { key: section.key, title: section.title, count: sectionItems.length, items: sectionItems };
  });
  const counts = Object.fromEntries(sections.map((section) => [section.key, section.count])) as MemoryReport['counts'];
  const title = period === 'week' ? '项目周报' : '项目月报';
  const lines = [`# ${title}`, '', `- 周期：${start.slice(0, 10)} ~ ${new Date(range.end - 86_400_000).toISOString().slice(0, 10)}`, `- 生成时间：${new Date().toISOString()}`, ''];
  for (const section of sections) {
    lines.push(`## ${section.title}（${section.count}）`, '');
    if (section.items.length === 0) { lines.push('_本周期暂无记录_', ''); continue; }
    for (const item of section.items.slice(0, 30)) {
      lines.push(`- ${oneLine(item.title ? `${item.title}：${item.content}` : item.content)}（${item.createdAt.slice(0, 10)}）`);
    }
    lines.push('');
  }
  return { projectId, period, title: `${title} · ${start.slice(0, 10)}`, start, end, sections, counts, markdown: lines.join('\n').trimEnd() };
}
