import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { RuntimeEvent } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDateTime, fmtDuration, fmtInt, fmtRelative } from '@lib/format.ts';
import { useAsync, useInterval } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  Drawer,
  EmptyState,
  ErrorState,
  Icon,
  SectionHead,
  Skeleton,
  Tabs,
  useToast,
} from '@ui';
import { useProject } from './context.ts';
import { TaskConversation } from './TaskConversation.tsx';
import { Markdown } from './Markdown.tsx';
import {
  isActiveTask,
  priorityMeta,
  promptCardCategoryMeta,
  taskSourceLabel,
  taskStatusMeta,
  taskTypeMeta,
} from './meta.ts';


const RUNTIME_META: Record<string, { label: string; tone: 'violet' | 'cyan' | 'amber' | 'green' | 'red' | 'slate' | 'blue'; icon: 'terminal' | 'checkCircle' | 'xCircle' | 'activity' | 'brain' }> = {
  session: { label: '会话', tone: 'violet', icon: 'terminal' },
  status: { label: '状态', tone: 'blue', icon: 'activity' },
  thinking: { label: '思考', tone: 'slate', icon: 'brain' },
  text: { label: '输出', tone: 'cyan', icon: 'terminal' },
  tool_call: { label: '工具调用', tone: 'amber', icon: 'terminal' },
  tool_result: { label: '工具结果', tone: 'green', icon: 'checkCircle' },
  final: { label: '完成', tone: 'green', icon: 'checkCircle' },
  error: { label: '错误', tone: 'red', icon: 'xCircle' },
};

function runtimeSummary(event: RuntimeEvent): string {
  const p = event.payload;
  switch (event.type) {
    case 'session':
      return `DSH 会话 ${String(p.sessionId ?? '').slice(0, 18)} 已启动`;
    case 'tool_call': {
      const input = p.input as Record<string, unknown> | undefined;
      const detail =
        input && typeof input.command === 'string'
          ? input.command
          : input
            ? JSON.stringify(input)
            : '';
      return `调用 ${String(p.tool ?? 'tool')}${detail ? ` · ${detail.slice(0, 90)}` : ''}`;
    }
    case 'tool_result': {
      const result = typeof p.result === 'string' ? p.result.replace(/\s+/g, ' ') : '';
      return `${String(p.status ?? 'completed')}${result ? ` · ${result.slice(0, 90)}` : ''}`;
    }
    case 'text':
      return String(p.text ?? '').replace(/\s+/g, ' ').slice(0, 160) || '模型输出';
    case 'thinking':
      return '模型思考中…';
    case 'status':
      return `阶段 ${String(p.phase ?? '')}${p.turn ? ` · turn ${String(p.turn)}` : ''}`;
    case 'final':
      return '本轮执行完成';
    case 'error':
      return String(p.message ?? '运行错误').slice(0, 160);
    default:
      return event.type;
  }
}

function RuntimeRow({ event }: { event: RuntimeEvent }) {
  const meta = RUNTIME_META[event.type] ?? { label: event.type, tone: 'slate' as const, icon: 'activity' as const };
  return (
    <details className="ws-runtime-row">
      <summary>
        <span className={`ws-runtime-icon tone-${meta.tone}`}>
          <Icon name={meta.icon} size={12} />
        </span>
        <span className="ws-runtime-type">{meta.label}</span>
        <span className="ws-runtime-summary">{runtimeSummary(event)}</span>
        <span className="ws-runtime-time">{fmtDateTime(event.createdAt).slice(11, 19)}</span>
      </summary>
      <pre className="ws-runtime-payload">{JSON.stringify(event.payload, null, 2).slice(0, 6000)}</pre>
    </details>
  );
}

export interface TaskDrawerProps {
  /** 打开的任务 ID；为 null 时关闭抽屉。 */
  taskId: string | null;
  onClose: () => void;
  /** 任务状态或消息变化后通知外层刷新列表。 */
  onChanged?: () => void;
  /** 作为独立页面内联渲染，不套抽屉壳。 */
  inline?: boolean;
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ws-meta-item">
      <span className="ws-meta-label">{label}</span>
      <span className="ws-meta-value">{children}</span>
    </div>
  );
}

/**
 * 任务抽屉：展示任务详情、事件时间线与会话消息，支持发送消息、取消任务、
 * 查看记忆上下文；每 5 秒轮询并通过 SSE 在任务事件到达时立即刷新。
 */
