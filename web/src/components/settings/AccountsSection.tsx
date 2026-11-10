import { useEffect, useMemo, useState } from 'react';
import type { Person } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtDateTime, fmtRelative } from '@lib/format.ts';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  Pagination,
  SearchInput,
  SectionHead,
  Select,
  Switch,
  Table,
  useToast,
  type Column,
} from '@ui';
import { toneFor } from '../projects/helpers.tsx';

type AccountRow = Person & { identityCount: number; wecomUserId?: string; wecomBoundAt?: string };

const PAGE_SIZE_OPTIONS = [
  { value: '10', label: '每页 10 行' },
  { value: '20', label: '每页 20 行' },
  { value: '50', label: '每页 50 行' },
];

const ROLE_OPTIONS = [
  { value: 'all', label: '全部角色' },
  { value: 'admin', label: '管理员' },
  { value: 'member', label: '成员' },
];

const PASSWORD_OPTIONS = [
  { value: 'all', label: '全部登录方式' },
  { value: 'set', label: '有本地密码' },
  { value: 'unset', label: '仅统一认证' },
];

const WECOM_OPTIONS = [
  { value: 'all', label: '全部企业微信状态' },
  { value: 'bound', label: '已绑定企业微信' },
  { value: 'unbound', label: '未绑定企业微信' },
];

const SSO_OPTIONS = [
  { value: 'all', label: '全部绑定状态' },
  { value: 'bound', label: '已绑定统一认证' },
  { value: 'unbound', label: '未绑定统一认证' },
];

