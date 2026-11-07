import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '@lib/api.ts';
import { fmtRelative } from '@lib/format.ts';
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

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
}

const WELCOME =
  '我是 Aiwo 系统助手，运行在 DSH 服务中。可以读取项目、任务、服务与提示词卡片，并通过 Aiwo API 直接创建任务、配置服务或查询状态。';
const STORAGE_CONVERSATIONS = 'aiwo.assistant.conversations.v1';
const STORAGE_ACTIVE = 'aiwo.assistant.activeConversation.v1';

function uid(prefix = 'm'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function welcomeMessage(): ChatMessage {
  return { id: uid('welcome'), role: 'assistant', text: WELCOME };
}

function createConversation(): Conversation {
  return {
    id: uid('conv'),
    title: '新会话',
    messages: [welcomeMessage()],
    updatedAt: new Date().toISOString(),
  };
}

function titleOf(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const text = first?.text.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 30) : '新会话';
}

function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [welcomeMessage()];
  const messages = input
    .filter((message): message is ChatMessage => Boolean(message && typeof message === 'object' && (message.role === 'user' || message.role === 'assistant')))
    .map((message) => ({
      ...message,
      streaming: false,
      status: undefined,
      process: Array.isArray(message.process)
        ? message.process.map((block) => ({ ...block, done: true }))
        : undefined,
      processOpen: false,
    }));
  return messages.length ? messages : [welcomeMessage()];
}

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_CONVERSATIONS);
    if (!raw) return [createConversation()];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [createConversation()];
    return parsed
      .filter((item): item is Conversation => Boolean(item && typeof item === 'object' && typeof item.id === 'string'))
      .map((item) => ({
        id: item.id,
        title: typeof item.title === 'string' ? item.title : '新会话',
        messages: sanitizeMessages(item.messages),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
      }));
  } catch {
    return [createConversation()];
  }
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
                      <div className="cx-process-thinking"><Markdown text={block.text} /></div>
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
    (pathname.startsWith('/instances') && 'DSH 服务') ||
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
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState(() => localStorage.getItem(STORAGE_ACTIVE) || '');
  const [menuOpen, setMenuOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const suggestionSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = conversations.find((conversation) => conversation.id === activeId) ?? conversations[0];
  const messages = active?.messages ?? [];

  useEffect(() => {
    if (!active) {
      const conversation = createConversation();
      setConversations([conversation]);
      setActiveId(conversation.id);
    } else if (active.id !== activeId) {
      setActiveId(active.id);
    }
  }, [active, activeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_CONVERSATIONS, JSON.stringify(conversations)); } catch { /* ignore */ }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [conversations]);

  useEffect(() => {
    if (activeId) localStorage.setItem(STORAGE_ACTIVE, activeId);
  }, [activeId]);

  useEffect(() => {
    localStorage.setItem('aiwo.assistant.open', open ? '1' : '0');
  }, [open]);

  useEffect(() => {
    localStorage.setItem('aiwo.assistant.width', String(width));
  }, [width]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, activeId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateMessages = (
    conversationId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ): void => {
    setConversations((current) => current.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      const nextMessages = updater(conversation.messages);
      return {
        ...conversation,
        messages: nextMessages,
        title: titleOf(nextMessages),
        updatedAt: new Date().toISOString(),
      };
    }));
  };

  const patchMessage = (
    conversationId: string,
    id: string,
    patch: (message: ChatMessage) => Partial<ChatMessage>,
  ): void => {
    updateMessages(conversationId, (current) => current.map((message) => (
      message.id === id ? { ...message, ...patch(message) } : message
    )));
  };

  const updateProcess = (conversationId: string, id: string, updater: (blocks: ProcessBlock[]) => ProcessBlock[]): void => {
    updateMessages(conversationId, (current) => current.map((message) => (
      message.id === id ? { ...message, process: updater(message.process ?? []) } : message
    )));
  };

  const finishProcess = (conversationId: string, id: string): void => {
    updateProcess(conversationId, id, (blocks) => blocks.map((block) => ({ ...block, done: true })));
  };

  const stop = (): void => {
    abortRef.current?.abort();
  };

  const startNewConversation = (): void => {
    if (busy) abortRef.current?.abort();
    const conversation = createConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setInput('');
    setEditing(null);
    setMenuOpen(false);
  };

  const switchConversation = (id: string): void => {
    if (id === activeId) {
      setMenuOpen(false);
      return;
    }
    if (busy) abortRef.current?.abort();
    setActiveId(id);
    setEditing(null);
    setInput('');
    setMenuOpen(false);
  };

  const deleteConversation = (id: string): void => {
    if (id === activeId && busy) abortRef.current?.abort();
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    const next = remaining.length ? remaining : [createConversation()];
    setConversations(next);
    if (id === activeId) {
      setActiveId(next[0].id);
      setEditing(null);
      setInput('');
    }
    setMenuOpen(false);
  };

  const deleteTurn = (message: ChatMessage): void => {
    if (busy || !active) return;
    updateMessages(active.id, (current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return current;
      const end = current[index + 1]?.role === 'assistant' ? index + 2 : index + 1;
      return [...current.slice(0, index), ...current.slice(end)];
    });
  };

  const regenerate = (message: ChatMessage): void => {
    if (busy) return;
    const index = messages.findIndex((item) => item.id === message.id);
    const user = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user');
    if (user) void send(user.text, { editMessageId: user.id });
  };

  const copyMessage = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const send = async (raw?: string, options?: { editMessageId?: string }): Promise<void> => {
    const message = (raw ?? input).trim();
    if (!message || busy || !active) return;
    const conversationId = active.id;
    setInput('');
    setEditing(null);
    const assistantId = uid('a');
    updateMessages(conversationId, (current) => {
      let base = current;
      if (options?.editMessageId) {
        const index = current.findIndex((item) => item.id === options.editMessageId);
        if (index >= 0) base = current.slice(0, index);
      }
      return [
        ...base,
        { id: uid('u'), role: 'user', text: message },
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          streaming: true,
          status: '正在连接 DSH 助手…',
          process: [],
          processOpen: true,
        },
      ];
    });
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
          conversationId,
        },
        {
          onStatus: (data) => {
            patchMessage(conversationId, assistantId, (current) => ({
              status: current.text ? undefined : statusLabel(data.phase),
            }));
          },
          onThinking: (delta, start) => {
            if (!delta) return;
            updateProcess(conversationId, assistantId, (blocks) => {
              const last = blocks[blocks.length - 1];
              if (!start && last?.kind === 'thinking' && !last.done) {
                return [...blocks.slice(0, -1), { ...last, text: last.text + delta }];
              }
              return [...blocks, { id: uid('t'), kind: 'thinking', text: delta, done: false }];
            });
            patchMessage(conversationId, assistantId, () => ({ status: '正在思考…', processOpen: true }));
          },
          onTool: (data) => {
            updateProcess(conversationId, assistantId, (blocks) => {
              const next = blocks.map((block) => (block.kind === 'thinking' ? { ...block, done: true } : block));
              if (data.kind === 'tool_call') {
                const index = data.callId ? next.findIndex((block) => block.kind === 'tool' && block.callId === data.callId) : -1;
                const toolBlock: ToolBlock = {
                  id: data.callId || uid('tool'),
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
                id: data.callId || uid('tool'),
                kind: 'tool',
                callId: data.callId,
                tool: data.tool || 'tool',
                result: data.result,
                status: data.status,
                done: true,
              }];
            });
            patchMessage(conversationId, assistantId, () => ({
              status: data.kind === 'tool_call' ? `正在调用 ${data.tool || '工具'}…` : undefined,
              processOpen: true,
            }));
          },
          onText: (delta) => {
            finishProcess(conversationId, assistantId);
            patchMessage(conversationId, assistantId, (current) => ({
              text: current.text + delta,
              status: undefined,
              processOpen: false,
            }));
          },
          onDone: (result) => {
            finishProcess(conversationId, assistantId);
            patchMessage(conversationId, assistantId, (current) => ({
              text: result.reply || current.text || '已完成。',
              streaming: false,
              status: undefined,
              processOpen: false,
            }));
            window.dispatchEvent(new CustomEvent('aiwo:assistant-refresh'));
            void loadSuggestions(`${message}\n${result.reply}`.slice(-1_800));
            if (result.navigate) navigate(result.navigate);
          },
          onError: (text) => {
            failed = true;
            finishProcess(conversationId, assistantId);
            patchMessage(conversationId, assistantId, () => ({
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
      patchMessage(conversationId, assistantId, () => ({ streaming: false, status: undefined }));
      if (!failed) window.dispatchEvent(new CustomEvent('aiwo:assistant-refresh'));
    } catch (error) {
      if (controller.signal.aborted) {
        finishProcess(conversationId, assistantId);
        patchMessage(conversationId, assistantId, (current) => ({
          text: current.text || '已停止生成。',
          streaming: false,
          status: undefined,
          processOpen: false,
        }));
      } else {
        const text = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '助手请求失败';
        finishProcess(conversationId, assistantId);
        patchMessage(conversationId, assistantId, () => ({
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
    const stopResize = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stopResize);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stopResize);
  };

  const loadSuggestions = async (context?: string): Promise<void> => {
    const seq = ++suggestionSeq.current;
    setSuggestionsLoading(true);
    try {
      const result = await api.assistantSuggestions({
        pathname: fullPath,
        projectId: projectId ? decodeURIComponent(projectId) : undefined,
        taskId,
        context,
      });
      if (seq === suggestionSeq.current) setSuggestions(result.suggestions.slice(0, 3));
    } catch {
      if (seq === suggestionSeq.current) setSuggestions([]);
    } finally {
      if (seq === suggestionSeq.current) setSuggestionsLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadSuggestions();
    // 页面、项目、任务或会话变化时刷新推荐。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fullPath, projectId, taskId, activeId]);

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversations],
  );

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
                  <Badge size="sm" tone="cyan">DSH 服务</Badge>
                </div>
                <div className="cx-assistant-brand__sub">{active?.title && active.title !== '新会话' ? active.title : '人员 @Aiwo · 可直接调用 Aiwo API'}</div>
              </div>
            </div>
            <div className="cx-assistant-head-actions">
              <IconButton icon="plus" label="新会话" size="sm" onClick={startNewConversation} />
              <IconButton icon="list" label="会话历史" size="sm" onClick={() => setMenuOpen((value) => !value)} />
              <IconButton icon="x" label="收起助手" size="sm" onClick={() => setOpen(false)} />
            </div>
          </header>

          {menuOpen ? (
            <>
              <button type="button" className="cx-assistant-menu-scrim" aria-label="关闭会话历史" onClick={() => setMenuOpen(false)} />
              <div className="cx-assistant-conv-menu">
                <div className="cx-assistant-conv-menu__head">
                  <span>最近会话</span>
                  <Button size="sm" variant="ghost" icon="plus" onClick={startNewConversation}>新会话</Button>
                </div>
                <div className="cx-assistant-conv-list">
                  {sortedConversations.map((conversation) => (
                    <div className={`cx-assistant-conv-row${conversation.id === activeId ? ' active' : ''}`} key={conversation.id}>
                      <button type="button" className="cx-assistant-conv-main" onClick={() => switchConversation(conversation.id)}>
                        <span className="cx-assistant-conv-title">{conversation.title}</span>
                        <span className="cx-assistant-conv-meta">{fmtRelative(conversation.updatedAt)} · {conversation.messages.length} 条</span>
                      </button>
                      <IconButton icon="trash" label="删除会话" size="sm" onClick={() => deleteConversation(conversation.id)} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}

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
                      onToggle={() => patchMessage(active.id, message.id, (current) => ({ processOpen: !current.processOpen }))}
                    />
                  ) : null}
                  {editing?.id === message.id ? (
                    <div className="cx-assistant-edit">
                      <Textarea
                        rows={3}
                        value={editing.text}
                        onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            const text = editing.text.trim();
                            if (text) void send(text, { editMessageId: message.id });
                          }
                        }}
                      />
                      <div className="hstack gap-4">
                        <Button
                          size="sm"
                          variant="primary"
                          icon="check"
                          onClick={() => {
                            const text = editing.text.trim();
                            if (text) void send(text, { editMessageId: message.id });
                          }}
                        >
                          保存并重发
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
                      </div>
                    </div>
                  ) : (
                    <div className={`cx-assistant-text${message.tone ? ' cx-assistant-text--error' : ''}`}>
                      {message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}
                    </div>
                  )}
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
                  {message.text && message.role === 'user' && editing?.id !== message.id ? (
                    <div className="cx-assistant-msg-actions">
                      <IconButton
                        icon="pencil"
                        label="编辑并重发"
                        size="sm"
                        disabled={busy}
                        onClick={() => setEditing({ id: message.id, text: message.text })}
                      />
                      <IconButton
                        icon="trash"
                        label="删除这一轮"
                        size="sm"
                        disabled={busy}
                        onClick={() => deleteTurn(message)}
                      />
                    </div>
                  ) : null}
                  {message.text && message.role === 'assistant' && editing?.id !== message.id ? (
                    <div className="cx-assistant-msg-actions">
                      <IconButton icon="copy" label="复制" size="sm" onClick={() => void copyMessage(message.text)} />
                      {messages.slice(0, messages.indexOf(message)).some((item) => item.role === 'user') && !message.streaming ? (
                        <IconButton icon="refresh" label="重新生成" size="sm" disabled={busy} onClick={() => regenerate(message)} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {(suggestionsLoading && suggestions.length === 0) || suggestions.length > 0 ? (
            <div className="cx-assistant-suggestions" aria-label="下一步任务推荐">
              {suggestionsLoading && suggestions.length === 0
                ? [0, 1, 2].map((item) => <span className="cx-assistant-chip-skeleton" key={item} />)
                : suggestions.map((suggestion) => (
                    <button key={suggestion} type="button" className="cx-assistant-chip" disabled={busy} onClick={() => void send(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
            </div>
          ) : null}

          <form
            className="cx-assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Textarea
              rows={2}
              value={input}
              placeholder="描述你想让 Aiwo 做的事，例如：创建任务、查看服务、生成自动化…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="cx-assistant-composer-bar">
              <div className="cx-assistant-composer-meta">
                <span className="cx-assistant-composer-tag">
                  <Icon name="server" size={11} />
                  DSH 服务
                </span>
                <span className="cx-assistant-composer-hint">Enter 发送 · Shift+Enter 换行</span>
              </div>
              {busy ? (
                <button
                  type="button"
                  className="cx-assistant-send is-stop"
                  aria-label="停止生成"
                  title="停止生成"
                  onClick={stop}
                >
                  <Icon name="x" size={15} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="cx-assistant-send"
                  aria-label="发送"
                  title="发送"
                  disabled={!input.trim()}
                >
                  <Icon name="send" size={16} />
                </button>
              )}
            </div>
          </form>
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
