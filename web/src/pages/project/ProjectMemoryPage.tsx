import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MemoryHit } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Card,
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
};

const CATEGORY_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'decision', label: '决策' },
  { value: 'task_result', label: '任务结果' },
  { value: 'fact', label: '事实' },
  { value: 'note', label: '笔记' },
];

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'manual', label: '手动' },
  { value: 'task', label: '任务写回' },
  { value: 'agent', label: 'DSH 工具' },
];

function categoryMeta(category: string) {
  return CATEGORY_META[category] ?? { label: category || '未分类', tone: 'slate' as Tone };
}

function sourceLabel(source?: string): string {
  if (source === 'task') return '任务写回';
  if (source === 'agent') return 'DSH 工具';
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
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('all');
  const [source, setSource] = useState('all');
  const [page, setPage] = useState(1);
  const [detailTarget, setDetailTarget] = useState<MemoryHit | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [memoryTitle, setMemoryTitle] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryCategory, setMemoryCategory] = useState('note');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<MemoryHit | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [contextQuery, setContextQuery] = useState('');
  const [contextTick, setContextTick] = useState(0);
  const context = useAsync(
    () => api.memoryContext(projectId, detail.project.memoryAgentId, contextQuery.trim() || undefined),
    [projectId, detail.project.memoryAgentId, contextTick],
    true,
  );

  const all = memories.data?.memories ?? [];
  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return all.filter((hit) => {
      if (category !== 'all' && hit.category !== category) return false;
      if (source !== 'all' && hit.source !== source) return false;
      if (!q) return true;
      return `${hit.title ?? ''}\n${hit.content}`.toLowerCase().includes(q);
    });
  }, [all, keyword, category, source]);

  useEffect(() => { setPage(1); }, [keyword, category, source]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  const summary = useMemo(() => {
    const count = (name: string) => all.filter((hit) => hit.category === name).length;
    return {
      total: all.length,
      decisions: count('decision'),
      taskResults: count('task_result'),
      notes: count('note') + count('fact'),
      latest: all[0]?.createdAt,
    };
  }, [all]);

  const identity = memories.data?.agentId || detail.project.memoryAgentId || `aiwo_${detail.project.slug.replace(/-/g, '_')}`;
  const hasFilters = Boolean(keyword.trim()) || category !== 'all' || source !== 'all';

  const clearFilters = () => {
    setKeyword('');
    setCategory('all');
    setSource('all');
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
      setContextTick((tick) => tick + 1);
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
      setDeleteTarget(null);
      await memories.refresh();
      setContextTick((tick) => tick + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除记忆失败');
    } finally {
      setDeleting(false);
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
        desc="Aiwo 内置项目记忆；任务需要时通过记忆工具检索，不自动占用上下文。"
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
          <div className="pm-label">任务结果</div>
          <div className="pm-value">{fmtInt(summary.taskResults)}</div>
          <div className="card-sub">任务完成自动写回</div>
        </Card>
        <Card className="card-pad">
          <div className="pm-label">最近更新</div>
          <div className="pm-value" style={{ fontSize: 18 }}>{summary.latest ? fmtRelative(summary.latest) : '—'}</div>
          <div className="card-sub">记忆身份 <span className="mono">{identity}</span></div>
        </Card>
      </div>

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
                  description="任务完成后会自动写入执行结论，也可以手动新增。"
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
          title={<><Icon name="sparkles" size={14} />任务上下文简报</>}
          desc="模拟 DSH 按需检索时生成的「项目记忆」段落，并估算 token 消耗。"
          actions={
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => setContextTick((tick) => tick + 1)}>
              重新生成
            </Button>
          }
        />
        <div className="toolbar mt-12">
          <div className="toolbar-left ws-context-form">
            <Input
              value={contextQuery}
              placeholder="可选：填写任务主题，让简报更聚焦（例如：修复支付回调）"
              onChange={(event) => setContextQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  setContextTick((tick) => tick + 1);
                }
              }}
            />
            <Button variant="primary" icon="sparkles" loading={context.loading} onClick={() => setContextTick((tick) => tick + 1)}>
              生成简报
            </Button>
          </div>
        </div>
        <div className="mt-16">
          {context.loading && !context.data ? (
            <Skeleton h={160} style={{ borderRadius: 12 }} />
          ) : context.error ? (
            <ErrorState message={context.error} onRetry={() => void context.refresh()} />
          ) : context.data ? (
            <>
              <CodeBlock title="memory context" code={context.data.prompt || '（当前没有可用的记忆上下文）'} />
              <div className="ws-mem-foot">
                <span className="tiny dim">约 {fmtInt(context.data.tokenEstimate)} tokens · {(context.data.citations ?? []).length} 条引用</span>
                <CopyButton value={context.data.prompt} label="复制简报" />
              </div>
              {context.data.citations?.length ? (
                <div className="ws-citation-row">
                  {context.data.citations.slice(0, 8).map((citation) => <code className="ws-placeholder" key={citation}>{citation}</code>)}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </Card>

      <Modal
        open={Boolean(detailTarget)}
        onClose={() => setDetailTarget(null)}
        title={detailTarget?.title || '记忆详情'}
        description={detailTarget ? `#${detailTarget.id} · ${fmtDateTime(detailTarget.createdAt)}` : undefined}
        size="lg"
        footer={
          <>
            {detailTarget?.taskId ? (
              <Link className="btn btn-sm btn-outline" to={`${base}/tasks/${encodeURIComponent(detailTarget.taskId)}`}>
                <Icon name="list" size={12} />查看来源任务
              </Link>
            ) : null}
            <Button variant="ghost" onClick={() => setDetailTarget(null)}>关闭</Button>
            <Button variant="danger" icon="trash" onClick={() => detailTarget && setDeleteTarget(detailTarget)}>删除</Button>
          </>
        }
      >
        {detailTarget ? (
          <div className="vstack gap-10">
            <div className="hstack gap-6 wrap">
              <Badge tone={categoryMeta(detailTarget.category).tone}>{categoryMeta(detailTarget.category).label}</Badge>
              <Badge tone="slate">{sourceLabel(detailTarget.source)}</Badge>
              <span className="tiny dim">更新于 {fmtRelative(detailTarget.updatedAt ?? detailTarget.createdAt)}</span>
            </div>
            <div className="ws-mem-preview" style={{ maxHeight: 420 }}>{detailTarget.content}</div>
            <div className="hstack gap-6">
              <CopyButton value={detailTarget.content} label="复制内容" />
              <Button
                size="sm"
                variant="ghost"
                icon="sparkles"
                onClick={() => {
                  setContextQuery(detailTarget.content.slice(0, 80));
                  setContextTick((tick) => tick + 1);
                  setDetailTarget(null);
                }}
              >
                用于简报
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="新增项目记忆"
        description="手动写入一条项目共享记忆；任务完成时也会自动写入执行结论。"
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
    </div>
  );
}
