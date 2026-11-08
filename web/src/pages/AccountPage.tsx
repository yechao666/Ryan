import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuthProvider } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Modal,
  PageHead,
  SectionHead,
  Skeleton,
  useToast,
} from '@ui';
import { fmtDateTime, fmtRelative } from '@lib/format.ts';
import { toneFor } from '../components/projects/helpers.tsx';

/** 账号：人员即账号；本地密码 + 多 OIDC 统一认证绑定。 */
export function AccountPage() {
  const { person, refresh: refreshAuth } = useAuth();
  const toast = useToast();
  const account = useAsync(() => api.account(), []);
  const providers = useAsync(() => api.authProviders(), []);
  const apiKeys = useAsync(() => api.accountApiKeys(), []);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<{ id: string; name: string } | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [binding, setBinding] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState('DSH 插件');
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<{ id: string; name: string } | null>(null);
  const [deletingKey, setDeletingKey] = useState(false);

  useEffect(() => {
    if (!account.data) return;
    setName(account.data.person.name);
    setTitle(account.data.person.title);
  }, [account.data]);

  const profile = account.data;
  const linkedProviderIds = new Set(profile?.identities.map((identity) => identity.providerId) ?? []);
  const available = (providers.data ?? []).filter((provider) => !linkedProviderIds.has(provider.id));

  const createApiKey = async () => {
    setCreatingKey(true);
    try {
      const result = await api.createAccountApiKey(keyName.trim() || 'DSH 插件');
      setCreatedKey(result.key);
      await apiKeys.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '创建密钥失败');
    } finally { setCreatingKey(false); }
  };

  const deleteApiKey = async () => {
    if (!deleteKeyTarget) return;
    setDeletingKey(true);
    try {
      await api.deleteAccountApiKey(deleteKeyTarget.id);
      toast.success('API 密钥已吊销');
      setDeleteKeyTarget(null);
      await apiKeys.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '吊销密钥失败');
    } finally { setDeletingKey(false); }
  };

  const saveProfile = async () => {
    if (!name.trim()) {
      toast.error('姓名不能为空');
      return;
    }
    setSavingProfile(true);
    try {
      await api.updateAccount({ name: name.trim(), title: title.trim() });
      toast.success('账号资料已更新');
      await Promise.all([account.refresh(), refreshAuth()]);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    if (newPassword.length < 8) {
      toast.error('新密码至少 8 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致');
      return;
    }
    setSavingPassword(true);
    try {
      await api.changePassword({
        currentPassword: profile?.hasPassword ? currentPassword : undefined,
        newPassword,
      });
      toast.success(profile?.hasPassword ? '密码已更新' : '本地密码已设置');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await account.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '修改密码失败');
    } finally {
      setSavingPassword(false);
    }
  };

  const bindProvider = async (provider: Pick<AuthProvider, 'id' | 'name'>) => {
    setBinding(provider.id);
    try {
      const result = await api.startIdentityBind(provider.id);
      window.location.assign(result.url);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '发起绑定失败');
      setBinding(null);
    }
  };

  const unlink = async () => {
    if (!unlinkTarget) return;
    setUnlinking(true);
    try {
      await api.unlinkIdentity(unlinkTarget.id);
      toast.success('已解除统一认证绑定');
      setUnlinkTarget(null);
      await account.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '解除绑定失败');
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        title="账号"
        desc="账号就是 Ryan 的人员身份；可以维护资料、本地密码，并绑定多个统一认证。"
      />

      {account.loading && !account.data ? (
        <div className="vstack gap-12">{[0, 1, 2].map((item) => <Skeleton key={item} h={120} />)}</div>
      ) : account.error ? (
        <Card><div style={{ padding: 18 }}><ErrorState message={account.error} onRetry={() => void account.refresh()} /></div></Card>
      ) : profile ? (
        <>
          <Card className="card-pad">
            <div className="hstack gap-12" style={{ alignItems: 'flex-start' }}>
              <Avatar name={profile.person.name} tone={toneFor(profile.person.email)} size="lg" />
              <div className="grow">
                <div className="hstack gap-6 wrap">
                  <div className="card-title">{profile.person.name}</div>
                  {profile.person.isAdmin ? <Badge tone="violet" size="sm">管理员</Badge> : null}
                  <Badge tone={profile.hasPassword ? 'green' : 'amber'} size="sm">
                    {profile.hasPassword ? '本地密码已设置' : '仅统一认证'}
                  </Badge>
                </div>
                <div className="tiny dim mono">{profile.person.email}</div>
                <div className="tiny dim mt-4">加入于 {fmtDateTime(profile.person.createdAt)}</div>
              </div>
            </div>
            <div className="grid grid-2 mt-16">
              <Field label="姓名">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="职位/角色">
                <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：后端工程师" />
              </Field>
            </div>
            <div className="hstack gap-6 mt-12">
              <Button variant="primary" icon="check" loading={savingProfile} onClick={() => void saveProfile()}>
                保存资料
              </Button>
            </div>
          </Card>

          <Card className="card-pad">
            <SectionHead
              title={<><Icon name="lock" size={14} />本地密码</>}
              desc={profile.hasPassword ? '修改本地密码后仍可使用统一认证登录。' : '当前账号由统一认证创建，设置本地密码后可独立登录。'}
            />
            <div className="grid grid-3 mt-12">
              {profile.hasPassword ? (
                <Field label="当前密码">
                  <Input type="password" value={currentPassword} autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} />
                </Field>
              ) : null}
              <Field label="新密码">
                <Input type="password" value={newPassword} autoComplete="new-password" onChange={(event) => setNewPassword(event.target.value)} />
              </Field>
              <Field label="确认新密码">
                <Input type="password" value={confirmPassword} autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} />
              </Field>
            </div>
            <div className="hstack gap-6 mt-12">
              <Button variant="primary" icon="check" loading={savingPassword} onClick={() => void savePassword()}>
                {profile.hasPassword ? '更新密码' : '设置密码'}
              </Button>
            </div>
          </Card>

          <Card className="card-pad">
            <SectionHead
              title={<><Icon name="shield" size={14} />统一认证</>}
              desc="一个账号可以绑定多个统一认证源；解绑前需确保仍保留一种登录方式。"
              actions={
                profile.person.isAdmin ? (
                  <Link className="ws-link small" to="/settings">管理认证源</Link>
                ) : null
              }
            />
            <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              {profile.identities.length === 0 ? (
                <EmptyState icon="shield" title="尚未绑定统一认证" description="绑定后可使用组织身份直接登录。" compact />
              ) : profile.identities.map((identity) => (
                <div className="ws-pick-item" key={identity.id}>
                  <span className="cx-metric-icon tone-cyan"><Icon name="shield" size={14} /></span>
                  <div className="ws-pick-main grow">
                    <span className="ws-pick-name">{identity.providerName}</span>
                    <span className="tiny dim">{identity.email || identity.subject} · 绑定于 {fmtDateTime(identity.createdAt)}</span>
                  </div>
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setUnlinkTarget({ id: identity.id, name: identity.providerName })}>
                    解除绑定
                  </Button>
                </div>
              ))}
              {available.length ? (
                <div className="hstack gap-6 wrap" style={{ marginTop: 8 }}>
                  {available.map((provider) => (
                    <Button key={provider.id} size="sm" variant="outline" icon="plus" loading={binding === provider.id} onClick={() => void bindProvider(provider)}>
                      绑定 {provider.name}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="card-pad">
            <SectionHead
              title={<><Icon name="key" size={14} />API 密钥</>}
              desc="给 DSH 插件等外部客户端使用；密钥只显示一次，可随时吊销。"
              actions={<Button size="sm" variant="primary" icon="plus" onClick={() => { setKeyName('DSH 插件'); setCreatedKey(null); setKeyOpen(true); }}>创建密钥</Button>}
            />
            <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              {apiKeys.loading && !apiKeys.data ? <Skeleton h={46} /> : apiKeys.error ? (
                <Callout tone="red" icon="alert">{apiKeys.error}</Callout>
              ) : !apiKeys.data?.keys.length ? (
                <EmptyState icon="key" title="还没有 API 密钥" description="为 DSH 插件创建一把密钥，填入插件配置页即可接入 Ryan。" compact />
              ) : apiKeys.data.keys.map((key) => (
                <div className="ws-pick-item" key={key.id}>
                  <span className="cx-metric-icon tone-amber"><Icon name="key" size={14} /></span>
                  <div className="ws-pick-main grow">
                    <span className="ws-pick-name">{key.name}</span>
                    <span className="tiny dim mono">{key.prefix}… · 创建于 {fmtDateTime(key.createdAt)}{key.lastUsedAt ? ` · 最近使用 ${fmtRelative(key.lastUsedAt)}` : ' · 尚未使用'}</span>
                  </div>
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleteKeyTarget({ id: key.id, name: key.name })}>吊销</Button>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      <Modal
        open={keyOpen}
        onClose={() => { setKeyOpen(false); setCreatedKey(null); }}
        title={createdKey ? 'API 密钥已创建' : '创建 API 密钥'}
        description={createdKey ? '复制并保存到 DSH 插件配置页；关闭后无法再次查看。' : '密钥将绑定到当前账号，可在任意 DSH 插件中使用。'}
        footer={createdKey ? <Button variant="primary" onClick={() => { setKeyOpen(false); setCreatedKey(null); }}>我已保存</Button> : (
          <>
            <Button variant="ghost" onClick={() => setKeyOpen(false)}>取消</Button>
            <Button variant="primary" icon="plus" loading={creatingKey} onClick={() => void createApiKey()}>创建</Button>
          </>
        )}
      >
        {createdKey ? (
          <div className="vstack gap-10">
            <Callout tone="amber" icon="alert">这是密钥唯一一次明文展示，请立即复制保存。</Callout>
            <div className="hstack gap-6">
              <Input value={createdKey} readOnly className="mono" />
              <CopyButton value={createdKey} />
            </div>
          </div>
        ) : (
          <Field label="密钥名称"><Input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="例如：我的 Mac DSH" /></Field>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteKeyTarget)}
        onClose={() => setDeleteKeyTarget(null)}
        onConfirm={() => void deleteApiKey()}
        title={`吊销「${deleteKeyTarget?.name ?? ''}」？`}
        description="吊销后使用该密钥的 DSH 插件会立即失去连接，需要重新创建并配置。"
        confirmLabel="吊销密钥"
        loading={deletingKey}
      />

      <ConfirmDialog
        open={Boolean(unlinkTarget)}
        onClose={() => setUnlinkTarget(null)}
        onConfirm={() => void unlink()}
        title={`解除 ${unlinkTarget?.name ?? ''} 绑定？`}
        description="解除后将不能再用该统一认证登录，但仍可使用其他已绑定方式和本地密码。"
        confirmLabel="解除绑定"
        loading={unlinking}
      />
    </div>
  );
}
