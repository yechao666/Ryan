import { useMemo, useState } from 'react';
import type { MemoryReport } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHead,
  SearchInput,
  Segmented,
  Select,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useProject } from '../ProjectLayout.tsx';

type Period = 'week' | 'month';

const CATEGORY_LABEL: Record<string, string> = {
  progress: '关键进展', decision: '重要决策', lesson: '经验教训', risk: '风险与阻塞',
  change: '变更', acceptance: '验收与质量', assumption: '假设与待确认', dependency: '依赖与承诺', insight: '复盘总结',
};
const CATEGORY_TONE: Record<string, 'green' | 'violet' | 'cyan' | 'red' | 'amber' | 'lime' | 'pink' | 'blue' | 'slate'> = {
  progress: 'green', decision: 'violet', lesson: 'cyan', risk: 'red', change: 'amber',
  acceptance: 'lime', assumption: 'pink', dependency: 'blue', insight: 'slate',
};

type ReportRow = MemoryReport['sections'][number]['items'][number];

function ReportPanel({ report, loading, error, period, onGenerate }: {
  report: MemoryReport | null;
  loading: boolean;
  error: string | null;
  period: Period;
  onGenerate: () => void;
}) {
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('all');
  const rows = useMemo(() => {
    if (!report) return [] as ReportRow[];
    return report.sections.flatMap((section) => section.items);
  }, [report]);
  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return rows.filter((row) => (category === 'all' || row.category === category)
      && (!query || row.content.toLowerCase().includes(query)));
  }, [rows, category, keyword]);
  const columns: Column<ReportRow>[] = [
    { key: 'category', header: '分类', width: 116, sortValue: (row) => CATEGORY_LABEL[row.category] ?? row.category, render: (row) => <Badge tone={CATEGORY_TONE[row.category] ?? 'slate'} size="sm">{CATEGORY_LABEL[row.category] ?? row.category}</Badge> },
    { key: 'content', header: '记录内容', sortValue: (row) => row.content, render: (row) => <div className="small" style={{ lineHeight: 1.55 }}>{row.content}</div> },
    { key: 'status', header: '状态', width: 88, sortValue: (row) => row.status ?? '', render: (row) => row.status ?? '—' },
    { key: 'severity', header: '严重度', width: 82, sortValue: (row) => row.severity ?? '', render: (row) => row.severity ?? '—' },
    { key: 'task', header: '来源任务', width: 128, sortValue: (row) => row.taskId ?? '', render: (row) => row.taskId ? <span className="mono tiny">{row.taskId.slice(0, 14)}</span> : '—' },
    { key: 'createdAt', header: '时间', width: 108, sortValue: (row) => row.createdAt, render: (row) => <span className="tiny muted" title={row.createdAt}>{new Date(row.createdAt).toLocaleDateString('zh-CN')}</span> },
  ];
  const copy = async () => {
    if (!report) return;
    try { await navigator.clipboard.writeText(report.markdown); toast.success('报告已复制'); }
    catch { toast.error('复制失败，请手动选择文本'); }
  };
  return (
    <div className="vstack gap-12">
      <div className="between gap-8 wrap" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="strong">周报 / 月报</div>
          <div className="tiny dim mt-4">按报告周期汇总过程记录；表格支持筛选、排序和列宽调整。</div>
        </div>
        <div className="hstack gap-8">
          <Button size="sm" icon="refresh" loading={loading} onClick={onGenerate}>{period === 'week' ? '生成本周周报' : '生成本月月报'}</Button>
          {report ? <Button size="sm" variant="outline" icon="copy" onClick={() => void copy()}>复制 Markdown</Button> : null}
        </div>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {report ? (
        <Card>
          <div className="between gap-8 wrap" style={{ padding: '12px 14px' }}>
            <div className="hstack gap-6 wrap">
              <Badge tone="violet" size="sm">{report.title}</Badge>
              <span className="tiny dim">{report.start.slice(0, 10)} ~ {new Date(new Date(report.end).getTime() - 86400000).toISOString().slice(0, 10)}</span>
              {report.sections.map((section) => <span className="chip" key={section.key}>{section.title} {section.count}</span>)}
            </div>
            <div className="hstack gap-8">
              <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索复盘记录" />
              <Select
                value={category}
                options={[{ value: 'all', label: '全部分类' }, ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))]}
                onChange={(event) => setCategory(event.target.value)}
                aria-label="按分类筛选"
                style={{ width: 140 }}
              />
            </div>
          </div>
          <Table
            columns={columns}
            rows={filtered}
            sortable
            resizable
            rowKey={(row) => row.id}
            empty={<EmptyState icon="layers" title="本周暂无复盘记录" description="过程记录写入后会自动出现在周报/月报表格中。" compact />}
          />
        </Card>
      ) : <div className="tiny dim">还没有生成当前周期的报告。</div>}
    </div>
  );
}

/** 复盘总结：按周/月聚合项目过程记录，生成可分享的报告。 */
export function ProjectRetrospectivePage() {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const [period, setPeriod] = useState<Period>('week');
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const enabled = detail.project.reportSettings.enabled;
  const report = useAsync(() => api.memoryReport(projectId, period, anchor), [projectId, period, anchor], enabled);

  return (
    <div className="ws-page">
      <PageHead
        title="复盘总结"
        desc="按自然周或自然月聚合项目里的决策、进展、经验、风险、变更、验收、假设与依赖，生成可复制的周报/月报。过程记录本身在「项目记录」页维护。"
        actions={<div className="hstack gap-8 wrap">
          <Segmented options={[{ value: 'week', label: '周报' }, { value: 'month', label: '月报' }]} value={period} onChange={(value) => setPeriod(value as Period)} />
          <Input type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} aria-label="选择报告周期日期" style={{ width: 150 }} />
        </div>}
      />
      {!enabled ? (
        <Card pad>
          <Callout tone="amber" icon="info">
            当前项目未开启周报/月报。请到「设置 → 复盘与报告」开启后再查看复盘总结。
          </Callout>
        </Card>
      ) : (
        <>
      <Callout tone="violet" icon="sparkles">
        计划：每周 {['','周一','周二','周三','周四','周五','周六','周日'][detail.project.reportSettings.weeklyDay]} {detail.project.reportSettings.weeklyTime} · 每月 {detail.project.reportSettings.monthlyDay} 日 {detail.project.reportSettings.monthlyTime}
      </Callout>
      <div className="mt-12">
        <ReportPanel report={report.data} loading={report.loading} error={report.error} period={period} onGenerate={() => void report.refresh()} />
      </div>
        </>
      )}
    </div>
  );
}
