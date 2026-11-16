import { useState, type FormEvent } from 'react';
import type { TaskMessage } from '@shared';
import { Avatar, Button, Icon } from '@ui';
import { fmtDateTime } from '@lib/format.ts';
import { Markdown } from './Markdown.tsx';

export function TaskMessages({
  messages,
  disabled,
  sending,
  onSend,
}: {
  messages: TaskMessage[];
  disabled?: boolean;
  sending?: boolean;
  onSend: (content: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || disabled || sending) return;
    await onSend(content);
    setDraft('');
  };

  return (
    <div className="ws-task-dialog">
      <div className="ws-chat-flow">
        {messages.length === 0 ? (
          <div className="ws-chat-empty">这是任务的对话记录。发送消息即可继续这个任务。</div>
        ) : (
          messages.map((message) => {
            const person = message.role === 'user';
            return (
              <div className={`ws-chat-row${person ? ' is-person' : ''}`} key={message.id}>
                {!person ? <Avatar name="Ryan" tone="violet" size="sm" /> : null}
                <div className="ws-chat-body">
                  <div className="ws-chat-head">
                    <span className="strong small">{message.authorName || (person ? '人员' : 'Ryan')}</span>
                    <span className="tiny dim">{fmtDateTime(message.createdAt)}</span>
                    {message.source ? <span className="tiny dim">· {message.source === 'wecom' ? '企业微信' : message.source === 'agent' ? '子 Agent' : '本系统'}</span> : null}
                  </div>
                  <div className={`ws-chat-bubble ${person ? 'is-person' : 'is-agent'}`}>
                    <Markdown text={message.content.replace(/^\/goal\s*/i, '')} />
                  </div>
                </div>
                {person ? <Avatar name={message.authorName || '人员'} tone="blue" size="sm" /> : null}
              </div>
            );
          })
        )}
      </div>
      <form className="ws-task-composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={disabled ? '任务正在执行，结束后可继续对话…' : '继续这个任务：补充要求、指出问题，或要求继续修改…'}
          rows={2}
          disabled={disabled || sending}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="ws-task-composer__foot">
          <span className="tiny dim"><Icon name="activity" size={11} /> 任务即对话 · Enter 发送，Shift+Enter 换行</span>
          <Button type="submit" size="sm" variant="primary" icon="send" disabled={disabled || sending || !draft.trim()}>
            {sending ? '发送中…' : '发送'}
          </Button>
        </div>
      </form>
    </div>
  );
}
