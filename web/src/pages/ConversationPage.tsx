import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Icon, useToast } from '@ui';
import { api, type AssistantConversationDetail, type AssistantConversationSummary } from '../lib/api.ts';
import { useAsync } from '../lib/hooks.ts';
import { Markdown } from '../components/project/Markdown.tsx';
import { fmtRelative } from '../lib/format.ts';

/**
 * 全局 Ryan 对话页。
 * 对话独立于项目；选择项目后 Ryan 显示为 Ryan@项目，方便助手围绕项目操作。
 */
export function ConversationPage() {
  const { conversationId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const projects = useAsync(() => api.projects(), []);
  const [conversations, setConversations] = useState<AssistantConversationSummary[]>([]);
  const [detail, setDetail] = useState<AssistantConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const projectId = searchParams.get('projectId') || '';
  const project = (projects.data ?? []).find((item) => item.id === projectId);
  const persona = project ? `Ryan@${project.name}` : 'Ryan';
  const active = conversationId || conversations[0]?.id;

  const loadConversations = async (): Promise<void> => {
    try { setConversations((await api.assistantConversations()).conversations); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载对话失败'); }
  };
  const loadDetail = async (id: string): Promise<void> => {
    setLoading(true);
    try { setDetail(await api.assistantConversation(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载对话失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadConversations(); }, []);
  useEffect(() => {
    if (active) void loadDetail(active);
    else setDetail(null);
  }, [active]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.messages.length, sending]);

  const createConversation = async (): Promise<void> => {
    try {
      const created = await api.createAssistantConversation({ pathname: '/conversation' });
      await loadConversations();
      navigate(`/conversation/${created.conversation.id}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '新建对话失败'); }
  };

  const send = async (): Promise<void> => {
    const message = input.trim();
    if (!message || sending) return;
    let target = active;
    if (!target) {
      const created = await api.createAssistantConversation({ pathname: '/conversation' });
      target = created.conversation.id;
      await loadConversations();
      navigate(`/conversation/${target}`);
    }
    setInput('');
    setSending(true);
    setError(null);
    setDetail((current) => current ? { ...current, messages: [...current.messages, { id: `local_${Date.now()}`, role: 'user', content: message, process: [], createdAt: new Date().toISOString() }] } : current);
    try {
      await api.assistantChat({ message, pathname: '/conversation', projectId: projectId || undefined, conversationId: target });
      await loadDetail(target);
      await loadConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发送失败');
    } finally { setSending(false); }
  };

  const selectProject = (value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('projectId', value); else next.delete('projectId');
    setSearchParams(next);
  };

  const messages = detail?.messages ?? [];
  const title = useMemo(() => conversations.find((item) => item.id === active)?.title || '和 Ryan 聊聊', [conversations, active]);

  return (
    <div className="conversation-page">
      <aside className="conversation-side">
        <div className="conversation-side__head">
          <div>

            <div className="conversation-side__title">我的对话</div>
            <div className="tiny dim">和 Ryan 沟通</div>
          </div>
          <button type="button" className="icon-btn" title="新建对话" onClick={() => void createConversation()}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="conversation-side__list">
          {conversations.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`conversation-item${item.id === active ? ' active' : ''}`}
              onClick={() => navigate(`/conversation/${item.id}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)}
            >
              <span className="conversation-item__avatar">R</span>
              <span className="conversation-item__body">
                <strong>{item.title || '新对话'}</strong>
                <span>{persona} · {item.preview || '暂无内容'}</span>
                <em>{fmtRelative(item.updatedAt)}</em>
              </span>
            </button>
          ))}
          {!conversations.length ? <div className="conversation-empty">还没有对话。</div> : null}
        </div>
        <div className="conversation-side__foot">
          <Button variant="outline" size="sm" block icon="plus" onClick={() => void createConversation()}>新对话</Button>
        </div>
      </aside>

      <section className="conversation-main">
        <header className="conversation-head">
          <div>
            <div className="conversation-head__title">{title}</div>
            <div className="tiny dim">{persona === 'Ryan' ? 'Ryan 平台助手 · 未关联项目' : `Ryan 项目分身 · ${project?.name}`}</div>
          </div>
          <div className="conversation-head__actions">
            <select className="select" value={projectId} onChange={(event) => selectProject(event.target.value)} aria-label="选择项目">
              <option value="">平台助手 Ryan</option>
              {(projects.data ?? []).map((item) => <option value={item.id} key={item.id}>Ryan@{item.name}</option>)}
            </select>
          </div>
        </header>
        <div className="conversation-messages" ref={scrollRef}>
          {loading ? <div className="conversation-loading">正在加载对话…</div> : null}
          {!loading && !messages.length ? (
            <div className="conversation-welcome">
              <span className="conversation-welcome__mark">R</span>
              <h2>我是 Ryan，平台的数字员工。</h2>
              <p>{project ? `当前是 Ryan@${project.name}，可以围绕这个项目协调人员、智员和任务。` : '你可以在对话里打开一个项目，我会成为 Ryan@项目，帮你协调人员、智员和任务。'}</p>
            </div>
          ) : null}
          {messages.map((message) => (
            <article className={`conversation-message ${message.role}`} key={message.id}>
              <span className="conversation-message__avatar">{message.role === 'user' ? '我' : 'R'}</span>
              <div className="conversation-message__body">
                <div className="conversation-message__meta">{message.role === 'user' ? '我' : persona} · {fmtRelative(message.createdAt)}</div>
                {message.role === 'assistant'
                  ? <Markdown text={message.content || '（无回复）'} />
                  : <p>{message.content}</p>}
              </div>
            </article>
          ))}
          {sending ? <div className="conversation-typing"><span /><span /><span /></div> : null}
          {error ? <div className="conversation-error">{error}</div> : null}
        </div>
        <div className="conversation-composer">
          <textarea
            value={input}
            rows={2}
            placeholder={`和 ${persona} 对话…`}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
          />
          <div className="conversation-composer__foot">
            <span className="tiny dim">{project ? `Ryan@${project.name}` : 'Ryan 平台助手'}</span>
            <Button variant="primary" size="sm" loading={sending} onClick={() => void send()}>发送</Button>
          </div>
        </div>
      </section>

      <aside className="conversation-context">
        <div className="conversation-context__title">{persona}</div>
        <p className="tiny dim">{project ? '项目分身负责协调该项目的智员和任务。' : '平台助手负责 Ryan 的全局协调。'}</p>
        {project ? (
          <div className="conversation-context__card">
            <strong>{project.name}</strong>
            <p>{project.description || '暂无项目说明'}</p>
            <Button variant="ghost" size="sm" icon="arrowRight" onClick={() => navigate(`/projects/${project.id}`)}>打开项目</Button>
          </div>
        ) : (
          <div className="conversation-context__card">
            <strong>选择一个项目</strong>
            <p>选择项目后，对话会切换为 Ryan@项目，方便助手围绕该项目的任务和资源操作。</p>
          </div>
        )}
      </aside>
    </div>
  );
}
