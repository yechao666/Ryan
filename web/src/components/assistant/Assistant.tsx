import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '@lib/api.ts';
import { Badge, Button, Icon, IconButton, Textarea, useToast } from '@ui';
import { Markdown } from '../project/Markdown.tsx';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tone?: 'error';
}

const WELCOME =
  '我是 Aiwo 系统助手，运行在 DSH 实例中。可以读取项目、任务、实例与提示词卡片，并通过 Aiwo API 直接创建任务、配置实例或查询状态。';

function uid(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

  const send = async (raw?: string): Promise<void> => {
    const message = (raw ?? input).trim();
    if (!message || busy) return;
    setInput('');
    setMessages((current) => [...current, { id: uid(), role: 'user', text: message }]);
    setBusy(true);
    try {
      const result = await api.assistantChat({
        message,
        pathname: fullPath,
        projectId: projectId ? decodeURIComponent(projectId) : undefined,
        taskId,
      });
      setMessages((current) => [
        ...current,
        { id: uid(), role: 'assistant', text: result.reply || '已完成。' },
      ]);
      window.dispatchEvent(new CustomEvent('aiwo:assistant-refresh'));
      if (result.navigate) navigate(result.navigate);
    } catch (error) {
      const text = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '助手请求失败';
      setMessages((current) => [...current, { id: uid(), role: 'assistant', text, tone: 'error' }]);
      toast.error(text);
    } finally {
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
                  <div className={`cx-assistant-text${message.tone ? ' cx-assistant-text--error' : ''}`}>
                    {message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}
                  </div>
                </div>
              </div>
            ))}
            {busy ? (
              <div className="cx-assistant-msg cx-assistant-msg--assistant">
                <span className="cx-assistant-avatar">A</span>
                <div className="cx-assistant-bubble">
                  <span className="cx-assistant-typing"><span /><span /><span /></span>
                </div>
              </div>
            ) : null}
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