export function TaskDrawer({ taskId, onClose, onChanged, inline = false }: TaskDrawerProps) {
  const { detail: projectDetail } = useProject();
  const projectId = projectDetail.project.id;
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [runtimeRawOpen, setRuntimeRawOpen] = useState(false);
  const [tab, setTab] = useState<'result' | 'process'>('process');

  const query = useAsync(() => api.task(taskId ?? ''), [taskId], Boolean(taskId));
  const refresh = query.refresh;

  // 同一次挂载内切换任务时，只展示与当前 ID 匹配的数据，避免闪现上一条任务。
  const detail = query.data && query.data.task.id === taskId ? query.data : null;
  const task = detail?.task ?? null;

  useEffect(() => {
    if (!task) return;
    setTab(['done', 'failed', 'cancelled'].includes(task.status) ? 'result' : 'process');
  }, [task?.id, task?.status]);

  useEffect(() => {
    setMemoryOpen(false);
    setMemoryExpanded(false);
    setConfirmCancel(false);
    setRuntimeEvents([]);
    setRuntimeRawOpen(false);
  }, [taskId]);

  const appendRuntime = useCallback((incoming: RuntimeEvent[]) => {
    if (incoming.length === 0) return;
    setRuntimeEvents((prev) => {
      const seen = new Set(prev.map((event) => event.id));
      const next = [...prev, ...incoming.filter((event) => !seen.has(event.id))].sort((a, b) => a.seq - b.seq);
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }, []);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    api
      .runtimeEvents(taskId)
      .then((events) => {
        if (!cancelled) appendRuntime(events);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, appendRuntime]);

  // 每 5 秒轮询一次，任务结束后也保留一次刷新以拿到最终状态。
  useInterval(() => {
    if (taskId) void refresh();
  }, taskId ? 5000 : null);

  // SSE 断线兜底：运行中每 5 秒补齐一次运行时事件。
  const lastRuntimeSeq = runtimeEvents.at(-1)?.seq ?? 0;
  useInterval(() => {
    if (!taskId) return;
    api
      .runtimeEvents(taskId, lastRuntimeSeq)
      .then((items) => appendRuntime(items))
      .catch(() => undefined);
  }, taskId ? 5000 : null);

  // 订阅 SSE：只响应当前任务的事件。
  useEffect(() => {
    if (!taskId) return;
    return api.subscribeEvents((event) => {
      if (event.taskId !== taskId) return;
      if (event.type === 'task.runtime' && event.runtime) {
        appendRuntime([event.runtime]);
        if (event.runtime.type === 'final' || event.runtime.type === 'error') void refresh();
        return;
      }
      void refresh();
    }, projectId);
  }, [taskId, projectId, refresh]);

  const memoryAgentId = detail?.memory.memoryAgentId;
  const memory = useAsync(
    () => api.memoryBrief(projectId),
    [memoryOpen, projectId],
    memoryOpen,
  );

  const notifyChanged = useCallback(() => {
    onChanged?.();
  }, [onChanged]);

  const handleRefresh = useCallback(async () => {
    await refresh();
    notifyChanged();
  }, [refresh, notifyChanged]);

  const handleCancel = useCallback(async () => {
    if (!taskId) return;
    setCancelling(true);
    try {
      await api.cancelTask(taskId);
      toast.success('任务已取消');
      setConfirmCancel(false);
      await refresh();
      notifyChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '取消任务失败，请重试。');
    } finally {
      setCancelling(false);
    }
  }, [taskId, refresh, notifyChanged, toast]);

  const status = task ? taskStatusMeta(task.status) : null;
  const type = task ? taskTypeMeta(task.type) : null;
  const priority = task ? priorityMeta(task.priority) : null;

  const confirm = (
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => void handleCancel()}
        title="取消任务"
        description={`确认取消「${task?.title ?? ''}」？Aiwo 将停止执行该任务，操作不可撤销。`}
        confirmLabel="取消任务"
        loading={cancelling}
      />
  );

  const body = (
    <>
        {taskId && !task && query.loading ? (
          <div className="vstack gap-14">
            <Skeleton h={30} />
            <Skeleton h={82} style={{ borderRadius: 12 }} />
            <Skeleton h={140} style={{ borderRadius: 12 }} />
            <Skeleton h={180} style={{ borderRadius: 12 }} />
          </div>
        ) : null}

        {taskId && !task && query.error ? (
          <ErrorState message={query.error} onRetry={() => void refresh()} />
        ) : null}

        {task && status && priority ? (
          <>
            <div className="ws-drawer-toolbar">
              <div className="hstack gap-6 wrap">
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
                {type ? (
                  <Badge tone={type.tone} size="sm">
                    {type.label}
                  </Badge>
                ) : null}
                <Badge tone={priority.tone} size="sm">
                  优先级 {priority.label}
                </Badge>
                {task.instanceName ? (
                  <Badge tone="cyan" size="sm" dot>
                    {task.instanceName}
                  </Badge>
                ) : null}
              </div>
              <div className="hstack gap-4 wrap">
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => void handleRefresh()}>
                  刷新
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={memoryOpen ? 'chevronUp' : 'brain'}
                  onClick={() => {
                    setMemoryOpen((open) => !open);
                    setMemoryExpanded(false);
                  }}
                >
                  {memoryOpen ? '收起记忆' : '记忆上下文'}
                </Button>
                {isActiveTask(task.status) ? (
                  <Button size="sm" variant="danger" icon="xCircle" onClick={() => setConfirmCancel(true)}>
                    取消任务
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="ws-meta-grid">
              <MetaItem label="执行人">
                <span className="hstack gap-6">
                  <Icon name="user" size={12} />
                  {task.executorLabel || 'Aiwo'}
                </span>
              </MetaItem>
              <MetaItem label="服务">{task.instanceName || '自动分配'}</MetaItem>
              <MetaItem label="创建人">{task.createdByName || '—'}</MetaItem>
              <MetaItem label="创建时间">{fmtDateTime(task.createdAt)}</MetaItem>
              <MetaItem label="开始时间">{task.startedAt ? fmtDateTime(task.startedAt) : '—'}</MetaItem>
              <MetaItem label="结束时间">{task.finishedAt ? fmtDateTime(task.finishedAt) : '—'}</MetaItem>
              <MetaItem label="运行时长">{fmtDuration(task.startedAt, task.finishedAt)}</MetaItem>
              <MetaItem label="最近更新">{task.lastMessageAt ? fmtRelative(task.lastMessageAt) : '—'}</MetaItem>
            </div>

            <div className="ws-drawer-section">
              <SectionHead
                title="任务内容"
                desc="创建任务时填写的目标、背景与验收标准"
                actions={<CopyButton value={task.prompt.replace(/^\/goal\s*/i, '')} label="复制内容" />}
              />
              <div className="ws-task-prompt">
                <Markdown text={task.prompt.replace(/^\/goal\s*/i, '')} />
              </div>
            </div>

            {task.promptCards?.length > 0 || task.promptCardIds?.length > 0 ? (
              <div className="ws-drawer-section">
                <SectionHead
                  title="引用提示词"
                  desc={`${task.promptCards?.length || task.promptCardIds?.length || 0} 张卡片会随任务一起注入`}
                />
                <div className="ws-prompt-ref-grid">
                  {task.promptCards?.length > 0
                    ? task.promptCards.map((card) => {
                        const category = promptCardCategoryMeta(card.category);
                        return (
                          <div className="ws-prompt-ref-card" key={card.id}>
                            <span className="ws-prompt-ref-icon">
                              <Icon name="book" size={14} />
                            </span>
                            <div className="ws-prompt-ref-main">
                              <div className="ws-prompt-ref-name" title={card.name}>
                                {card.name}
                              </div>
                              <div className="ws-prompt-ref-meta">
                                <Badge tone={category.tone} size="sm">
                                  {category.label}
                                </Badge>
                                <span>随任务注入</span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    : (task.promptCardIds ?? []).map((id) => (
                        <div className="ws-prompt-ref-card" key={id}>
                          <span className="ws-prompt-ref-icon">
                            <Icon name="book" size={14} />
                          </span>
                          <div className="ws-prompt-ref-main">
                            <div className="ws-prompt-ref-name mono" title={id}>
                              {id.slice(0, 16)}
                            </div>
                            <div className="ws-prompt-ref-meta">随任务注入</div>
                          </div>
                        </div>
                      ))}
                </div>
              </div>
            ) : null}

            {memoryOpen ? (
              <div className="ws-drawer-section">
                <SectionHead
                  title="记忆简报"
                  desc={memoryAgentId ? `项目记忆身份 ${memoryAgentId} · 最近记忆/洞见摘要` : '最近记忆/洞见摘要'}
                />
                {memory.loading && !memory.data ? (
                  <Skeleton h={110} style={{ borderRadius: 12 }} />
                ) : memory.error ? (
                  <ErrorState message={memory.error} onRetry={() => void memory.refresh()} />
                ) : memory.data ? (
                  (() => {
                    const prompt = memory.data.text || '（当前任务没有可用的记忆简报）';
                    const lines = prompt.split('\n');
                    const collapsible = lines.length > 12;
                    const code =
                      collapsible && !memoryExpanded
                        ? `${lines.slice(0, 12).join('\n')}\n…`
                        : prompt;
                    return (
                      <>
                        <CodeBlock title="memory brief" code={code} />
                        <div className="ws-mem-foot">
                          <span className="tiny dim">
                            {memory.data.count} 条最近记忆 · 上限 {memory.data.maxChars} 字
                          </span>
                          <div className="hstack gap-4">
                            {collapsible ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={memoryExpanded ? 'chevronUp' : 'chevronDown'}
                                onClick={() => setMemoryExpanded((value) => !value)}
                              >
                                {memoryExpanded ? '收起' : '展开全部'}
                              </Button>
                            ) : null}
                            <CopyButton value={memory.data.text} label="复制简报" />
                          </div>
                        </div>
                      </>
                    );
                  })()
                ) : null}
              </div>
            ) : null}

            {task.allowedServiceNames?.length ? (
              <div className="ws-drawer-section">
                <SectionHead
                  title="服务调度范围"
                  desc={`任务只会在这些服务上运行${task.instanceName ? `；当前：${task.instanceName}` : ''}`}
                />
                <div className="badge-dot-list">
                  {task.allowedServiceNames.map((name, index) => (
                    <span className="chip" key={`${name}-${index}`}>
                      <Icon name="server" size={11} />
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="ws-drawer-section">
              <SectionHead
                title="任务输出"
                desc="完成后默认展示结果；过程只读"
                actions={
                  <Badge tone={isActiveTask(task.status) ? 'green' : 'slate'} size="sm" dot>
                    {isActiveTask(task.status) ? '实时' : '历史'}
                  </Badge>
                }
              />
              <Tabs
                tabs={[
                  { key: 'result', label: '结果' },
                  { key: 'process', label: '过程', count: runtimeEvents.length },
                ]}
                value={tab}
                onChange={(key) => setTab(key as 'result' | 'process')}
              />
              {tab === 'result' ? (
                <div className="ws-result">
                  {task.error ? (
                    <Callout tone="red" icon="xCircle">
                      <div className="ws-strong-line">错误信息</div>
                      <div className="ws-pre">{task.error}</div>
                    </Callout>
                  ) : null}
                  {task.result ? (
                    <Markdown text={task.result} />
                  ) : (
                    <EmptyState
                      icon="checkCircle"
                      title="暂无结果"
                      description={task.error ? '任务失败，错误信息见上方。' : '本次任务没有写入结果，可切换到过程查看。'}
                      action={
                        <Button size="sm" variant="ghost" onClick={() => setTab('process')}>
                          查看过程
                        </Button>
                      }
                      compact
                    />
                  )}
                </div>
              ) : (
                <>
                  <TaskConversation
                    events={runtimeEvents}
                    running={isActiveTask(task.status)}
                    executorLabel={task.executorLabel}
                  />
                  <div className="ws-rt-toolbar">
                    <button
                      type="button"
                      className="ws-rt-raw-toggle"
                      onClick={() => setRuntimeRawOpen((open) => !open)}
                    >
                      {runtimeRawOpen ? '收起原始事件' : '查看原始事件'}
                      <span className="tiny dim">{runtimeEvents.length}</span>
                    </button>
                  </div>
                  {runtimeRawOpen ? (
                    <div className="ws-runtime-log">
                      {runtimeEvents.length ? (
                        runtimeEvents.map((event) => <RuntimeRow key={event.id} event={event} />)
                      ) : (
                        <div className="ws-runtime-empty">暂无原始事件。</div>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </>
        ) : null}
    </>
  );

  if (inline) {
    return (
      <div className="ws-task-page">
        <header className="ws-task-page-head">
          <div style={{ minWidth: 0 }}>
            <div className="ws-task-page-eyebrow">任务 · TASK</div>
            <h1 className="ws-task-page-title">{task?.title ?? '任务详情'}</h1>
            <div className="tiny dim">
              {task
                ? `#${task.id.slice(0, 12)} · ${taskSourceLabel(task.source)} · ${task.executorLabel || 'Aiwo'}`
                : '正在加载任务…'}
            </div>
          </div>
          <div className="hstack gap-6">
            <Button size="sm" variant="ghost" icon="chevronLeft" onClick={onClose}>
              返回任务
            </Button>
          </div>
        </header>
        {body}
        {confirm}
      </div>
    );
  }

  return (
    <>
      <Drawer
        open={Boolean(taskId)}
        onClose={onClose}
        wide
        title={task ? task.title : '任务详情'}
        subtitle={
          task
            ? `#${task.id.slice(0, 8)} · ${taskSourceLabel(task.source)} · ${task.executorLabel || 'Aiwo'}`
            : '正在加载任务…'
        }
      >
        {body}
      </Drawer>
      {confirm}
    </>
  );
}

