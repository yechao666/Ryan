import { useMemo, useState } from 'react';
import type { MemoryHit } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  PageHead,
  SearchInput,
  Select,
  Table,
  type Column,
  type Tone,
} from '@ui';
import { api } from '@lib/api.ts';
import { fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import { useProject } from '../ProjectLayout.tsx';

type RecordKey = 'decision' | 'progress' | 'lesson' | 'risk' | 'change' | 'acceptance' | 'assumption' | 'dependency';

const CATEGORY_META: Array<{ key: RecordKey; label: string; tone: Tone; description: string }> = [
  { key: 'decision', label: '重要决策', tone: 'violet', description: '方向、选型、取舍与不可逆判断' },
  { key: 'progress', label: '关键进展', tone: 'green', description: '阶段成果、里程碑与值得同步的变化' },
  { key: 'lesson', label: '经验教训', tone: 'cyan', description: '踩过的坑、有效做法与下次要注意的事' },
  { key: 'risk', label: '风险与阻塞', tone: 'red', description: '可能影响交付的风险、当前阻塞与升级项' },
  { key: 'change', label: '变更', tone: 'amber', description: '范围、排期、验收标准或方案基线变化' },
  { key: 'acceptance', label: '验收与质量', tone: 'lime', description: '测试、评审、验收结果与质量证据' },
  { key: 'assumption', label: '假设与待确认', tone: 'pink', description: '未验证前提、外部答复与未决问题' },
  { key: 'dependency', label: '依赖与承诺', tone: 'blue', description: '跨团队依赖、外部交付承诺与延期风险' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_META.map((item) => [item.key, item.label])) as Record<RecordKey, string>;
const CATEGORY_TONE = Object.fromEntries(CATEGORY_META.map((item) => [item.key, item.tone])) as Record<RecordKey, Tone>;
const CATEGORY_ORDER = new Map(CATEGORY_META.map((item, index) => [item.key, index]));

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayKey(): string {
  return localDateKey(new Date());
}

function daysAgoKey(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateKey(date);
}

function monthStartKey(): string {
  const date = new Date();
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), 1));
}

function recordDateKey(iso: string): string {
  return localDateKey(new Date(iso));
}

function metadataField(memory: MemoryHit, key: string): string {
  const value = memory.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '—';
}

