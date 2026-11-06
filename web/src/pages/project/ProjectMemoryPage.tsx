import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
  Icon,
  Input,
  PageHead,
  SearchInput,
  SectionHead,
  Select,
  Skeleton,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';

const TOP_K_OPTIONS = [
  { value: '5', label: '5 条' },
  { value: '8', label: '8 条' },
  { value: '12', label: '12 条' },
];

/** 项目记忆：语义搜索 + 任务记忆简报预览。 */
export function ProjectMemoryPage() {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const [params] = useSearchParams();

  const agents = useAsync(() => api.projectAgents(projectId), [projectId]);
  const [agentId, setAgentId] = useState(params.get('agentId') ?? '');
  const [keyword, setKeyword] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [topK, setTopK] = useState('8');
  const [contextQuery, setContextQuery] = useState('');
  const [contextTick, setContextTick] = useState(0);

  const memoryOptions = useMemo(
    () =>
      (agents.data ?? [])
        .filter((item) => Boolean(item.memoryAgentId))
        .map((item) => ({ value: item.agentId, label: item.agent.name })),
    [agents.data],
  );
  const selectedAgentId = memoryOptions.some((option) => option.value === agentId)
    ? agentId
    : (memoryOptions[0]?.value ?? '');

  const search = useAsync(
    () => api.memorySearch(projectId, submitted ?? '', selectedAgentId || undefined, Number(topK)),
    [projectId, submitted, selectedAgentId, topK],
    Boolean(submitted) && Boolean(selectedAgentId),
  );

  const context = useAsync(
    () => api.memoryContext(projectId, selectedAgentId || undefined, contextQuery.trim() || undefined),
    [projectId, selectedAgentId, contextTick],
    Boolean(selectedAgentId) && detail.project.mnemosConfigured,
  );

  const runSearch = () => {
    const next = keyword.trim();
    if (!next) return;
    setSubmitted(next);
  };

  const configured = detail.project.mnemosConfigured;
  const hits = search.data?.hits ?? [];
  const notReady =
    agents.error && !agents.data
      ? agents.error
      : null;

  return (
    <div className="ws-page">
      <PageHead
        title="项目记忆"
        desc="搜索项目在 Mnemos 中沉淀的记忆，并预览任务下发时会注入的上下文。"
        actions={
          <Link className="ws-link small" to={`${base}/settings`}>
            <Icon name="settings" size={13} />
            Mnemos 设置
          </Link>
        }
      />

      {notReady ? (
        <Card>
          <div style={{ padding: 18 }}>
            <ErrorState message={notReady} onRetry={() => void agents.refresh()} />
          </div>
        </Card>
      ) : agents.loading && !agents.data ? (
        <div className="vstack gap-14">
          <Skeleton h={72} style={{ borderRadius: 14 }} />
          <Skeleton h={148} style={{ borderRadius: 14 }} />
          <Skeleton h={280} style={{ borderRadius: 14 }} />
        </div>
      ) : !configured ? (
        <Card>
          <EmptyState
            icon="brain"
            title="尚未配置 Mnemos 集成"
            description="为项目配置 Mnemos 项目 ID 与 API Key 后，智员执行任务时会自动检索并注入项目记忆。"
            action={
              <Link className="btn btn-sm btn-outline" to={`${base}/settings`}>
                <Icon name="settings" size={13} />
                前往设置
              </Link>
            }
          />
        </Card>
      ) : !memoryOptions.length ? (
        <Card>
          <EmptyState
            icon="bot"
            title="暂无可用记忆智员"
            description="关联智员并为其设置记忆智员 ID（memoryAgentId）后，才能检索记忆与生成任务简报。"
            action={
              <Link className="btn btn-sm btn-outline" to={`${base}/agents`}>
                <Icon name="link" size={13} />
                关联智员
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
                  语义搜索
                </>
              }
              desc="在项目记忆库中按语义检索，命中结果按相关度排序。"
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
                <Select
                  value={selectedAgentId}
                  options={memoryOptions}
                  onChange={(event) => setAgentId(event.target.value)}
                />
                <Select
                  value={topK}
                  options={TOP_K_OPTIONS}
                  onChange={(event) => setTopK(event.target.value)}
                />
                <Button
                  variant="primary"
                  icon="search"
                  disabled={!keyword.trim()}
                  onClick={runSearch}
                >
                  搜索
                </Button>
              </div>
              <div className="toolbar-right">
                <span className="tiny dim">
                  {submitted
                    ? `查询「${submitted}」`
                    : '输入关键词后按回车或点击搜索'}
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
                  {search.data.error ?? 'Mnemos 尚未就绪，无法检索记忆。请检查项目设置中的集成配置。'}
                </Callout>
              ) : !hits.length ? (
                <EmptyState
                  icon="search"
                  title="没有命中记忆"
                  description="换个说法或放宽关键词；记忆需要智员在完成任务后才会沉淀。"
                  compact
                />
              ) : (
                <>
                  <div className="between ws-mem-summary">
                    <span className="tiny dim">
                      命中 {fmtInt(hits.length)} 条 · 耗时 {fmtMs(search.data?.tookMs)}
                    </span>
                    <span className="tiny dim">智员 {selectedAgentId}</span>
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
                            {hit.agentId ? (
                              <span className="hstack gap-4">
                                <Icon name="bot" size={11} />
                                {hit.agentId}
                              </span>
                            ) : null}
                            {hit.taskId ? (
                              <span className="hstack gap-4">
                                <Icon name="list" size={11} />
                                {hit.taskId.slice(0, 8)}
                              </span>
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
              desc="模拟任务下发时注入给智员的记忆上下文，并估算 token 消耗。"
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
                  {context.data.error ?? 'Mnemos 尚未就绪，无法生成任务简报。'}
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
    </div>
  );
}
