import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '@lib/api.ts';
import { Badge, Button, Icon, IconButton, Textarea, useToast } from '@ui';
import { Markdown } from '../project/Markdown.tsx';

interface ThinkingBlock {
  id: string;
  kind: 'thinking';
  text: string;
  done: boolean;
}

interface ToolBlock {
  id: string;
  kind: 'tool';
  callId?: string;
  tool: string;
  input?: unknown;
  result?: string;
  status?: string;
  done: boolean;
}

type ProcessBlock = ThinkingBlock | ToolBlock;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tone?: 'error';
  streaming?: boolean;
  status?: string;
  process?: ProcessBlock[];
  processOpen?: boolean;
}

const WELCOME =
  '我是 Aiwo 系统助手，运行在 DSH 实例中。可以读取项目、任务、实例与提示词卡片，并通过 Aiwo API 直接创建任务、配置实例或查询状态。';

function uid(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function statusLabel(phase: string): string {
  switch (phase) {
    case 'turn_start': return '正在理解请求…';
    case 'step_start': return '正在思考并执行…';
    case 'step_end': return '正在整理结果…';
    case 'turn_end': return '正在收尾…';
    default: return '正在处理…';
  }
}

function inputText(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const record = input as Record<string, unknown>;
  if (typeof record.command === 'string') return record.command;
  if (typeof record.path === 'string') return record.path;
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function ProcessPanel({ message, onToggle }: { message: ChatMessage; onToggle: () => void }) {
  const blocks = message.process ?? [];
  if (blocks.length === 0) return null;
  const toolCount = blocks.filter((block) => block.kind === 'tool').length;
  const showBody = Boolean(message.processOpen);
  return (
    <div className={`cx-process ${message.streaming ? 'is-live' : ''}`}>
      <button type="button" className="cx-process-head" onClick={onToggle} aria-expanded={showBody}>
        <span className="cx-process-title">
          <Icon name="brain" size={12} />
          过程
        </span>
        <span className="cx-process-count">
          {blocks.length} 段{toolCount ? ` · ${toolCount} 个工具` : ''}
        </span>
        <span className="cx-process-toggle">{message.streaming ? '实时' : message.processOpen ? '收起' : '展开'}</span>
      </button>
      {showBody ? (
        <div className="cx-process-body">
          {blocks.map((block, index) => {
            const active = message.streaming && index === blocks.length - 1;
            const bodyVisible = message.streaming ? active : Boolean(message.processOpen);
            return (
              <div className={`cx-process-step${active ? ' is-active' : ''}`} key={block.id}>
                <div className="cx-process-step__head">
                  <span className={`cx-process-step__icon tone-${block.kind === 'thinking' ? 'violet' : 'amber'}`}>
                    <Icon name={block.kind === 'thinking' ? 'brain' : 'terminal'} size={11} />
                  </span>
                  <span className="cx-process-step__name">
                    {block.kind === 'thinking' ? '思考' : block.tool}
                  </span>
                  {block.kind === 'thinking' ? (
                    <span className="cx-process-step__meta">{block.text.length} 字</span>
                  ) : (
                    <span className="cx-process-step__meta">
                      {block.done ? block.result?.trim().slice(0, 24) || '完成' : block.status === 'completed' ? '完成' : '执行中…'}
                    </span>
                  )}
                </div>
                {bodyVisible ? (
                  <div className="cx-process-step__body">
                    {block.kind === 'thinking' ? (
                      <div className="cx-process-thinking">{block.text}</div>
                    ) : (
                      <>
                        {inputText(block.input) ? <pre className="cx-process-code">{inputText(block.input)}</pre> : null}
                        {block.result?.trim() ? <pre className="cx-process-result">{block.result.trim().slice(0, 4_000)}</pre> : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function Assistant() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const taskId = new URLSearchParams(search).get('task') ?? undefined;
  const fullPath = `${pathname}${search}`;
  const pageTitle =
    (pathname.startsWith('/prompt-cards') && '提示词卡片') ||
    (pathname.startsWith('/settings') && '系统设置') ||
    (pathname.startsWith('/instances') && 'DSH 实例') ||
    (pathname.startsWith('/tasks') && '全局任务') ||
    (pathname.includes('/tasks') && '项目任务') ||
    (pathname.startsWith('/projects') && '项目') ||
    (pathname.startsWith('/teams') && '团队') ||
    (pathname === '/' && '概览') ||
    'Aiwo';

  const [open, setOpen] = useState(() => localStorage.getItem('aiwo.assistant.open') !== '0');
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('aiwo.assistant.width'));
    return Number.isFinite(saved) && saved >= 320 ? Math.min(720, saved) : 430;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 'welcome', role: 'assistant', text: WELCOME }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    localStorage.setItem('aiwo.assistant.open', open ? '1' : '0');
  }, [open]);
  useEffect(() => {
    localStorage.setItem('aiwo.assistant.width', String(width));
  }, [width]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const patchMessage = (id: string, patch: (message: ChatMessage) => Partial<ChatMessage>): void => {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...patch(message) } : message)));
  };

  const updateProcess = (id: string, updater: (blocks: ProcessBlock[]) => ProcessBlock[]): void => {
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, process: updater(message.process ?? []) } : message
    )));
  };

  const finishProcess = (id: string): void => {
    updateProcess(id, (blocks) => blocks.map((block) => ({ ...block, done: true })));
  };

  const send = async (raw?: string): Promise<void> => {
    const message = (raw ?? input).trim();
    if (!message || busy) return;
    setInput('');
    const assistantId = uid();
    setMessages((current) => [
      ...current,
      { id: uid(), role: 'user', text: message },
      {
        id: assistantId,
        role: 'assistant',
        text: '',
        streaming: true,
        status: '正在连接 DSH 助手…',
        process: [],
        processOpen: true,
      },
    ]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let failed = false;

    try {
      await api.assistantChatStream(
        {
          message,
          pathname: fullPath,
          projectId: projectId ? decodeURIComponent(projectId) : undefined,
          taskId,
        },
        {
          onStatus: (data) => {
            patchMessage(assistantId, (current) => ({
              status: current.text ? undefined : statusLabel(data.phase),
            }));
          },
          onThinking: (delta, start) => {
            if (!delta) return;
            updateProcess(assistantId, (blocks) => {
              const last = blocks[blocks.length - 1];
              if (!start && last?.kind === 'thinking' && !last.done) {
                return [...blocks.slice(0, -1), { ...last, text: last.text + delta }];
              }
              return [...blocks, { id: uid(), kind: 'thinking', text: delta, done: false }];
            });
            patchMessage(assistantId, () => ({ status: '正在思考…', processOpen: true }));
          },
          onTool: (data) => {
            updateProcess(assistantId, (blocks) => {
              const next = blocks.map((block) => (
                block.kind === 'thinking' ? { ...block, done: true } : block
              ));
              if (data.kind === 'tool_call') {
                const index = data.callId ? next.findIndex((block) => block.kind === 'tool' && block.callId === data.callId) : -1;
                const toolBlock: ToolBlock = {
                  id: data.callId || uid(),
                  kind: 'tool',
                  callId: data.callId,
                  tool: data.tool || 'tool',
                  input: data.input,
                  status: data.status,
                  done: false,
                };
                if (index >= 0) {
                  return next.map((block, position) => (position === index ? { ...toolBlock } : block));
                }
                return [...next, toolBlock];
              }
              const index = data.callId ? next.findIndex((block) => block.kind === 'tool' && block.callId === data.callId) : -1;
              if (index >= 0) {
                return next.map((block, position) => (
                  position === index && block.kind === 'tool'
                    ? { ...block, result: data.result, status: data.status, done: true }
                    : block
                ));
              }
              return [...next, {
                id: data.callId || uid(),
                kind: 'tool',
                callId: data.callId,
                tool: data.tool || 'tool',
                result: data.result,
                status: data.status,
                done: true,
              }];
            });
            patchMessage(assistantId, () => ({
              status: data.kind === 'tool_call' ? `正在调用 ${data.tool || '工具'}…` : undefined,
              processOpen: true,
            }));
          },
          onText: (delta) => {
            finishProcess(assistantId);
            patchMessage(assistantId, (current) => ({
              text: current.text + delta,
              status: undefined,
              processOpen: false,
            }));
          },
          onDone: (result) => {
            finishProcess(assistantId);
            patchMessage(assistantId, (current) => ({
              text: result.reply || current.text || '已完成。',
              streaming: false,
              status: undefined,
              processOpen: false,
            }));
            window.dispatchEvent(new CustomEvent('aiwo:assistant-refresh'));
            if (result.navigate) navigate(result.navigate);
          },
          onError: (text) => {
            failed = true;
            finishProcess(assistantId);
            patchMessage(assistantId, () => ({
              text,
              tone: 'error',
              streaming: false,
              status: undefined,
              processOpen: false,
            }));
            toast.error(text);
          },
        },
        controller.signal,
      );
      patchMessage(assistantId, () => ({ streaming: false, status: undefined }));
      if (!failed) window.dispatchEvent(new CustomEvent('aiwo:assistant-refresh'));
    } catch (error) {
      if (controller.signal.aborted) {
        finishProcess(assistantId);
        patchMessage(assistantId, (current) => ({
          text: current.text || '已停止生成。',
          streaming: false,
          status: undefined,
          processOpen: false,
        }));
      } else {
        const text = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '助手请求失败';
        finishProcess(assistantId);
        patchMessage(assistantId, () => ({
          text,
          tone: 'error',
          streaming: false,
          status: undefined,
          processOpen: false,
        }));
        toast.error(text);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const beginResize = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => {
      setWidth(Math.min(720, Math.max(320, startWidth + (startX - moveEvent.clientX))));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const suggestions = [
    '创建一个任务：为计算器补充乘法边界测试',
    '列出当前项目的 DSH 实例和绑定情况',
    '帮我生成一个每日开发简报自动化',
  ];

  return (
    <div className={`cx-assistant ${open ? 'is-open' : ''}`} style={open ? { width } : undefined}>
      {open ? (
        <section className="cx-assistant-panel" aria-label="Aiwo 助手">
          <span className="cx-assistant-resize" title="拖动调整宽度" onPointerDown={beginResize} />
          <header className="cx-assistant-head">
            <div className="cx-assistant-brand">
              <span className="cx-assistant-brand__mark">A</span>
              <div style={{ minWidth: 0 }}>
                <div className="cx-assistant-brand__title">
                  Aiwo 助手
                  <Badge size="sm" tone="cyan">DSH 实例</Badge>
                </div>
                <div className="cx-assistant-brand__sub">人员 @Aiwo · 可直接调用 Aiwo API</div>
              </div>
            </div>
            <IconButton icon="x" label="收起助手" size="sm" onClick={() => setOpen(false)} />
          </header>

          <div className="cx-assistant-context">
            <div className="cx-assistant-context__main">
              <span className="cx-assistant-context__page">
                <Icon name="panelLeft" size={12} />
                {pageTitle}
              </span>
              {projectId ? <Badge size="sm" tone="cyan">{decodeURIComponent(projectId)}</Badge> : <span className="cx-assistant-context__empty">未选择项目</span>}
              {taskId ? <Badge size="sm" tone="amber">任务 {taskId.slice(0, 10)}</Badge> : null}
            </div>
            <div className="cx-assistant-context__path mono" title={fullPath}>{fullPath}</div>
          </div>

          <div className="cx-assistant-messages" ref={scrollRef}>
            {messages.map((message) => (
              <div key={message.id} className={`cx-assistant-msg cx-assistant-msg--${message.role}`}>
                {message.role === 'assistant' ? <span className="cx-assistant-avatar">A</span> : null}
                <div className="cx-assistant-bubble">
                  {message.role === 'assistant' ? (
                    <ProcessPanel
                      message={message}
                      onToggle={() => patchMessage(message.id, (current) => ({ processOpen: !current.processOpen }))}
                    />
                  ) : null}
                  <div className={`cx-assistant-text${message.tone ? ' cx-assistant-text--error' : ''}`}>
                    {message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}
                  </div>
                  {message.streaming && !message.text && (!message.process || message.process.length === 0) ? (
                    <div className="cx-assistant-streaming">
                      <span className="cx-assistant-typing"><span /><span /><span /></span>
                      <span className="cx-assistant-stream-status">{message.status ?? '正在思考…'}</span>
                    </div>
                  ) : null}
                  {message.streaming && message.status && message.text ? (
                    <div className="cx-assistant-streaming cx-assistant-streaming--text">
                      <span className="cx-assistant-stream-status">{message.status}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="cx-assistant-suggestions">
            {suggestions.map((suggestion) => (
              <button key={suggestion} type="button" className="cx-assistant-chip" disabled={busy} onClick={() => void send(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>

          <form
            className="cx-assistant-input"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Textarea
              rows={2}
              value={input}
              placeholder="描述你想让 Aiwo 做的事，例如：创建任务、查看实例、生成自动化…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <Button type="submit" variant="primary" icon="send" loading={busy} disabled={!input.trim() || busy}>
              发送
            </Button>
          </form>
          <footer className="cx-assistant-foot">
            <span>Enter 发送 · Shift+Enter 换行</span>
            <span className="dim">DSH 实例 · Aiwo API</span>
          </footer>
        </section>
      ) : (
        <button type="button" className="cx-assistant-fab" title="打开 Aiwo 助手" onClick={() => setOpen(true)}>
          <span className="cx-assistant-fab__icon"><Icon name="sparkles" size={18} /></span>
          <span className="cx-assistant-fab__label">助手</span>
        </button>
      )}
    </div>
  );
}
