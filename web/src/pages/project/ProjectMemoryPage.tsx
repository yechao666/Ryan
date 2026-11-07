import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MemoryHit } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Modal,
  PageHead,
  Pagination,
  SearchInput,
  SectionHead,
  Select,
  Skeleton,
  Switch,
  Table,
  Textarea,
  useToast,
  type Column,
  type Tone,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';

const PAGE_SIZE = 20;

const CATEGORY_META: Record<string, { label: string; tone: Tone }> = {
  fact: { label: '事实', tone: 'cyan' },
  decision: { label: '决策', tone: 'violet' },
  note: { label: '笔记', tone: 'slate' },
  task_result: { label: '任务结果', tone: 'green' },
  lesson: { label: '经验', tone: 'cyan' },
  insight: { label: '洞见', tone: 'amber' },
};

const CATEGORY_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'decision', label: '决策' },
  { value: 'task_result', label: '任务结果' },
  { value: 'lesson', label: '经验' },
  { value: 'insight', label: '洞见' },
  { value: 'fact', label: '事实' },
  { value: 'note', label: '笔记' },
];

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'manual', label: '手动' },
  { value: 'task', label: '任务写回' },
  { value: 'agent', label: 'DSH 工具' },
  { value: 'dream', label: '做梦整理' },
];