export function AccountsSection() {
  const toast = useToast();
  const { person } = useAuth();
  const accounts = useAsync(() => api.adminAccounts(), []);
  const [keyword, setKeyword] = useState('');
  const [role, setRole] = useState('all');
  const [password, setPassword] = useState('all');
  const [sso, setSso] = useState('all');
  const [wecom, setWecom] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', title: '', password: '', isAdmin: false });
  const [saving, setSaving] = useState(false);
  const [reset, setReset] = useState<AccountRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [edit, setEdit] = useState<AccountRow | null>(null);
  const [editForm, setEditForm] = useState({ name: '', title: '' });
  const [updating, setUpdating] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AccountRow | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => { setPage(1); }, [keyword, role, password, sso, wecom, pageSize]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return (accounts.data ?? []).filter((account) => {
      if (role === 'admin' && !account.isAdmin) return false;
      if (role === 'member' && account.isAdmin) return false;
      if (password === 'set' && account.hasPassword === false) return false;
      if (password === 'unset' && account.hasPassword !== false) return false;
      if (sso === 'bound' && account.identityCount === 0) return false;
      if (sso === 'unbound' && account.identityCount > 0) return false;
      if (wecom === 'bound' && !account.wecomUserId) return false;
      if (wecom === 'unbound' && account.wecomUserId) return false;
      if (!needle) return true;
      return `${account.name} ${account.email} ${account.title}`.toLowerCase().includes(needle);
    });
  }, [accounts.data, keyword, role, password, sso, wecom]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize],
  );
  const hasFilters = Boolean(keyword.trim()) || role !== 'all' || password !== 'all' || sso !== 'all' || wecom !== 'all';

  const create = async () => {
    if (!form.name.trim() || !form.email.trim() || form.password.length < 8) {
      toast.error('请填写姓名、邮箱，密码至少 8 位');
      return;
    }
    setSaving(true);
    try {
      await api.createAccount({ ...form, name: form.name.trim(), email: form.email.trim(), title: form.title.trim() || undefined });
      toast.success('账号已创建');
      setCreateOpen(false);
      setForm({ name: '', email: '', title: '', password: '', isAdmin: false });
      await accounts.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '创建账号失败');
    } finally { setSaving(false); }
  };

  const toggleAdmin = async (account: AccountRow) => {
    try {
      await api.updateAccountAdmin(account.id, { isAdmin: !account.isAdmin });
      toast.success(account.isAdmin ? '已取消管理员' : '已设为管理员');
      await accounts.refresh();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '更新失败'); }
  };

  const resetPassword = async () => {
    if (!reset || newPassword.length < 8) { toast.error('密码至少 8 位'); return; }
    setResetting(true);
    try {
      await api.updateAccountAdmin(reset.id, { password: newPassword });
      toast.success('密码已重置');
      setReset(null);
      setNewPassword('');
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '重置失败'); } finally { setResetting(false); }
  };

  const openEdit = (account: AccountRow) => {
    setEdit(account);
    setEditForm({ name: account.name, title: account.title });
  };

  const saveEdit = async () => {
    if (!edit) return;
    setUpdating(true);
    try {
      await api.updateAccountAdmin(edit.id, { name: editForm.name.trim(), title: editForm.title.trim() });
      toast.success('账号资料已更新');
      setEdit(null);
      await accounts.refresh();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '更新失败'); } finally { setUpdating(false); }
  };

  const removeAccount = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.deleteAccount(removeTarget.id);
      toast.success('账号已删除');
      setRemoveTarget(null);
      await accounts.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除账号失败');
    } finally { setRemoving(false); }
  };

  const columns: Column<AccountRow>[] = [
    {
      key: 'person',
      header: '人员',
      render: (account) => (
        <div className="hstack gap-8">
          <Avatar name={account.name} tone={toneFor(account.email)} size="sm" />
          <div className="vstack gap-2" style={{ minWidth: 0 }}>
            <span className="strong truncate">{account.name}</span>
            <span className="tiny dim truncate">{account.title || '—'}</span>
          </div>
        </div>
      ),
    },
    { key: 'email', header: '邮箱', width: 210, render: (account) => <span className="mono tiny">{account.email}</span> },
    {
      key: 'role',
      header: '角色',
      width: 100,
      render: (account) => <Badge size="sm" tone={account.isAdmin ? 'violet' : 'slate'} dot>{account.isAdmin ? '管理员' : '成员'}</Badge>,
      sortValue: (account) => account.isAdmin ? 1 : 0,
    },
    {
      key: 'wecom',
      header: '企业微信',
      width: 170,
      render: (account) => account.wecomUserId ? (
        <div className="vstack gap-2" style={{ minWidth: 0 }}>
          <Badge size="sm" tone="green">已绑定</Badge>
          <span className="tiny dim mono truncate" title={account.wecomUserId}>{account.wecomUserId}</span>
        </div>
      ) : <Badge size="sm" tone="amber">未绑定</Badge>,
      sortValue: (account) => account.wecomUserId ? 1 : 0,
    },
    {
      key: 'auth',
      header: '登录方式',
      width: 190,
      render: (account) => (
        <div className="hstack gap-4 wrap">
          <Badge size="sm" tone={account.hasPassword === false ? 'amber' : 'green'}>
            {account.hasPassword === false ? '无本地密码' : '本地密码'}
          </Badge>
          <Badge size="sm" tone={account.identityCount > 0 ? 'cyan' : 'slate'}>
            {account.identityCount} 个统一认证
          </Badge>
        </div>
      ),
      sortValue: (account) => account.identityCount,
    },
    {
      key: 'lastSeenAt',
      header: '最近活跃',
      width: 105,
      render: (account) => <span className="tiny dim" title={account.lastSeenAt ? fmtDateTime(account.lastSeenAt) : '从未'}>{account.lastSeenAt ? fmtRelative(account.lastSeenAt) : '从未'}</span>,
      sortValue: (account) => (account.lastSeenAt ? Date.parse(account.lastSeenAt) : 0),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      width: 120,
      render: (account) => <span className="tiny dim">{fmtDateTime(account.createdAt)}</span>,
      sortValue: (account) => Date.parse(account.createdAt) || 0,
    },
    {
      key: 'actions',
      header: '操作',
      width: 310,
      align: 'right',
      render: (account) => (
        <div className="hstack gap-4" style={{ justifyContent: 'flex-end' }} onClick={(event) => event.stopPropagation()}>
          <Button size="sm" variant="ghost" icon="pencil" onClick={() => openEdit(account)}>编辑</Button>
          <Button size="sm" variant="ghost" icon="key" onClick={() => { setReset(account); setNewPassword(''); }}>重置密码</Button>
          <Button size="sm" variant="ghost" icon="shield" onClick={() => void toggleAdmin(account)}>{account.isAdmin ? '取消管理员' : '设为管理员'}</Button>
          {account.id !== person?.id ? (
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setRemoveTarget(account)}>删除</Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <Card>
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <SectionHead
            title={<><Icon name="users" size={14} />员工账号</>}
            desc="员工账号：人员即账号；企业微信绑定决定员工身份，支持本地密码、组织认证与管理员权限管理。"
            actions={<Button size="sm" variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>新建账号</Button>}
          />
        </div>
        <div className="toolbar" style={{ padding: '0 16px 10px' }}>
          <div className="toolbar-left">
            <Select className="ws-filter-select" value={role} options={ROLE_OPTIONS} onChange={(event) => setRole(event.target.value)} />
            <Select className="ws-filter-select" value={password} options={PASSWORD_OPTIONS} onChange={(event) => setPassword(event.target.value)} />
            <Select className="ws-filter-select" value={sso} options={SSO_OPTIONS} onChange={(event) => setSso(event.target.value)} />
            <Select className="ws-filter-select" value={wecom} options={WECOM_OPTIONS} onChange={(event) => setWecom(event.target.value)} />
            <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索姓名 / 邮箱 / 职位" className="ws-search" />
            <span className="tiny dim">共 {filtered.length} 个账号</span>
          </div>
          <div className="toolbar-right">
            {hasFilters ? <Button size="sm" variant="ghost" onClick={() => { setKeyword(''); setRole('all'); setPassword('all'); setSso('all'); setWecom('all'); }}>清除筛选</Button> : null}
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void accounts.refresh()}>刷新</Button>
          </div>
        </div>
        {accounts.error ? (
          <div style={{ padding: 16 }}><Callout tone="red" icon="alert">{accounts.error}</Callout></div>
        ) : (
          <>
            <Table
              columns={columns}
              rows={paged}
              rowKey={(account) => account.id}
              sortable
              resizable
              loading={accounts.loading && !accounts.data}
              onRowClick={openEdit}
              empty={hasFilters ? (
                <EmptyState compact icon="filter" title="没有匹配的账号" description="调整角色、登录方式或关键词。" />
              ) : (
                <EmptyState icon="users" title="还没有账号" description="创建第一个本地账号。" action={<Button size="sm" variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>新建账号</Button>} />
              )}
            />
            {!accounts.loading && filtered.length > 0 ? (
              <div className="ws-table-foot">
                <Pagination
                  page={currentPage}
                  totalPages={totalPages}
                  total={filtered.length}
                  pageSize={pageSize}
                  pageSizeOptions={PAGE_SIZE_OPTIONS}
                  onPageSizeChange={setPageSize}
                  onChange={setPage}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建账号" description="创建本地账号；后续可由本人绑定统一认证。"
        footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button><Button variant="primary" icon="check" loading={saving} onClick={() => void create()}>创建账号</Button></>}>
        <div className="vstack gap-12">
          <div className="grid grid-2">
            <Field label="姓名" required><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label="邮箱" required><Input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="职位/角色"><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field>
            <Field label="初始密码" required><Input type="password" value={form.password} autoComplete="new-password" onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          </div>
          <Switch checked={form.isAdmin} onChange={(next) => setForm({ ...form, isAdmin: next })} label="设为管理员" />
        </div>
      </Modal>

      <Modal open={Boolean(reset)} onClose={() => setReset(null)} title={`重置 ${reset?.name ?? ''} 的密码`} description="重置后旧密码立即失效。"
        footer={<><Button variant="ghost" onClick={() => setReset(null)}>取消</Button><Button variant="primary" icon="check" loading={resetting} onClick={() => void resetPassword()}>确认重置</Button></>}>
        <Field label="新密码"><Input type="password" value={newPassword} autoComplete="new-password" onChange={(event) => setNewPassword(event.target.value)} /></Field>
      </Modal>

      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={`编辑 ${edit?.name ?? ''}`} description="修改姓名与职位，不改变登录方式。"
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>取消</Button><Button variant="primary" icon="check" loading={updating} onClick={() => void saveEdit()}>保存</Button></>}>
        <div className="grid grid-2">
          <Field label="姓名"><Input value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></Field>
          <Field label="职位/角色"><Input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} /></Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void removeAccount()}
        title={`删除账号「${removeTarget?.name ?? ''}」？`}
        description="删除后该人员的会话和统一认证绑定会移除；仍拥有项目或为最后一个管理员时不能删除。"
        confirmLabel="删除账号"
        loading={removing}
      />
    </>
  );
}
