import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, Icon, PageHead, Skeleton } from '@ui';
import { api, type WecomConversation, type WecomConversationDetail } from '../lib/api.ts';
import { useAsync } from '../lib/hooks.ts';
import { fmtRelative } from '../lib/format.ts';
import { Markdown } from '../components/project/Markdown.tsx';

/** 企业微信会话：Ryan 侧查看与企业微信外部聊天的对应关系与消息。 */
export function WecomChatsPage() {
  const conversations = useAsync(() => api.wecomConversations(), []);
  const [activeId, setActiveId] = useState('');
  const [detail, setDetail] = useState<WecomConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const active = (conversations.data ?? []).find((item) => item.id === activeId) ?? conversations.data?.[0];

  useEffect(() => {
    if (!activeId && active) setActiveId(active.id);
  }, [activeId, active]);

  useEffect(() => {
    if (!activeId) { setDetail(null); return; }
    let cancelled = false;
    setLoading(true);
    void api.wecomConversationMessages(activeId)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  return (
    <div className="page">
      <PageHead
        title="企业微信会话"
        desc="Ryan 机器人收到企业微信消息后建立的会话；每个外部单聊/群聊对应一个 Ryan 会话。"
        actions={<Button variant="ghost" icon="refresh" onClick={() => void conversations.refresh()}>刷新</Button>}
      />
      {conversations.loading && !conversations.data ? (
        <div className="vstack gap-8"><Skeleton h={80} /><Skeleton h={80} /></div>
      ) : conversations.error && !conversations.data ? (
        <ErrorState message={conversations.error} onRetry={() => void conversations.refresh()} />
      ) : !conversations.data?.length ? (
        <Card className="card-pad"><EmptyState icon="wechat" title="还没有企业微信会话" description="在企业微信中给项目机器人发消息后，这里会出现对应会话。" /></Card>
      ) : (
        <div className="wecom-conv-layout">
          <aside className="wecom-conv-list">
            {conversations.data.map((item) => (
              <button type="button" key={item.id} className={`wecom-conv-item${item.id === active?.id ? ' active' : ''}`} onClick={() => setActiveId(item.id)}>
                <span className={`wecom-conv-icon ${item.chatType === 'group' ? 'group' : ''}`}><Icon name={item.chatType === 'group' ? 'users' : 'wechat'} size={15} /></span>
                <span className="wecom-conv-info">
                  <strong>{item.title}</strong>
                  <span>{item.projectName} · {item.chatType === 'group' ? '群聊' : '单聊'}</span>
                  <em>{item.lastMessage || '暂无消息'}</em>
                </span>
                <span className="tiny dim">{fmtRelative(item.lastAt)}</span>
              </button>
            ))}
          </aside>
          <section className="wecom-conv-panel">
            {active ? (
              <>
                <header className="wecom-conv-head">
                  <div>
                    <strong>{active.title}</strong>
                    <span className="tiny dim">{active.projectName} · {active.chatType === 'group' ? '群聊' : '单聊'} · {active.chatId}</span>
                  </div>
                  <div className="hstack gap-8">
                    <Badge tone="green" size="sm" dot>企业微信</Badge>
                    <Link className="btn small" to={`/projects/${active.projectId}/wecom-bot`}>打开项目机器人</Link>
                  </div>
                </header>
                <div className="wecom-conv-messages">
                  {loading && !detail ? <Skeleton h={120} /> : null}
                  {detail?.messages.map((message) => (
                    <div className={`wecom-conv-message ${message.role}`} key={message.id}>
                      <span className="wecom-conv-avatar">{message.role === 'assistant' ? 'R' : '客'}</span>
                      <div className="wecom-conv-bubble">
                        <div className="wecom-conv-meta">{message.role === 'assistant' ? 'Ryan' : '企业微信用户'} · {fmtRelative(message.created_at)}</div>
                        {message.role === 'assistant' ? <Markdown text={message.content || '（暂无内容）'} /> : <p>{message.content}</p>}
                      </div>
                    </div>
                  ))}
                  {!loading && detail && !detail.messages.length ? <EmptyState title="暂无消息" description="这条企业微信会话还没有消息。" /> : null}
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
