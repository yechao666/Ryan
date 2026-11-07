import { useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeEvent } from '@shared';
import { Avatar, Dot, Icon } from '@ui';
import { fmtDateTime } from '@lib/format.ts';
import { Markdown } from './Markdown.tsx';

type ToolItem = {
  kind: 'tool';
  id: string;
  callId: string;
  tool: string;
  input: unknown;
  status: 'running' | 'completed' | 'error';
  result?: string;
  at: string;
};

type TextItem = { kind: 'text'; id: string; text: string; at: string };
type ErrorItem = { kind: 'error'; id: string; message: string; at: string };
type ThinkingItem = { kind: 'thinking'; id: string; text: string; at: string };
type TurnItem = TextItem | ToolItem | ErrorItem | ThinkingItem;

type Block = { kind: 'agent'; id: string; at: string; items: TurnItem[] };

function toolCommand(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.command === 'string') return record.command;
    if (typeof record.path === 'string') return record.path;
    return JSON.stringify(record).slice(0, 120);
  }
  return typeof input === 'string' ? input : '';
}

/** 运行时事件 → 文本/工具/错误；状态只用于顶部一行状态。 */
function buildRuntimeItems(events: RuntimeEvent[]): {
  items: TurnItem[];
  thinkingCount: number;
  lastPhase: string;
  lastTool: ToolItem | null;
} {
  const items: TurnItem[] = [];
  const toolIndex = new Map<string, number>();
  let thinkingCount = 0;
  let lastPhase = '';
  let lastTool: ToolItem | null = null;
  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case 'text': {
        const text = typeof p.text === 'string' ? p.text : '';
        if (text.trim()) items.push({ kind: 'text', id: event.id, text, at: event.createdAt });
        break;
      }
      case 'tool_call': {
        const callId = String(p.callId ?? event.id);
        const item: ToolItem = {
          kind: 'tool',
          id: event.id,
          callId,
          tool: String(p.tool ?? 'tool'),
          input: p.input,
          status: 'running',
          at: event.createdAt,
        };
        toolIndex.set(callId, items.length);
        items.push(item);
        lastTool = item;
        break;
      }
      case 'tool_result': {
        const callId = String(p.callId ?? '');
        const index = toolIndex.get(callId);
        if (index !== undefined) {
          const tool = items[index] as ToolItem;
          items[index] = {
            ...tool,
            status: p.status === 'error' ? 'error' : 'completed',
            result: typeof p.result === 'string' ? p.result : '',
          };
          lastTool = items[index] as ToolItem;
        }
        break;
      }
      case 'error':
        items.push({ kind: 'error', id: event.id, message: String(p.message ?? '运行错误'), at: event.createdAt });
        break;
      case 'status':
        if (typeof p.phase === 'string') lastPhase = p.phase;
        break;
      case 'thinking': {
        const text = typeof p.text === 'string' ? p.text : '';
        if (!text.trim()) break;
        items.push({ kind: 'thinking', id: event.id, text, at: event.createdAt });
        thinkingCount += 1;
        break;
      }
      default:
        break;
    }
  }
  return { items, thinkingCount, lastPhase, lastTool };
}

/** 任务只展示执行过程，不包含人员对话。 */
function buildBlocks(events: RuntimeEvent[]): Block[] {
  const { items } = buildRuntimeItems(events);
  if (items.length === 0) return [];
  return [{ kind: 'agent', id: 'execution', at: items[0]!.at, items }];
}

function AnimatedText({ text, animate }: { text: string; animate: boolean }) {
  const [visible, setVisible] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) {
      setVisible(text.length);
      return;
    }
    setVisible(0);
    const step = Math.max(6, Math.ceil(text.length / 90));
    const timer = setInterval(() => {
      setVisible((value) => {
        const next = Math.min(text.length, value + step);
        if (next >= text.length) clearInterval(timer);
        return next;
      });
    }, 16);
    return () => clearInterval(timer);
  }, [text, animate]);
  return (
    <>
      {text.slice(0, visible)}
      {visible < text.length ? <span className="ws-rt-cursor" /> : null}
    </>
  );
}

