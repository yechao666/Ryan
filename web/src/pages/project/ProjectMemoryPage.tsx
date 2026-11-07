import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@lib/api.ts';
import { fmtInt, fmtMs, fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
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
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';

const TOP_K_OPTIONS = [
  { value: '5', label: '5 条' },
  { value: '8', label: '8 条' },
  { value: '12', label: '12 条' },
];

/** 项目记忆：语义搜索 + 任务记忆简报预览（使用项目级记忆身份）。 */
export function ProjectMemoryPage() {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const memoryAgentId = detail.project.memoryAgentId;

  const [keyword, setKeyword] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [topK, setTopK] = useState('8');
  const [contextQuery, setContextQuery] = useState('');
  const [contextTick, setContextTick] = useState(0);
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [memoryTitle, setMemoryTitle] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryCategory, setMemoryCategory] = useState('note');
  const [saving, setSaving] = useState(false);

  const search = useAsync(
    () => api.memorySearch(projectId, submitted ?? '', memoryAgentId, Number(topK)),
    [projectId, submitted, memoryAgentId, topK],
    Boolean(submitted),
  );

  const context = useAsync(
    () => api.memoryContext(projectId, memoryAgentId, contextQuery.trim() || undefined),
    [projectId, memoryAgentId, contextTick],
    true,
  );

  const runSearch = () => {
    const next = keyword.trim();
    if (!next) return;
    setSubmitted(next);
  };

  const configured = true;
  const hits = search.data?.hits ?? [];
  const identity = memoryAgentId || `aiwo_${detail.project.slug.replace(/-/g, '_')}`;

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
      setContextTick((tick) => tick + 1);
      if (submitted) await search.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '写入记忆失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ws-page">
      <PageHead
        title="项目记忆"
        desc="搜索 Aiwo 内部沉淀的项目记忆，并预览任务下发时会注入的上下文。"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            新增记忆
          </Button>
        }
      />

      {!configured ? (
        <Card>
          <EmptyState
            icon="brain"
            title="项目记忆尚未初始化"
            description="项目记忆由 Aiwo 内部维护；任务执行时会自动检索并注入记忆。"
            action={
              <Link className="btn btn-sm btn-outline" to={`${base}/settings`}>
                <Icon name="settings" size={13} />
                前往设置
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="card-pad">
            <SectionHead
              title={
                <>
                  <Icon name="search" size={14} />
                  记忆检索
                </>
              }
              desc="在项目内置记忆库中检索，命中结果按相关度与时间排序。"
              actions={
                <span className="tiny dim">
                  记忆身份 <span className="mono">{identity}</span>
                </span>
              }
            />

            <div className="toolbar mt-12">
              <div className="toolbar-left">
                <SearchInput
                  value={keyword}
                  onChange={setKeyword}
                  placeholder="搜索项目记忆，例如：登录鉴权方案"
                  onSubmit={runSearch}
                  className="ws-search"
                />
                <Select value={topK} options={TOP_K_OPTIONS} onChange={(event) => setTopK(event.target.value)} />
                <Button variant="primary" icon="search" disabled={!keyword.trim()} onClick={runSearch}>
                  搜索
                </Button>
              </div>
              <div className="toolbar-right">
                <span className="tiny dim">
                  {submitted ? `查询「${submitted}」` : '输入关键词后按回车或点击搜索'}
                </span>
              </div>
            </div>

            <div className="mt-16">
              {search.loading && !search.data ? (
                <div className="vstack gap-10">
                  {[0, 1, 2].map((item) => (
                    <Skeleton key={item} h={112} style={{ borderRadius: 12 }} />
                  ))}
                </div>
              ) : search.error ? (
                <ErrorState message={search.error} onRetry={() => void search.refresh()} />
              ) : !submitted ? (
                <EmptyState
                  icon="brain"
                  title="开始检索项目记忆"
                  description="输入问题或关键词，例如「支付回调验签」「发布流程约定」。"
                  compact
                />
              ) : search.data && !search.data.configured ? (
                <Callout tone="amber" icon="alert">
                  {search.data.error ?? '记忆检索暂时不可用。'}
                </Callout>
              ) : !hits.length ? (
                <EmptyState
                  icon="search"
                  title="没有命中记忆"
                  description="换个说法或放宽关键词；记忆需要任务执行完成后才会沉淀。"
                  compact
                />
              ) : (
                <>
                  <div className="between ws-mem-summary">
                    <span className="tiny dim">
                      命中 {fmtInt(hits.length)} 条 · 耗时 {fmtMs(search.data?.tookMs)}
                    </span>
                    <span className="tiny dim mono">{identity}</span>
                  </div>
                  <div className="ws-memory-list">
                    {hits.map((hit) => {
                      const score = Math.max(0, Math.min(1, hit.score));
                      const signals = Object.entries(hit.signals ?? {})
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5);
                      const maxSignal = signals.reduce((max, [, value]) => Math.max(max, value), 0);
                      return (
                        <div className="ws-memory-hit" key={hit.id}>
                          <div className="between ws-memory-hit-head">
                            <div className="hstack gap-6 wrap">
                              <Badge tone="violet" size="sm">
                                {hit.category || '未分类'}
                              </Badge>
                              <Badge tone="slate" size="sm">
                                {hit.visibility || 'private'}
                              </Badge>
                              <span className="tiny dim">{fmtRelative(hit.createdAt)}</span>
                            </div>
                            <div className="score-bar" title={`相关度 ${hit.score.toFixed(3)}`}>
                              <span className="score-track">
                                <span className="score-fill" style={{ width: `${Math.round(score * 100)}%` }} />
                              </span>
                              {score.toFixed(2)}
                            </div>
                          </div>
                          <p className="mem-content">{hit.content}</p>
                          <div className="mem-meta">
                            {hit.taskId ? (
                              <Link className="ws-link" to={`${base}/tasks/${encodeURIComponent(hit.taskId)}`}>
                                <Icon name="list" size={11} />
                                {hit.taskId.slice(0, 8)}
                              </Link>
                            ) : null}
                            <span className="mono">#{hit.id.slice(0, 8)}</span>
                          </div>
                          {signals.length ? (
                            <div className="signal-list ws-signal-list">
                              {signals.map(([key, value]) => (
                                <div className="signal-row" key={key}>
                                  <span className="truncate">{key}</span>
                                  <span className="signal-track">
                                    <span
                                      className="signal-fill"
                                      style={{ width: `${maxSignal > 0 ? Math.round((value / maxSignal) * 100) : 0}%` }}
                                    />
                                  </span>
                                  <span>{value.toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </Card>

          <Card className="card-pad">
            <SectionHead
              title={
                <>
                  <Icon name="sparkles" size={14} />
                  任务简报
                </>
              }
              desc="模拟任务下发时注入的记忆上下文，并估算 token 消耗。"
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  icon="refresh"
                  onClick={() => setContextTick((tick) => tick + 1)}
                >
                  重新生成
                </Button>
              }
            />

            <div className="toolbar mt-12">
              <div className="toolbar-left ws-context-form">
                <Input
                  value={contextQuery}
                  placeholder="可选：填写任务主题，让上下文更聚焦（例如：修复支付回调）"
                  onChange={(event) => setContextQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      setContextTick((tick) => tick + 1);
                    }
                  }}
                />
                <Button
                  variant="primary"
                  icon="sparkles"
                  loading={context.loading}
                  onClick={() => setContextTick((tick) => tick + 1)}
                >
                  生成简报
                </Button>
              </div>
            </div>

            <div className="mt-16">
              {context.loading && !context.data ? (
                <Skeleton h={220} style={{ borderRadius: 12 }} />
              ) : context.error ? (
                <ErrorState message={context.error} onRetry={() => void context.refresh()} />
              ) : context.data && !context.data.configured ? (
                <Callout tone="amber" icon="alert">
                  {context.data.error ?? '暂时无法生成任务简报。'}
                </Callout>
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
                        <code className="ws-placeholder" key={citation}>
                          {citation}
                        </code>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </Card>
        </>
      )}

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
    </div>
  );
}
