import { useEffect, useMemo, useState } from 'react';
import type { Person } from '@shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Modal,
  PageHead,
  Pagination,
  SearchInput,
  Select,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api, type AssistantConversationDetail, type AssistantConversationSummary, type AssistantProcessBlock } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime, fmtRelative } from '../lib/format.ts';
import { useAsync } from '../lib/hooks.ts';
import { Markdown } from '../components/project/Markdown.tsx';

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
  const { person } = useAuth();
  const toast = useToast();
  const isAdmin = Boolean(person?.isAdmin);
  const conversations = useAsync(() => api.assistantConversations(), []);
  const persons = useAsync(() => api.persons(), [], isAdmin);
  const [search, setSearch] = useState('');
  const [personId, setPersonId] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<AssistantConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssistantConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (conversations.data?.conversations ?? []).filter((item) => {
      if (personId !== 'all' && item.personId !== personId) return false;
      if (!needle) return true;
      return `${item.title} ${item.personName} ${item.preview}`.toLowerCase().includes(needle);
    });
  }, [conversations.data, search, personId]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => { setPage(1); }, [search, personId, pageSize]);

  const openDetail = async (item: AssistantConversationSummary) => {
    setDetailLoading(true);
    try {
      setDetail(await api.assistantConversation(item.id));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '加载会话失败');
    } finally { setDetailLoading(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteAssistantConversation(deleteTarget.id);
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
            <span className="strong truncate">{item.title || '未命名会话'}</span>
            <span className="tiny dim truncate">{item.preview || '暂无内容'}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'person',
      header: '发起人',
      width: 170,
      render: (item) => (
        <div className="hstack gap-6">
          <Avatar name={item.personName || '—'} size="sm" tone="violet" />
          <span className="small truncate">{item.personName || '—'}</span>
        </div>
      ),
    },
    { key: 'pathname', header: '关联页面', width: 150, render: (item) => <span className="tiny mono truncate" title={item.pathname}>{item.pathname || '/'}</span> },
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
      width: 120,
      align: 'right',
      render: (item) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }} onClick={(event) => event.stopPropagation()}>
          <IconButton icon="eye" label="查看会话" size="sm" onClick={() => void openDetail(item)} />
          <IconButton icon="trash" label="删除会话" size="sm" onClick={() => setDeleteTarget(item)} />
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        title="聊天记录"
        desc={isAdmin ? '查看全平台助手会话与完整执行过程；可按发起人筛选。' : '查看自己的助手会话与完整执行过程。'}
        actions={<IconButton icon="refresh" label="刷新聊天记录" onClick={() => { void conversations.refresh(); }} />}
      />
      <div className="toolbar">
        <div className="toolbar-left">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索标题 / 发起人 / 内容" className="ws-search" />
          {isAdmin ? (
            <Select
              className="ws-filter-select"
              value={personId}
              options={[{ value: 'all', label: '全部发起人' }, ...(persons.data ?? []).map((item: Person) => ({ value: item.id, label: item.name }))]}
              onChange={(event) => setPersonId(event.target.value)}
            />
          ) : null}
          <span className="tiny dim">共 {filtered.length} 个会话</span>
        </div>
        {(search || personId !== 'all') ? (
          <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setPersonId('all'); }}>清除筛选</Button>
        ) : null}
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
            empty={<EmptyState icon="terminal" title="还没有聊天记录" description="在右侧助手发起一次会话后，这里会保存完整消息与执行过程。" compact />}
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
        description={detail ? `${detail.conversation.personName} · ${detail.conversation.pathname} · ${fmtDateTime(detail.conversation.updatedAt)}` : '正在加载…'}
        size="lg"
        footer={<Button variant="ghost" onClick={() => setDetail(null)}>关闭</Button>}
      >
        {detailLoading && !detail ? <div className="tiny dim">正在加载会话…</div> : detail ? (
          <div className="chat-transcript">
            {detail.messages.length === 0 ? <EmptyState icon="terminal" title="空会话" compact /> : detail.messages.map((message) => (
              <div className={`chat-msg chat-msg--${message.role}`} key={message.id}>
                <div className="chat-msg__head">
                  <span className="chat-msg__author">{message.role === 'user' ? detail.conversation.personName : 'Ryan 助手'}</span>
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