const STATUS_OPTIONS = [
  { value: 'durable', label: '持久记忆' },
  { value: 'candidate', label: '待整理' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部状态' },
];

function categoryMeta(category: string) {
  return CATEGORY_META[category] ?? { label: category || '未分类', tone: 'slate' as Tone };
}

function statusMeta(status?: string) {
  if (status === 'candidate') return { label: '待整理', tone: 'amber' as Tone };
  if (status === 'archived') return { label: '已归档', tone: 'slate' as Tone };
  return { label: '持久', tone: 'green' as Tone };
}

function sourceLabel(source?: string): string {
  if (source === 'task') return '任务沉淀';
  if (source === 'agent') return 'DSH 工具';
  if (source === 'dream') return '做梦整理';
  if (source === 'manual') return '手动';
  return source || '未知';
}

/** 项目记忆浏览器：任务表风格的筛选表格 + 详情弹窗 + 上下文简报。 */
export function ProjectMemoryPage() {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const toast = useToast();

  const memories = useAsync(() => api.projectMemories(projectId, 200), [projectId], true);
  const dream = useAsync(() => api.memoryDream(projectId), [projectId], true);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('all');
  const [source, setSource] = useState('all');
  const [statusFilter, setStatusFilter] = useState('durable');
  const [page, setPage] = useState(1);
  const [detailTarget, setDetailTarget] = useState<MemoryHit | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [memoryTitle, setMemoryTitle] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryCategory, setMemoryCategory] = useState('note');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<MemoryHit | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const [dreamEnabled, setDreamEnabled] = useState(true);
  const [dreamInterval, setDreamInterval] = useState('24');
  const [dreamUnit, setDreamUnit] = useState('hours');
  const [dreaming, setDreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const brief = useAsync(() => api.memoryBrief(projectId), [projectId], true);
  const [briefMax, setBriefMax] = useState('500');

  useEffect(() => {
    if (brief.data) setBriefMax(String(brief.data.maxChars));
  }, [brief.data]);

  useEffect(() => {
    const settings = dream.data?.settings;
    if (!settings) return;
    setDreamEnabled(settings.enabled);
    if (settings.intervalMinutes % 1440 === 0) {
      setDreamInterval(String(settings.intervalMinutes / 1440));
      setDreamUnit('days');
    } else if (settings.intervalMinutes % 60 === 0) {
      setDreamInterval(String(settings.intervalMinutes / 60));
      setDreamUnit('hours');
    } else {
      setDreamInterval(String(settings.intervalMinutes));
      setDreamUnit('minutes');
    }
  }, [dream.data?.settings]);

  const all = memories.data?.memories ?? [];
  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return all.filter((hit) => {
      if (statusFilter !== 'all' && (hit.status ?? 'durable') !== statusFilter) return false;
      if (category !== 'all' && hit.category !== category) return false;
      if (source !== 'all' && hit.source !== source) return false;
      if (!q) return true;
      return `${hit.title ?? ''}\n${hit.content}`.toLowerCase().includes(q);
    });
  }, [all, keyword, category, source, statusFilter]);

  useEffect(() => {
    setPage(1);
    setSelectedKeys(new Set());
  }, [keyword, category, source, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  const summary = useMemo(() => {
    const durable = all.filter((hit) => (hit.status ?? 'durable') === 'durable');
    const count = (name: string) => durable.filter((hit) => hit.category === name).length;
    return {
      total: durable.length,
      decisions: count('decision'),
      taskResults: count('task_result'),
      notes: count('note') + count('fact'),
      insights: count('insight'),
      latest: durable[0]?.createdAt,
    };
  }, [all]);

  const identity = memories.data?.agentId || detail.project.memoryAgentId || `aiwo_${detail.project.slug.replace(/-/g, '_')}`;
  const hasFilters = Boolean(keyword.trim()) || category !== 'all' || source !== 'all' || statusFilter !== 'durable';

  const clearFilters = () => {
    setKeyword('');
    setCategory('all');
    setSource('all');
    setStatusFilter('durable');
  };

  const submitMemory = async () => {
    if (!memoryContent.trim()) return;
    setSaving(true);
    try {
      await api.addProjectMemory(projectId, {
        title: memoryTitle.trim() || undefined,
        content: memoryContent.trim(),
        category: memoryCategory,
      });
      toast.success('记忆已写入项目记忆库');
      setMemoryTitle('');
      setMemoryContent('');
      setMemoryCategory('note');
      setAddOpen(false);
      await memories.refresh();
      await brief.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '写入记忆失败');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProjectMemory(projectId, deleteTarget.id);
      toast.success('记忆已删除');
      if (detailTarget?.id === deleteTarget.id) setDetailTarget(null);
      setSelectedKeys((current) => { const next = new Set(current); next.delete(deleteTarget.id); return next; });
      setDeleteTarget(null);
      await memories.refresh();
      await brief.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除记忆失败');
    } finally {
      setDeleting(false);
    }
  };

  const confirmBulkDelete = async () => {
    const ids = [...selectedKeys];
    if (ids.length === 0) return;
    setDeleting(true);
    try {
      await api.deleteProjectMemories(projectId, ids);
      toast.success(`已删除 ${ids.length} 条记忆`);
      setBulkDeleteOpen(false);
      setSelectedKeys(new Set());
      if (detailTarget && ids.includes(detailTarget.id)) setDetailTarget(null);
      await memories.refresh();
      await brief.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '批量删除记忆失败');
    } finally {
      setDeleting(false);
    }
  };

  const intervalLabel = (minutes: number): string => {
    if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时`;
    return `${minutes} 分钟`;
  };

  const openSettings = () => {
    const settings = dream.data?.settings;
    if (settings) {
      setDreamEnabled(settings.enabled);
      if (settings.intervalMinutes % 1440 === 0) {
        setDreamInterval(String(settings.intervalMinutes / 1440));
        setDreamUnit('days');
      } else if (settings.intervalMinutes % 60 === 0) {
        setDreamInterval(String(settings.intervalMinutes / 60));
        setDreamUnit('hours');
      } else {
        setDreamInterval(String(settings.intervalMinutes));
        setDreamUnit('minutes');
      }
    }
    setBriefMax(String(brief.data?.maxChars ?? 500));
    setSettingsOpen(true);
  };

  const saveSettings = async () => {
    const value = Number(dreamInterval);
    const briefChars = Number(briefMax);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('请输入有效的做梦间隔');
      return;
    }
    if (!Number.isFinite(briefChars) || briefChars < 100 || briefChars > 5000) {
      toast.error('简报字数需在 100–5000 之间');
      return;
    }
    const multiplier = dreamUnit === 'days' ? 1440 : dreamUnit === 'hours' ? 60 : 1;
    const minutes = Math.max(1, Math.round(value * multiplier));
    setSavingSettings(true);
    try {
      await Promise.all([
        api.updateMemoryDream(projectId, { enabled: dreamEnabled, intervalMinutes: minutes }),
        api.updateMemoryBrief(projectId, briefChars),
      ]);
      toast.success('记忆整理设置已保存');
      setSettingsOpen(false);
      await Promise.all([dream.refresh(), brief.refresh()]);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存设置失败');
    } finally {
      setSavingSettings(false);
    }
  };

  const runDreamNow = async () => {
    setDreaming(true);
    try {
      const result = await api.runMemoryDream(projectId);
      const run = result.run;
      if (run.status === 'skipped') toast.info('没有需要整理的新记忆');
      else toast.success(`做梦完成：${run.inputCount} 条新记忆 → ${run.insightCount} 条洞见`);
      await Promise.all([memories.refresh(), dream.refresh()]);
      await brief.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '做梦失败');
    } finally {
      setDreaming(false);
    }
  };

  const columns: Column<MemoryHit>[] = useMemo(() => [
    {
      key: 'content',
      header: '记忆',
      render: (row) => (
        <div className="vstack gap-3" style={{ minWidth: 260 }}>
          <span className="strong truncate">{row.title || row.content.split('\n')[0]?.slice(0, 48) || '未命名记忆'}</span>
          <span className="tiny dim clamp-1">{row.content.replace(/\s+/g, ' ')}</span>
        </div>
      ),
    },
    {
      key: 'category',
      header: '类型',
      width: 92,
      render: (row) => {
        const meta = categoryMeta(row.category);
        return <Badge size="sm" tone={meta.tone}>{meta.label}</Badge>;
      },
    },
    {
      key: 'source',
      header: '来源',
      width: 100,
      render: (row) => <Badge size="sm" tone="slate">{sourceLabel(row.source)}</Badge>,
    },
    {
      key: 'status',
      header: '状态',
      width: 86,
      render: (row) => {
        const meta = statusMeta(row.status);
        return <Badge size="sm" tone={meta.tone}>{meta.label}</Badge>;
      },
    },
    {
      key: 'task',
      header: '关联任务',
      width: 130,
      render: (row) => row.taskId ? (
        <Link
          className="ws-link tiny"
          to={`${base}/tasks/${encodeURIComponent(row.taskId)}`}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon name="list" size={11} />
          {row.taskId.slice(0, 10)}
        </Link>
      ) : <span className="tiny dim">—</span>,
    },
    {
      key: 'updated',
      header: '更新时间',
      width: 110,
      render: (row) => (
        <span className="tiny dim" title={fmtDateTime(row.updatedAt ?? row.createdAt)}>
          {fmtRelative(row.updatedAt ?? row.createdAt)}
        </span>
      ),
      sortValue: (row) => Date.parse(row.updatedAt ?? row.createdAt) || 0,
    },
    {
      key: 'actions',
      header: '操作',
      width: 105,
      align: 'right',
      render: (row) => (
        <div className="hstack gap-4" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" icon="search" onClick={(event) => { event.stopPropagation(); setDetailTarget(row); }}>
            查看
          </Button>
          <Button size="sm" variant="ghost" icon="trash" onClick={(event) => { event.stopPropagation(); setDeleteTarget(row); }}>
            删除
          </Button>
        </div>
      ),
    },
  ], [base]);

  return (
    <div className="ws-page">
      <PageHead
        title="项目记忆"
        desc="Aiwo 内置项目记忆；任务领取时注入最近的记忆简报（默认 500 字），更多背景由 DSH 按需检索。"
        actions={
          <div className="hstack gap-6">
            <Button variant="ghost" icon="refresh" loading={memories.loading} onClick={() => void memories.refresh()}>
              刷新
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
              新增记忆
            </Button>
          </div>
        }
      />

      <div className="kpi-grid">
        <Card className="card-pad">
          <div className="pm-label">记忆总数</div>
          <div className="pm-value">{fmtInt(summary.total)}</div>
          <div className="card-sub">项目 <span className="mono">{projectId}</span></div>
        </Card>
        <Card className="card-pad">
          <div className="pm-label">决策</div>
          <div className="pm-value">{fmtInt(summary.decisions)}</div>
          <div className="card-sub">架构、方案与约定</div>
        </Card>
        <Card className="card-pad">
          <div className="pm-label">洞见</div>
          <div className="pm-value">{fmtInt(summary.insights)}</div>
          <div className="card-sub">做梦提升的高层知识</div>
        </Card>
        <Card className="card-pad">
          <div className="pm-label">最近更新</div>
          <div className="pm-value" style={{ fontSize: 18 }}>{summary.latest ? fmtRelative(summary.latest) : '—'}</div>
          <div className="card-sub">记忆身份 <span className="mono">{identity}</span></div>
        </Card>
      </div>

      <Card className="card-pad ws-memory-dream-card">
        <SectionHead
          title={<><Icon name="sparkles" size={14} />记忆做梦</>}
          desc="增量巩固：只处理上次做梦后新增的候选记忆，归纳为有效洞见；不会重跑旧记忆，也不会执行任务。"
          actions={
            <div className="hstack gap-6">
              <Button size="sm" variant="ghost" icon="settings" onClick={openSettings}>
                设置
              </Button>
              <Button size="sm" variant="primary" icon="sparkles" loading={dreaming} onClick={() => void runDreamNow()}>
                立即做梦
              </Button>
            </div>
          }
        />
        <div className="ws-dream-status-grid mt-12">
          <div>
            <span className="pm-label">状态</span>
            <Badge tone={dream.data?.settings.enabled ? 'green' : 'slate'} dot>
              {dream.data?.settings.enabled ? '已启用' : '已停用'}
            </Badge>
          </div>
          <div>
            <span className="pm-label">周期</span>
            <strong>{dream.data?.settings.enabled ? intervalLabel(dream.data.settings.intervalMinutes) : '—'}</strong>
          </div>
          <div>
            <span className="pm-label">待整理</span>
            <strong>{dream.data?.pendingCount ?? 0} 条</strong>
          </div>
          <div>
            <span className="pm-label">上次做梦</span>
            <span>{dream.data?.settings.lastAt ? fmtRelative(dream.data.settings.lastAt) : '尚未做梦'}</span>
          </div>
        </div>
        {dream.error ? <Callout tone="red" icon="alert">{dream.error}</Callout> : null}
        {dream.data?.lastRun ? (
          <div className="ws-dream-last-run">
            <div className="hstack gap-6 wrap">
              <span className="tiny dim">最近一次</span>
              <Badge size="sm" tone={dream.data.lastRun.status === 'completed' ? 'green' : dream.data.lastRun.status === 'failed' ? 'red' : 'slate'}>
                {dream.data.lastRun.status}
              </Badge>
              <span className="tiny dim">输入 {dream.data.lastRun.inputCount} 条 · 产出 {dream.data.lastRun.insightCount} 条洞见</span>
            </div>
            {dream.data.lastRun.summary ? (
              <p className="tiny dim clamp-2" style={{ margin: '6px 0 0' }}>{dream.data.lastRun.summary}</p>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="toolbar">
        <div className="toolbar-left">
          <Select
            className="ws-filter-select"
            value={category}
            options={CATEGORY_OPTIONS}
            onChange={(event) => setCategory(event.target.value)}
          />
          <Select
            className="ws-filter-select"
            value={source}
            options={SOURCE_OPTIONS}
            onChange={(event) => setSource(event.target.value)}
          />
          <Select
            className="ws-filter-select"
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={(event) => setStatusFilter(event.target.value)}
          />
          <SearchInput
            value={keyword}
            onChange={setKeyword}
            placeholder="搜索记忆标题 / 内容"
            className="ws-search"
          />
          <span className="tiny dim">共 {filtered.length} 条记忆</span>
          {memories.loading && memories.data ? <span className="tiny dim">更新中…</span> : null}
        </div>
        <div className="toolbar-right">
          {filtered.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (selectedKeys.size >= filtered.length) {
                  setSelectedKeys(new Set());
                } else {
                  setSelectedKeys(new Set(filtered.map((hit) => hit.id)));
                }
              }}
            >
              {selectedKeys.size > 0 ? `取消选择（${selectedKeys.size}）` : '全选'}
            </Button>
          ) : null}
          {selectedKeys.size > 0 ? (
            <Button size="sm" variant="danger" icon="trash" onClick={() => setBulkDeleteOpen(true)}>
              删除选中（{selectedKeys.size}）
            </Button>
          ) : null}
          {hasFilters ? <Button size="sm" variant="ghost" onClick={clearFilters}>清除筛选</Button> : null}
        </div>
      </div>

      {memories.error && !memories.data ? (
        <Card><div style={{ padding: 18 }}><ErrorState message={memories.error} onRetry={() => void memories.refresh()} /></div></Card>
      ) : (
        <Card>
          <Table
            columns={columns}
            rows={paged}
            sortable
            resizable
            rowKey={(row) => row.id}
            selectedKeys={selectedKeys}
            onToggleKey={(key) => setSelectedKeys((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            })}
            loading={memories.loading && !memories.data}
            onRowClick={(row) => setDetailTarget(row)}
            empty={
              hasFilters ? (
                <EmptyState
                  compact
                  icon="filter"
                  title="该筛选下暂无记忆"
                  description="调整类型、来源或关键词，或清除筛选查看全部。"
                  action={<Button size="sm" variant="outline" onClick={clearFilters}>清除筛选</Button>}
                />
              ) : (
                <EmptyState
                  icon="brain"
                  title="还没有项目记忆"
                  description="普通任务结果留在任务历史；只有决策/经验候选会进入做梦流程，也可以手动新增。"
                  action={<Button size="sm" variant="primary" icon="plus" onClick={() => setAddOpen(true)}>新增记忆</Button>}
                />
              )
            }
          />
          {!memories.loading && filtered.length > 0 ? (
            <div className="ws-table-foot">
              <Pagination page={currentPage} totalPages={totalPages} total={filtered.length} pageSize={PAGE_SIZE} onChange={setPage} />
            </div>
          ) : null}
        </Card>
      )}

      <Card className="card-pad">
        <SectionHead
          title={<><Icon name="sparkles" size={14} />记忆简报</>}
          desc="只取最近的持久记忆/洞见，由本机 DSH 归纳成有字数上限的上下文，任务领取时注入。"
          actions={
            <div className="hstack gap-6">
              <span className="tiny dim">上限 {brief.data?.maxChars ?? 500} 字</span>
              <Button size="sm" variant="ghost" icon="settings" onClick={openSettings}>
                设置
              </Button>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void brief.refresh()}>
                刷新
              </Button>
            </div>
          }
        />
        <div className="mt-12">
          {brief.loading && !brief.data ? (
            <Skeleton h={140} style={{ borderRadius: 12 }} />
          ) : brief.error ? (
            <ErrorState message={brief.error} onRetry={() => void brief.refresh()} />
          ) : (
            <>
              <CodeBlock title="memory brief" code={brief.data?.text || '（当前还没有可用的持久记忆）'} />
              <div className="ws-mem-foot">
                <span className="tiny dim">{brief.data?.count ?? 0} 条最近记忆 · 上限 {brief.data?.maxChars ?? 500} 字</span>
                <CopyButton value={brief.data?.text ?? ''} label="复制简报" />
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="记忆整理设置"
        description="配置定时做梦和任务记忆简报。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSettingsOpen(false)}>取消</Button>
            <Button variant="primary" icon="check" loading={savingSettings} onClick={() => void saveSettings()}>
              保存设置
            </Button>
          </>
        }
      >
        <div className="vstack gap-16">
          <div className="ws-settings-row">
            <div>
              <div className="strong">启用定时做梦</div>
              <div className="tiny dim">后台按周期整理候选记忆，只处理新增内容。</div>
            </div>
            <Switch checked={dreamEnabled} onChange={setDreamEnabled} />
          </div>
          <Field label="做梦周期" hint="最短 1 分钟，最长 30 天。">
            <div className="ws-dream-cycle">
              <Input
                value={dreamInterval}
                inputMode="numeric"
                className="ws-dream-number"
                onChange={(event) => setDreamInterval(event.target.value.replace(/[^0-9.]/g, ''))}
              />
              <Select
                value={dreamUnit}
                className="ws-dream-unit"
                options={[
                  { value: 'minutes', label: '分钟' },
                  { value: 'hours', label: '小时' },
                  { value: 'days', label: '天' },
                ]}
                onChange={(event) => setDreamUnit(event.target.value)}
              />
            </div>
          </Field>
          <Field label="记忆简报最大字数" hint="100–5000 字，默认 500；仅取最近记忆/洞见。">
            <Input
              value={briefMax}
              inputMode="numeric"
              className="ws-dream-number"
              onChange={(event) => setBriefMax(event.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="新增项目记忆"
        description="手动写入一条持久项目知识；普通任务结果不会自动进入这里。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>取消</Button>
            <Button variant="primary" icon="check" loading={saving} disabled={!memoryContent.trim()} onClick={() => void submitMemory()}>
              写入记忆
            </Button>
          </>
        }
      >
        <div className="vstack gap-10">
          <div className="grid grid-2">
            <Field label="标题（可选）">
              <Input value={memoryTitle} placeholder="例如：支付回调验签约定" onChange={(event) => setMemoryTitle(event.target.value)} />
            </Field>
            <Field label="类型">
              <Select
                value={memoryCategory}
                options={[
                  { value: 'note', label: '笔记' },
                  { value: 'fact', label: '事实' },
                  { value: 'decision', label: '决策' },
                ]}
                onChange={(event) => setMemoryCategory(event.target.value)}
              />
            </Field>
          </div>
          <Field label="记忆内容">
            <Textarea
              value={memoryContent}
              rows={6}
              placeholder="写下项目约定、架构决策、踩坑经验或业务事实…"
              onChange={(event) => setMemoryContent(event.target.value)}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        title="删除这条项目记忆？"
        description={deleteTarget?.title || deleteTarget?.content.slice(0, 100)}
        confirmLabel="删除记忆"
        loading={deleting}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => void confirmBulkDelete()}
        title={`删除选中的 ${selectedKeys.size} 条记忆？`}
        description="删除后不可恢复；原始任务历史不受影响。"
        confirmLabel="删除选中记忆"
        loading={deleting}
      />
    </div>
  );
}
