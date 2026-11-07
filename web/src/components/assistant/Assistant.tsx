import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '@lib/api.ts';
import { Badge, Button, Icon, IconButton, Textarea, useToast } from '@ui';
import { Markdown } from '../project/Markdown.tsx';

interface ToolStep {
  id: string;
  tool: string;
  status?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tone?: 'error';
  streaming?: boolean;
  status?: string;
  thinking?: string;
  tools?: ToolStep[];
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

  const send = async (raw?: string): Promise<void> => {
    const message = (raw ?? input).trim();
    if (!message || busy) return;
    setInput('');
    const assistantId = uid();
    setMessages((current) => [
      ...current,
      { id: uid(), role: 'user', text: message },
      { id: assistantId, role: 'assistant', text: '', streaming: true, status: '正在连接 DSH 助手…', tools: [] },
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
          onThinking: (text) => {
            if (text.trim()) patchMessage(assistantId, () => ({ thinking: text }));
          },
          onTool: (data) => {
            patchMessage(assistantId, (current) => {
              const tools = current.tools ?? [];
              const existing = tools.findIndex((item) => item.tool === data.tool);
              const next = existing >= 0
                ? tools.map((item, index) => (index === existing ? { ...item, status: data.status ?? item.status } : item))
                : [...tools, { id: `${Date.now()}_${tools.length}`, tool: data.tool, status: data.status }];
              return { tools: next, status: data.kind === 'tool_call' ? `正在调用 ${data.tool}…` : undefined };
            });
          },
          onText: (delta) => {
            patchMessage(assistantId, (current) => ({
              text: current.text + delta,
              status: undefined,
              thinking: undefined,
            }));
          },
          onDone: (result) => {
            patchMessage(assistantId, (current) => ({
              text: result.reply || current.text || '已完成。',
              streaming: false,
              status: undefined,
              thinking: undefined,
            }));
            window.dispatchEvent(new CustomEvent('aiwo:assistant-refresh'));
            if (result.navigate) navigate(result.navigate);
          },
          onError: (text) => {
            failed = true;
            patchMessage(assistantId, () => ({ text, tone: 'error', streaming: false, status: undefined, thinking: undefined }));
            toast.error(text);
          },
        },
        controller.signal,
      );
      patchMessage(assistantId, (current) => ({ streaming: false, status: undefined }));
      if (!failed) window.dispatchEvent(new CustomEvent('aiwo:assistant-refresh'));
    } catch (error) {
      if (controller.signal.aborted) {
        patchMessage(assistantId, (current) => ({
          text: current.text || '已停止生成。',
          streaming: false,
          status: undefined,
          thinking: undefined,
        }));
      } else {
        const text = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '助手请求失败';
        patchMessage(assistantId, () => ({ text, tone: 'error', streaming: false, status: undefined, thinking: undefined }));
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
                  {message.tools?.length ? (
                    <div className="cx-assistant-tools">
                      {message.tools.map((tool) => (
                        <span key={tool.id} className="cx-assistant-tool">
                          <Icon name="terminal" size={11} />
                          {tool.tool}
                          {tool.status ? <span className="cx-assistant-tool__state">{tool.status}</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className={`cx-assistant-text${message.tone ? ' cx-assistant-text--error' : ''}`}>
                    {message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}
                  </div>
                  {message.streaming && !message.text ? (
                    <div className="cx-assistant-streaming">
                      <span className="cx-assistant-typing"><span /><span /><span /></span>
                      <span className="cx-assistant-stream-status">{message.status ?? '正在思考…'}</span>
                    </div>
                  ) : null}
                  {message.streaming && message.text && message.status ? (
                    <div className="cx-assistant-streaming cx-assistant-streaming--text">
                      <span className="cx-assistant-stream-status">{message.status}</span>
                    </div>
                  ) : null}
                  {message.thinking && message.streaming ? (
                    <div className="cx-assistant-thinking">{message.thinking.slice(0, 180)}</div>
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
