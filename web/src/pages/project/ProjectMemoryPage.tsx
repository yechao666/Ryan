import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MemoryHit } from '@shared';
import { api } from '@lib/api.ts';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
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
  SearchInput,
  SectionHead,
  Select,
  Skeleton,
  Textarea,
  useToast,
  type Tone,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';

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

/** 项目记忆浏览器：概览、筛选、详情、增删与上下文简报。 */
export function ProjectMemoryPage() {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const toast = useToast();

  const memories = useAsync(() => api.projectMemories(projectId, 200), [projectId], true);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('all');
  const [source, setSource] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const selected = filtered.find((hit) => hit.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (!selected && selectedId) setSelectedId(null);
  }, [selected, selectedId]);

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
      setDeleteTarget(null);
      setSelectedId(null);
      await memories.refresh();
      setContextTick((tick) => tick + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除记忆失败');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="ws-page">
      <PageHead
        title="项目记忆"
        desc="Aiwo 内置的项目记忆浏览器：查看任务沉淀、手动维护，并预览 DSH 可用的记忆上下文。"
        actions={
          <div className="hstack gap-6">
            <Button
              variant="ghost"
              icon="refresh"
              loading={memories.loading}
              onClick={() => void memories.refresh()}
            >
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
          <div className="card-sub">执行完成自动写回</div>
        </Card>
        <Card className="card-pad">
          <div className="pm-label">最近更新</div>
          <div className="pm-value" style={{ fontSize: 18 }}>{summary.latest ? fmtRelative(summary.latest) : '—'}</div>
          <div className="card-sub">记忆身份 <span className="mono">{identity}</span></div>
        </Card>
      </div>

      <div
        className="grid"
        style={{ gridTemplateColumns: 'minmax(0, 1.45fr) minmax(320px, 0.85fr)', alignItems: 'start', gap: 14 }}
      >
        <Card className="card-pad">
          <SectionHead
            title={
              <>
                <Icon name="brain" size={14} />
                记忆浏览器
              </>
            }
            desc="按内容搜索，按类型和来源筛选；点击一条记忆查看完整内容。"
            actions={<span className="tiny dim">{filtered.length} / {all.length} 条</span>}
          />

          <div className="toolbar mt-12">
            <div className="toolbar-left">
              <SearchInput
                value={keyword}
                onChange={setKeyword}
                placeholder="搜索记忆内容或标题…"
                className="ws-search"
              />
              <Select value={category} options={CATEGORY_OPTIONS} onChange={(event) => setCategory(event.target.value)} />
              <Select value={source} options={SOURCE_OPTIONS} onChange={(event) => setSource(event.target.value)} />
            </div>
          </div>

          <div className="mt-12">
            {memories.loading && !memories.data ? (
              <div className="vstack gap-8">
                {[0, 1, 2, 3].map((item) => <Skeleton key={item} h={74} />)}
              </div>
            ) : memories.error ? (
              <ErrorState message={memories.error} onRetry={() => void memories.refresh()} />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon="brain"
                title={all.length ? '没有匹配的记忆' : '还没有项目记忆'}
                description={all.length ? '调整搜索、类型或来源筛选。' : '任务完成后会自动写入执行结论，也可以手动新增。'}
                action={!all.length ? <Button size="sm" variant="primary" icon="plus" onClick={() => setAddOpen(true)}>新增记忆</Button> : undefined}
                compact
              />
            ) : (
              <div className="ws-memory-list">
                {filtered.map((hit) => {
                  const meta = categoryMeta(hit.category);
                  const active = selected?.id === hit.id;
                  return (
                    <div
                      className={`ws-memory-hit${active ? ' active' : ''}`}
                      key={hit.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(hit.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(hit.id);
                        }
                      }}
                    >
                      <div className="between ws-memory-hit-head">
                        <div className="hstack gap-6 wrap">
                          <Badge size="sm" tone={meta.tone}>{meta.label}</Badge>
                          <Badge size="sm" tone="slate">{sourceLabel(hit.source)}</Badge>
                          {hit.title ? <span className="small strong truncate">{hit.title}</span> : null}
                        </div>
                        <span className="tiny dim" title={hit.createdAt}>{fmtRelative(hit.createdAt)}</span>
                      </div>
                      <p className="mem-content clamp-2">{hit.content}</p>
                      <div className="mem-meta">
                        {hit.taskId ? (
                          <Link
                            className="ws-link"
                            to={`${base}/tasks/${encodeURIComponent(hit.taskId)}`}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Icon name="list" size={11} />
                            {hit.taskId.slice(0, 10)}
                          </Link>
                        ) : null}
                        <span className="mono">#{hit.id.slice(0, 8)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        <Card className="card-pad">
          <SectionHead
            title={
              <>
                <Icon name="book" size={14} />
                记忆详情
              </>
            }
            desc="项目共享记忆，任务需要时通过记忆工具检索。"
          />
          {!selected ? (
            <EmptyState icon="brain" title="选择一条记忆" description="从左侧列表选择记忆查看完整内容。" compact />
          ) : (
            <div className="vstack gap-10 mt-12">
              <div className="hstack gap-6 wrap">
                <Badge tone={categoryMeta(selected.category).tone}>{categoryMeta(selected.category).label}</Badge>
                <Badge tone="slate">{sourceLabel(selected.source)}</Badge>
                <span className="tiny dim">{fmtRelative(selected.createdAt)}</span>
              </div>
              <div>
                <div className="card-title">{selected.title || '未命名记忆'}</div>
                <div className="tiny dim mono">#{selected.id}</div>
              </div>
              <div className="ws-mem-preview" style={{ maxHeight: 360 }}>
                {selected.content}
              </div>
              <div className="hstack gap-6 wrap">
                <CopyButton value={selected.content} label="复制内容" />
                {selected.taskId ? (
                  <Link className="btn btn-sm btn-outline" to={`${base}/tasks/${encodeURIComponent(selected.taskId)}`}>
                    <Icon name="list" size={12} />
                    查看来源任务
                  </Link>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="sparkles"
                  onClick={() => {
                    setContextQuery(selected.content.slice(0, 80));
                    setContextTick((tick) => tick + 1);
                  }}
                >
                  用于简报
                </Button>
                <Button size="sm" variant="danger" icon="trash" onClick={() => setDeleteTarget(selected)}>
                  删除
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card className="card-pad">
        <SectionHead
          title={
            <>
              <Icon name="sparkles" size={14} />
              任务上下文简报
            </>
          }
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
                <span className="tiny dim">
                  约 {fmtInt(context.data.tokenEstimate)} tokens · {(context.data.citations ?? []).length} 条引用
                </span>
                <CopyButton value={context.data.prompt} label="复制简报" />
              </div>
              {context.data.citations?.length ? (
                <div className="ws-citation-row">
                  {context.data.citations.slice(0, 8).map((citation) => (
                    <code className="ws-placeholder" key={citation}>{citation}</code>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </Card>

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
