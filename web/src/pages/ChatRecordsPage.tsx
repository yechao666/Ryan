import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHead,
  Pagination,
  SearchInput,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api, type AssistantConversationDetail, type AssistantConversationSummary, type AssistantProcessBlock } from '../lib/api.ts';
import { fmtDateTime, fmtRelative } from '../lib/format.ts';
import { useAsync } from '../lib/hooks.ts';
import { Markdown } from '../components/project/Markdown.tsx';

const ACTIVE_KEY = 'aiwo.assistant.activeConversation.v1';

function toolInput(input: unknown): string {
  if (input == null) return '';
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

function ProcessList({ blocks }: { blocks: AssistantProcessBlock[] }) {
  if (!blocks.length) return null;
  const tools = blocks.filter((block) => block.kind === 'tool').length;
  return (
    <details className="chat-process" open>
      <summary>
        <span className="hstack gap-4"><Icon name="terminal" size={12} />过程</span>
        <span className="tiny dim">{blocks.length} 步{tools ? ` · ${tools} 次工具调用` : ''}</span>
      </summary>
      <div className="chat-process__body">
        {blocks.map((block) => (
          <div className="chat-process__step" key={block.id}>
            <div className="chat-process__head">
              <span className={`chat-process__kind ${block.kind}`}>{block.kind === 'thinking' ? '思考' : '工具'}</span>
              {block.kind === 'tool' ? <span className="mono tiny">{block.tool || 'tool'}</span> : null}
              {block.status ? <span className="tiny dim">{block.status}</span> : null}
            </div>
            {block.text ? <div className="chat-process__text"><Markdown text={block.text} /></div> : null}
            {block.kind === 'tool' && block.input != null ? <pre className="chat-process__code">{toolInput(block.input)}</pre> : null}
            {block.result ? <pre className="chat-process__result">{block.result.slice(0, 4_000)}</pre> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

export function ChatRecordsPage() {
  const toast = useToast();
  const conversations = useAsync(() => api.assistantConversations(), []);
  const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_KEY) || '');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<AssistantConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssistantConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AssistantConversationSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onActive = (event: Event) => {
      const id = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (id) setActiveId(id);
    };
    window.addEventListener('aiwo:assistant-active', onActive);
    return () => window.removeEventListener('aiwo:assistant-active', onActive);
  }, []);

  useEffect(() => { setPage(1); }, [search, pageSize]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (conversations.data?.conversations ?? []).filter((item) => {
      if (!needle) return true;
      return `${item.title} ${item.preview}`.toLowerCase().includes(needle);
    });
  }, [conversations.data, search]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const activate = (id: string) => {
    localStorage.setItem(ACTIVE_KEY, id);
    setActiveId(id);
    window.dispatchEvent(new CustomEvent('aiwo:assistant-activate', { detail: { conversationId: id } }));
    toast.success('已设为活动会话，右侧助手已切换');
  };

  const create = async () => {
    setCreating(true);
    try {
      const result = await api.createAssistantConversation({ pathname: window.location.pathname });
      await conversations.refresh();
      activate(result.conversation.id);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '新建会话失败');
    } finally { setCreating(false); }
  };

  const openDetail = async (item: AssistantConversationSummary) => {
    setDetailLoading(true);
    try {
      setDetail(await api.assistantConversation(item.id));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '加载会话失败');
    } finally { setDetailLoading(false); }
  };

  const saveRename = async () => {
    if (!renameTarget) return;
    if (!renameTitle.trim()) { toast.error('会话标题不能为空'); return; }
    setRenaming(true);
    try {
      await api.renameAssistantConversation(renameTarget.id, renameTitle.trim());
      window.dispatchEvent(new CustomEvent('aiwo:assistant-conversation-renamed', {
        detail: { conversationId: renameTarget.id, title: renameTitle.trim() },
      }));
      setRenameTarget(null);
      await conversations.refresh();
      toast.success('会话标题已更新');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '重命名失败');
    } finally { setRenaming(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteAssistantConversation(deleteTarget.id);
      window.dispatchEvent(new CustomEvent('aiwo:assistant-conversation-deleted', {
        detail: { conversationId: deleteTarget.id },
      }));
      toast.success('会话已删除');
      setDeleteTarget(null);
      if (detail?.conversation.id === deleteTarget.id) setDetail(null);
      await conversations.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除会话失败');
    } finally { setDeleting(false); }
  };

  const columns: Column<AssistantConversationSummary>[] = [
    {
      key: 'title',
      header: '会话',
      render: (item) => (
        <div className="hstack gap-8">
          <span className="cx-metric-icon tone-cyan"><Icon name="terminal" size={14} /></span>
          <div className="vstack gap-2" style={{ minWidth: 0 }}>
            <span className="hstack gap-6">
              <span className="strong truncate">{item.title || '未命名会话'}</span>
              {item.id === activeId ? <Badge size="sm" tone="green" dot>活动</Badge> : null}
            </span>
            <span className="tiny dim truncate">{item.preview || '暂无内容'}</span>
          </div>
        </div>
      ),
    },
    { key: 'pathname', header: '关联页面', width: 160, render: (item) => <span className="tiny mono truncate" title={item.pathname}>{item.pathname || '/'}</span> },
    { key: 'messageCount', header: '消息', width: 70, render: (item) => <span className="tiny dim">{item.messageCount}</span>, sortValue: (item) => item.messageCount },
    {
      key: 'updatedAt',
      header: '最近更新',
      width: 130,
      render: (item) => <span className="tiny dim" title={fmtDateTime(item.updatedAt)}>{fmtRelative(item.updatedAt)}</span>,
      sortValue: (item) => Date.parse(item.updatedAt) || 0,
    },
    {
      key: 'actions',
      header: '操作',
      width: 190,
      align: 'right',
      render: (item) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }} onClick={(event) => event.stopPropagation()}>
          <IconButton
            icon={item.id === activeId ? 'check' : 'play'}
            label={item.id === activeId ? '当前活动会话' : '设为活动会话'}
            size="sm"
            disabled={item.id === activeId}
            onClick={() => activate(item.id)}
          />
          <IconButton icon="eye" label="查看会话" size="sm" onClick={() => void openDetail(item)} />
          <IconButton
            icon="pencil"
            label="重命名会话"
            size="sm"
            onClick={() => { setRenameTarget(item); setRenameTitle(item.title); }}
          />
          <IconButton icon="trash" label="删除会话" size="sm" onClick={() => setDeleteTarget(item)} />
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        title="聊天记录"
        desc="当前账号的助手会话；新建、重命名、删除，或设为活动会话让右侧助手直接打开。"
        actions={
          <>
            <IconButton icon="refresh" label="刷新聊天记录" onClick={() => void conversations.refresh()} />
            <Button variant="primary" icon="plus" loading={creating} onClick={() => void create()}>新建会话</Button>
          </>
        }
      />
      <div className="toolbar">
        <div className="toolbar-left">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索标题 / 内容" className="ws-search" />
          <span className="tiny dim">共 {filtered.length} 个会话</span>
        </div>
        {search ? <Button size="sm" variant="ghost" onClick={() => setSearch('')}>清除筛选</Button> : null}
      </div>

      {conversations.error && !conversations.data ? (
        <Card><div style={{ padding: 18 }}><ErrorState message={conversations.error} onRetry={() => void conversations.refresh()} /></div></Card>
      ) : (
        <Card>
          <Table
            columns={columns}
            rows={paged}
            rowKey={(item) => item.id}
            sortable
            resizable
            loading={conversations.loading && !conversations.data}
            onRowClick={(item) => void openDetail(item)}
            empty={<EmptyState icon="terminal" title="还没有聊天记录" description="新建一个会话，或在右侧助手开始对话。" action={<Button size="sm" variant="primary" icon="plus" onClick={() => void create()}>新建会话</Button>} compact />}
          />
          {!conversations.loading && filtered.length > 0 ? (
            <div className="ws-table-foot">
              <Pagination
                page={currentPage}
                totalPages={totalPages}
                total={filtered.length}
                pageSize={pageSize}
                pageSizeOptions={[
                  { value: '10', label: '每页 10 行' },
                  { value: '20', label: '每页 20 行' },
                  { value: '50', label: '每页 50 行' },
                ]}
                onPageSizeChange={setPageSize}
                onChange={setPage}
              />
            </div>
          ) : null}
        </Card>
      )}

      <Modal
        open={Boolean(detail) || detailLoading}
        onClose={() => { setDetail(null); setDetailLoading(false); }}
        title={detail?.conversation.title || '会话详情'}
        description={detail ? `${detail.conversation.pathname} · ${fmtDateTime(detail.conversation.updatedAt)}` : '正在加载…'}
        size="lg"
        footer={<Button variant="ghost" onClick={() => setDetail(null)}>关闭</Button>}
      >
        {detailLoading && !detail ? <div className="tiny dim">正在加载会话…</div> : detail ? (
          <div className="chat-transcript">
            {detail.messages.length === 0 ? <EmptyState icon="terminal" title="空会话" compact /> : detail.messages.map((message) => (
              <div className={`chat-msg chat-msg--${message.role}`} key={message.id}>
                <div className="chat-msg__head">
                  <span className="chat-msg__author">{message.role === 'user' ? '你' : 'Ryan 助手'}</span>
                  <span className="tiny dim">{fmtRelative(message.createdAt)}</span>
                </div>
                {message.role === 'assistant' ? <ProcessList blocks={message.process} /> : null}
                <div className="chat-msg__body">
                  {message.content ? <Markdown text={message.content} /> : <span className="tiny dim">（无正文）</span>}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title="重命名会话"
        description="只修改标题，不影响消息与过程记录。"
        footer={<><Button variant="ghost" onClick={() => setRenameTarget(null)}>取消</Button><Button variant="primary" icon="check" loading={renaming} onClick={() => void saveRename()}>保存</Button></>}
      >
        <Field label="会话标题"><Input value={renameTitle} autoFocus onChange={(event) => setRenameTitle(event.target.value)} /></Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title="删除聊天记录"
        description={deleteTarget ? `确认删除「${deleteTarget.title}」？消息与过程记录会一并删除。` : undefined}
        confirmLabel="删除会话"
        loading={deleting}
      />
    </div>
  );
}