function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  // 只取一行摘要：放在字数右边，使用次要字体；点击展开该片全文。
  const summary = text.replace(/\s+/g, ' ').trim();
  return (
    <div className="ws-thinking">
      <button type="button" className="ws-thinking-head" onClick={() => setOpen((value) => !value)}>
        <span className="ws-thinking-icon"><Icon name="brain" size={13} /></span>
        <span>{live ? '思考中' : '思考过程'}</span>
        <span className="ws-thinking-count">{text.length} 字</span>
        <span className="ws-thinking-snippet">{summary}</span>
        <span className="ws-thinking-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open ? <div className="ws-thinking-body"><Markdown text={text} /></div> : null}
    </div>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const command = toolCommand(item.input);
  return (
    <details className={`ws-rt-tool status-${item.status}`}>
      <summary>
        <span className="ws-rt-tool-icon"><Icon name="terminal" size={13} /></span>
        <span className="ws-rt-tool-name">{item.tool}</span>
        <span className="ws-rt-tool-cmd">{command || '执行中…'}</span>
        <span className="tiny dim">{item.status === 'completed' ? '完成' : item.status === 'error' ? '失败' : '执行中'}</span>
      </summary>
      {command ? <pre className="ws-rt-tool-input">{command}</pre> : null}
      {item.result ? <pre className="ws-rt-tool-result">{item.result.slice(0, 6000)}</pre> : null}
    </details>
  );
}

export function TaskConversation({
  events,
  running,
  executorLabel,
}: {
  events: RuntimeEvent[];
  running: boolean;
  executorLabel: string;
}) {
  const { items, thinkingCount, lastPhase, lastTool } = useMemo(() => buildRuntimeItems(events), [events]);
  const blocks = useMemo(() => buildBlocks(events), [events]);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);

  const drawerBody = () => (flowRef.current?.closest('.drawer-body') as HTMLElement | null);
  useEffect(() => {
    const el = drawerBody();
    if (!el) return;
    const onScroll = () => setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!running || !follow) return;
    const el = drawerBody();
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [blocks.length, running, follow]);

  const lastAgent = [...blocks].reverse().find((block): block is Block & { kind: 'agent' } => block.kind === 'agent');
  const lastText = lastAgent ? [...lastAgent.items].reverse().find((item): item is TextItem => item.kind === 'text') : null;
  const animate = Boolean(running && lastAgent && lastText && lastAgent.items[lastAgent.items.length - 1] === lastText);

  const status = !running
    ? null
    : lastTool?.status === 'running'
      ? `正在调用 ${lastTool.tool}…`
      : lastTool?.status === 'error'
        ? '工具执行出错'
        : lastPhase === 'turn_start' || lastPhase === 'step_start'
          ? '正在思考…'
          : items.some((item) => item.kind === 'text')
            ? '正在输出…'
            : '正在启动 DSH…';

  if (blocks.length === 0) {
    return (
      <div className="ws-chat-empty">
        <span className="ws-rt-typing"><i /><i /><i /></span>
        任务开始后，Aiwo 的输出、思考与工具调用会按时间顺序出现在这里。
      </div>
    );
  }

  return (
    <div className="ws-chat">
      {status ? (
        <div className="ws-chat-status">
          <span className="ws-rt-status-left">
            {running ? <Dot tone={lastTool?.status === 'error' ? 'red' : 'green'} pulse /> : <Dot tone="slate" />}
            <span className={running ? 'ws-rt-status-live' : 'ws-rt-status-idle'}>{status}</span>
            {running && thinkingCount > 0 ? <span className="ws-rt-thinking">思考 {thinkingCount} 次</span> : null}
          </span>
          {running ? <span className="ws-rt-count">{blocks.length} 轮</span> : null}
        </div>
      ) : null}

      <div className="ws-chat-flow" ref={flowRef}>
        {blocks.map((block) => {
          return (
            <article className="ws-turn" key={block.id}>
              <Avatar name="Aiwo" tone="violet" size="sm" />
              <div className="ws-turn-body">
                <div className="ws-chat-head">
                  <span className="strong small">{executorLabel || 'Aiwo'}</span>
                  <span className="tiny dim">{fmtDateTime(block.at)}</span>
                  {block.items.filter((item) => item.kind === 'tool').length > 0 ? (
                    <span className="tiny dim">· {block.items.filter((item) => item.kind === 'tool').length} 个工具</span>
                  ) : null}
                </div>
                <div className="ws-turn-content">
                  {block.items.map((item) => {
                      if (item.kind === 'thinking') {
                        return (
                          <ThinkingBlock
                            key={item.id}
                            text={item.text}
                            live={running && block === lastAgent && item === block.items[block.items.length - 1]}
                          />
                        );
                      }
                      if (item.kind === 'text') {
                        const animated = animate && lastAgent === block && lastText === item;
                        return (
                          <div className="ws-turn-text" key={item.id}>
                            {animated ? <AnimatedText text={item.text} animate /> : <Markdown text={item.text} />}
                          </div>
                        );
                      }
                      if (item.kind === 'tool') return <ToolRow key={item.id} item={item} />;
                      return (
                        <div className="ws-rt-error" key={item.id}>
                          <Icon name="alert" size={14} />
                          {item.message}
                        </div>
                      );
                    })}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
