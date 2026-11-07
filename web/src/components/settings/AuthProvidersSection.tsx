import { useState } from 'react';
import type { AuthProvider } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { Badge, Button, Callout, Card, ConfirmDialog, EmptyState, Field, Icon, Input, Modal, SectionHead, Switch, useToast } from '@ui';

interface FormState {
  name: string;
  slug: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
  autoCreate: boolean;
}

const EMPTY: FormState = { name: '', slug: '', issuer: '', clientId: '', clientSecret: '', scopes: 'openid profile email', enabled: true, autoCreate: true };

export function AuthProvidersSection() {
  const toast = useToast();
  const providers = useAsync(() => api.authProviderAdmin(), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AuthProvider | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AuthProvider | null>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const create = () => { setEditing(null); setForm(EMPTY); setOpen(true); };
  const edit = (provider: AuthProvider) => {
    setEditing(provider);
    setForm({ name: provider.name, slug: provider.slug, issuer: provider.issuer, clientId: provider.clientId, clientSecret: '', scopes: 'openid profile email', enabled: provider.enabled, autoCreate: provider.autoCreate });
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.issuer.trim() || !form.clientId.trim()) { toast.error('请填写名称、Issuer 和 Client ID'); return; }
    if (!editing && !/^[a-z0-9][a-z0-9-]*$/.test(form.slug)) { toast.error('Slug 只能使用小写字母、数字和短横线'); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.updateAuthProvider(editing.id, { name: form.name.trim(), issuer: form.issuer.trim(), clientId: form.clientId.trim(), ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), scopes: form.scopes.trim() || 'openid profile email', enabled: form.enabled, autoCreate: form.autoCreate });
        toast.success('统一认证已更新');
      } else {
        await api.createAuthProvider({ name: form.name.trim(), slug: form.slug.trim(), issuer: form.issuer.trim(), clientId: form.clientId.trim(), ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), scopes: form.scopes.trim() || 'openid profile email', enabled: form.enabled, autoCreate: form.autoCreate });
        toast.success('统一认证已添加');
      }
      setOpen(false);
      await providers.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存失败');
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!removeTarget) return;
    try {
      await api.deleteAuthProvider(removeTarget.id);
      toast.success('统一认证已删除');
      setRemoveTarget(null);
      await providers.refresh();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '删除失败'); }
  };

  return (
    <>
      <Card className="card-pad">
        <SectionHead
          title={<><Icon name="shield" size={14} />统一认证</>}
          desc="支持多个 OIDC 统一认证源；登录页展示已启用项。"
          actions={<Button size="sm" variant="primary" icon="plus" onClick={create}>添加认证源</Button>}
        />
        {providers.loading && !providers.data ? <div className="tiny dim mt-12">加载中…</div>
          : providers.error ? <Callout tone="red" icon="alert">{providers.error}</Callout>
          : !providers.data?.length ? <EmptyState icon="shield" title="还没有统一认证源" description="添加 OIDC 认证源后，人员可以使用组织账号登录。" compact />
          : <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              {providers.data.map((provider) => (
                <div className="ws-pick-item" key={provider.id}>
                  <span className="cx-metric-icon tone-cyan"><Icon name="shield" size={14} /></span>
                  <div className="ws-pick-main grow">
                    <span className="ws-pick-name">{provider.name}</span>
                    <span className="tiny dim mono">{provider.issuer} · {provider.clientId}</span>
                    <span className="tiny dim mono">{window.location.origin}/api/auth/sso/{provider.slug}/callback</span>
                  </div>
                  <Badge size="sm" tone={provider.enabled ? 'green' : 'slate'} dot>{provider.enabled ? '启用' : '停用'}</Badge>
                  <Badge size="sm" tone={provider.clientSecretConfigured ? 'green' : 'amber'}>{provider.clientSecretConfigured ? 'Secret 已配置' : '无 Secret'}</Badge>
                  <Button size="sm" variant="ghost" icon="settings" onClick={() => edit(provider)}>编辑</Button>
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setRemoveTarget(provider)}>删除</Button>
                </div>
              ))}
            </div>}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? '编辑统一认证' : '添加统一认证'} description="OIDC 配置，Issuer 用于自动发现 endpoint。" size="lg"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>保存</Button></>}>
        <div className="vstack gap-12">
          <div className="grid grid-2">
            <Field label="名称" required><Input value={form.name} placeholder="公司 SSO" onChange={(event) => update('name', event.target.value)} /></Field>
            <Field label="Slug" required hint={editing ? '创建后不可修改' : '用于回调地址'}><Input value={form.slug} disabled={Boolean(editing)} placeholder="corp-sso" onChange={(event) => update('slug', event.target.value)} /></Field>
          </div>
          <Field label="Issuer" required hint="例如 https://login.example.com/realms/main"><Input value={form.issuer} placeholder="https://idp.example.com" onChange={(event) => update('issuer', event.target.value)} /></Field>
          <div className="grid grid-2">
            <Field label="Client ID" required><Input value={form.clientId} onChange={(event) => update('clientId', event.target.value)} /></Field>
            <Field label="Client Secret" hint="留空表示不修改"><Input type="password" value={form.clientSecret} autoComplete="new-password" onChange={(event) => update('clientSecret', event.target.value)} /></Field>
          </div>
          <Field label="Scopes"><Input value={form.scopes} onChange={(event) => update('scopes', event.target.value)} /></Field>
          <div className="hstack gap-16 wrap">
            <Switch checked={form.enabled} onChange={(next) => update('enabled', next)} label="启用登录入口" />
            <Switch checked={form.autoCreate} onChange={(next) => update('autoCreate', next)} label="首次登录自动创建账号" />
          </div>
          <Callout tone="slate" icon="info">Redirect URI：<span className="mono">{window.location.origin}/api/auth/sso/&lt;slug&gt;/callback</span></Callout>
        </div>
      </Modal>

      <ConfirmDialog open={Boolean(removeTarget)} onClose={() => setRemoveTarget(null)} onConfirm={() => void remove()} title={`删除统一认证「${removeTarget?.name ?? ''}」？`} description="已绑定的身份将失效，但人员账号保留。" confirmLabel="删除认证源" />
    </>
  );
}