/** 项目记录：用表格承载结构化过程信息。 */
export function ProjectRecordsPage() {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const [category, setCategory] = useState<'all' | RecordKey>('all');
  const [keyword, setKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const memories = useAsync(() => api.projectMemories(projectId, 200), [projectId], true);

  const allRecords = useMemo(
    () => (memories.data?.memories ?? [])
      .filter((memory) => CATEGORY_ORDER.has(memory.category as RecordKey) && memory.status !== 'archived')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [memories.data],
  );
  const rangeInvalid = Boolean(startDate && endDate && startDate > endDate);
  const rows = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return allRecords.filter((memory) => {
      if (category !== 'all' && memory.category !== category) return false;
      if (query && !`${memory.title ?? ''}\n${memory.content}`.toLowerCase().includes(query)) return false;
      if (rangeInvalid) return false;
      const day = recordDateKey(memory.createdAt);
      if (startDate && day < startDate) return false;
      if (endDate && day > endDate) return false;
      return true;
    });
  }, [allRecords, category, keyword, startDate, endDate, rangeInvalid]);

  const setRange = (start: string, end: string): void => {
    setStartDate(start);
    setEndDate(end);
  };
  const today = todayKey();

  const columns: Column<MemoryHit>[] = [
    {
      key: 'category',
      header: '类型',
      width: 116,
      sortValue: (memory) => CATEGORY_LABEL[memory.category as RecordKey] ?? memory.category,
      render: (memory) => <Badge tone={CATEGORY_TONE[memory.category as RecordKey] ?? 'slate'} size="sm">{CATEGORY_LABEL[memory.category as RecordKey] ?? memory.category}</Badge>,
    },
    {
      key: 'content',
      header: '记录内容',
      sortValue: (memory) => memory.content,
      render: (memory) => (
        <div className="vstack gap-3">
          {memory.title ? <div className="tiny dim">{memory.title}</div> : null}
          <div className="small" style={{ lineHeight: 1.55 }}>{memory.content}</div>
        </div>
      ),
    },
    { key: 'status', header: '状态', width: 88, sortValue: (memory) => metadataField(memory, 'status'), render: (memory) => metadataField(memory, 'status') },
    { key: 'severity', header: '严重度', width: 82, sortValue: (memory) => metadataField(memory, 'severity'), render: (memory) => metadataField(memory, 'severity') },
    { key: 'task', header: '来源任务', width: 128, sortValue: (memory) => memory.taskId ?? '', render: (memory) => memory.taskId ? <span className="mono tiny">{memory.taskId.slice(0, 14)}</span> : '—' },
    { key: 'createdAt', header: '时间', width: 108, sortValue: (memory) => memory.createdAt, render: (memory) => <span className="tiny muted" title={memory.createdAt}>{fmtRelative(memory.createdAt)}</span> },
  ];

  return (
    <div className="ws-page">
      <PageHead
        title="项目记录"
        desc="以表格维护项目过程信息：重要决策、关键进展、经验教训、风险阻塞、变更、验收质量、未决假设和外部依赖。周报/月报请到「复盘总结」页生成。"
      />
      <Callout tone="violet" icon="sparkles">
        这里不记录任务流水账。只保留会影响后续判断和交付的过程事实；普通完成状态、逐文件改动和临时输出留在任务历史。
      </Callout>
      {memories.error ? <div className="mt-12"><ErrorState message={memories.error} onRetry={() => void memories.refresh()} /></div> : null}
      <Card>
        <div className="records-date-range">
          <div className="records-date-range__title">
            <Icon name="calendar" size={14} />
            <span>时间区间</span>
          </div>
          <div className="records-date-range__inputs">
            <Input
              type="date"
              value={startDate}
              max={endDate || today}
              onChange={(event) => setStartDate(event.target.value)}
              aria-label="开始日期"
              style={{ width: 150 }}
            />
            <span className="tiny dim">至</span>
            <Input
              type="date"
              value={endDate}
              min={startDate || undefined}
              max={today}
              onChange={(event) => setEndDate(event.target.value)}
              aria-label="结束日期"
              style={{ width: 150 }}
            />
            <div className="records-date-range__quick">
              <Button size="sm" variant={startDate === daysAgoKey(6) && endDate === today ? 'primary' : 'outline'} onClick={() => setRange(daysAgoKey(6), today)}>近 7 天</Button>
              <Button size="sm" variant={startDate === daysAgoKey(29) && endDate === today ? 'primary' : 'outline'} onClick={() => setRange(daysAgoKey(29), today)}>近 30 天</Button>
              <Button size="sm" variant={startDate === daysAgoKey(89) && endDate === today ? 'primary' : 'outline'} onClick={() => setRange(daysAgoKey(89), today)}>近 90 天</Button>
              <Button size="sm" variant={startDate === monthStartKey() && endDate === today ? 'primary' : 'outline'} onClick={() => setRange(monthStartKey(), today)}>本月</Button>
              <Button size="sm" variant={!startDate && !endDate ? 'primary' : 'outline'} onClick={() => setRange('', '')}>全部</Button>
            </div>
          </div>
          <div className="records-date-range__summary">
            {startDate || endDate ? (
              <span>筛选 {rows.length} / {allRecords.length} 条</span>
            ) : (
              <span>共 {allRecords.length} 条</span>
            )}
            {rangeInvalid ? <span className="records-date-range__error">开始日期不能晚于结束日期</span> : null}
          </div>
        </div>
        <div className="toolbar" style={{ padding: '12px 14px' }}>
          <div className="toolbar-left">
            <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索记录内容或标题" />
            <Select
              value={category}
              options={[{ value: 'all', label: '全部类型' }, ...CATEGORY_META.map((item) => ({ value: item.key, label: item.label }))]}
              onChange={(event) => setCategory(event.target.value as 'all' | RecordKey)}
              aria-label="按记录类型筛选"
              style={{ width: 150 }}
            />
            <span className="tiny dim">符合筛选 {rows.length} 条</span>
          </div>
          <div className="toolbar-right">
            <Button size="sm" icon="refresh" loading={memories.loading} onClick={() => void memories.refresh()}>刷新</Button>
          </div>
        </div>
        <Table
          columns={columns}
          rows={rows}
          sortable
          resizable
          rowKey={(memory) => memory.id}
          loading={memories.loading && !memories.data}
          empty={<EmptyState icon="layers" title="暂无项目记录" description="DSH 完成任务后，会在有实质内容时写入对应过程记录。" compact />}
        />
      </Card>
    </div>
  );
}
