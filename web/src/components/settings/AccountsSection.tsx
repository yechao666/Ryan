import { useState } from 'react';
import type { Person } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { Avatar, Badge, Button, Callout, Card, EmptyState, Field, Icon, Input, Modal, SectionHead, Switch, useToast } from '@ui';
import { toneFor } from '../projects/helpers.tsx';

type AccountRow = Person & { identityCount: number };

export function AccountsSection() {
  const toast = useToast();
  const accounts = useAsync(() => api.adminAccounts(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', title: '', password: '', isAdmin: false });
  const [saving, setSaving] = useState(false);
  const [reset, setReset] = useState<AccountRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);

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

  return (
    <>
      <Card className="card-pad">
        <SectionHead
          title={<><Icon name="users" size={14} />账号管理</>}
          desc="人员即账号；管理员可创建本地账号、维护管理员权限或重置密码。"
          actions={<Button size="sm" variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>新建账号</Button>}
        />
        {accounts.error ? <Callout tone="red" icon="alert">{accounts.error}</Callout>
          : !accounts.data?.length ? <EmptyState icon="users" title="还没有账号" compact />
          : <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              {accounts.data.map((account) => (
                <div className="ws-pick-item" key={account.id}>
                  <Avatar name={account.name} tone={toneFor(account.email)} size="sm" />
                  <div className="ws-pick-main grow">
                    <span className="ws-pick-name">{account.name}</span>
                    <span className="tiny dim mono">{account.email}</span>
                    <span className="tiny dim">{account.title || '—'} · {account.identityCount} 个统一认证绑定</span>
                  </div>
                  {account.hasPassword === false ? <Badge size="sm" tone="amber">无本地密码</Badge> : null}
                  <Badge size="sm" tone={account.isAdmin ? 'violet' : 'slate'} dot>{account.isAdmin ? '管理员' : '成员'}</Badge>
                  <Button size="sm" variant="ghost" icon="key" onClick={() => { setReset(account); setNewPassword(''); }}>重置密码</Button>
                  <Button size="sm" variant="ghost" icon="shield" onClick={() => void toggleAdmin(account)}>{account.isAdmin ? '取消管理员' : '设为管理员'}</Button>
                </div>
              ))}
            </div>}
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
    </>
  );
}
