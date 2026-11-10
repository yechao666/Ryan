import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@shared';
import { Avatar, Badge, Button, Callout, Card, Field, Icon, Input, Modal, Skeleton, useToast, type IconName } from '@ui';
import { useAuth } from '../lib/auth.tsx';
import { useAsync } from '../lib/hooks.ts';
import { api } from '../lib/api.ts';
import { toneFor } from '../components/projects/helpers.tsx';

/**
 * 登录页：左侧品牌与价值点，右侧登录卡。
 * 演示账号来自 /api/meta，点击自动填入邮箱与密码。
 */

const VALUE_POINTS: { icon: IconName; title: string; desc: string }[] = [
  { icon: 'users', title: '人员与团队', desc: '人员组队、管理项目，按可见性与角色协作。' },
  { icon: 'brain', title: '项目记忆', desc: '每个项目独立记忆身份，任务结论自动沉淀。' },
  { icon: 'server', title: '智能体执行', desc: '智能体注册、领取任务，进展实时回流控制台。' },
];

export function LoginPage() {
  const { person, login, loginWithToken } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useAsync(() => api.meta(), []);
  const providers = useAsync(() => api.authProviders(), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() => new URLSearchParams(window.location.search).get('sso_error'));
  const [qrProvider, setQrProvider] = useState<{ id: string; slug: string; name: string } | null>(null);
  const [qrConfig, setQrConfig] = useState<{ appid: string; agentid: string; redirectUri: string; state: string; authorizeUrl: string; qrUrl: string } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  if (person) return <Navigate to="/" replace />;

  const demoAccounts = meta.data?.demoAccounts ?? [];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError('请输入邮箱与密码。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      toast.success('登录成功，欢迎回到 Ryan');
      navigate('/', { replace: true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '登录失败，请检查邮箱与密码。';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const openQr = async (provider: { id: string; slug: string; name: string }): Promise<void> => {
    setQrProvider(provider);
    setQrConfig(null);
    setQrError(null);
    try {
      setQrConfig(await api.wecomQr(provider.slug));
    } catch (cause) {
      setQrError(cause instanceof Error ? cause.message : '无法获取企业微信二维码配置');
    }
  };

  const closeQr = (): void => {
    setQrProvider(null);
    setQrConfig(null);
    setQrError(null);
  };

  useEffect(() => {
    if (!qrProvider) return;
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; token?: unknown };
      if (data?.type !== 'ryan-wecom-login' || typeof data.token !== 'string') return;
      setQrProvider(null);
      setQrConfig(null);
      setQrError(null);
      void loginWithToken(data.token).then(() => navigate('/', { replace: true }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [qrProvider, loginWithToken, navigate]);

  return (
    <div className="login-page">
      <section className="login-hero">
        <div>
          <div className="cx-login-brand">
            <div className="brand-mark">R</div>
            <div>
              <div className="brand-name">{APP_NAME}</div>
              <div className="brand-sub">{APP_TAGLINE}</div>
            </div>
          </div>

          <h1>
            让每个人员
            <br />
            都拥有自己的 DSH 执行网络
          </h1>
          <p>
            人员创建任务，智能体执行，提示卡沉淀工作方式，项目记忆保留上下文。
            一个控制台管理众多智能体的即时、周期与响应式任务。
          </p>

          <div className="login-points cx-login-points">
            {VALUE_POINTS.map((point) => (
              <div className="login-point cx-login-point" key={point.title}>
                <span className="cx-login-point__icon">
                  <Icon name={point.icon} size={15} />
                </span>
                <div>
                  <div className="cx-login-point__title">{point.title}</div>
                  <div className="cx-login-point__desc">{point.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="row-between cx-login-hero__foot">
          <span className="tiny dim">瑞安网络安全 · DSH 编排平台 · 本地演示环境</span>
          <Badge size="sm" tone="slate">
            v{APP_VERSION}
          </Badge>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="cx-login-mobile-brand">
            <div className="brand-mark">R</div>
            <div>
              <div className="brand-name">{APP_NAME}</div>
              <div className="brand-sub">{APP_TAGLINE}</div>
            </div>
          </div>

          <Card pad className="cx-login-card">
            <div className="cx-login-card__head">
              <div>
                <div className="cx-login-title">登录控制台</div>
                <div className="card-sub">使用组织账号或下方演示账号继续</div>
              </div>
              <span className="cx-login-badge">
                <Icon name="shield" size={13} />
                安全会话
              </span>
            </div>

            <form className="stack" style={{ gap: 14, marginTop: 18 }} onSubmit={handleSubmit}>
              <Field label="邮箱" htmlFor="login-email" required>
                <Input
                  id="login-email"
                  type="email"
                  icon="mail"
                  value={email}
                  autoComplete="username"
                  placeholder="you@ryan.dev"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>

              <Field label="密码" htmlFor="login-password" required>
                <Input
                  id="login-password"
                  className="cx-has-suffix"
                  type={showPassword ? 'text' : 'password'}
                  icon="lock"
                  value={password}
                  autoComplete="current-password"
                  placeholder="输入密码"
                  onChange={(event) => setPassword(event.target.value)}
                  suffix={
                    <button
                      type="button"
                      className="cx-input-action"
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      <Icon name="eye" size={14} />
                    </button>
                  }
                />
              </Field>

              {error ? (
                <Callout tone="red" icon="xCircle">
                  {error}
                </Callout>
              ) : null}

              <Button type="submit" variant="primary" size="lg" block loading={submitting} icon="arrowRight">
                {submitting ? '正在登录…' : '登录 Ryan'}
              </Button>
            </form>

            {providers.data?.length ? (
              <div className="stack" style={{ gap: 10, marginTop: 16 }}>
                <div className="hstack gap-8">
                  <span className="divider" style={{ flex: 1 }} />
                  <span className="tiny dim">或使用组织认证</span>
                  <span className="divider" style={{ flex: 1 }} />
                </div>
                {providers.data.map((provider) => provider.type === 'wecom' ? (
                  <div className="vstack gap-5" key={provider.id}>
                    <Button variant="outline" size="lg" block icon="wechat" onClick={() => void openQr(provider)}>
                      企业微信扫码登录 · {provider.name}
                    </Button>
                    <a className="tiny dim center" href={`/api/auth/sso/${encodeURIComponent(provider.slug)}/start`}>
                      在企业微信客户端内直接打开
                    </a>
                  </div>
                ) : (
                  <a
                    key={provider.id}
                    className="btn btn-outline btn-lg btn-block"
                    href={`/api/auth/sso/${encodeURIComponent(provider.slug)}/start`}
                  >
                    <Icon name="shield" size={15} />
                    使用 {provider.name} 登录
                  </a>
                ))}
              </div>
            ) : providers.error ? (
              <div className="tiny dim" style={{ marginTop: 12 }}>统一认证配置加载失败。</div>
            ) : null}

            <div className="login-demo">
              <div className="row-between">
                <span className="cx-demo-label">演示账号</span>
                <span className="tiny dim">点击自动填入</span>
              </div>

              {meta.loading ? (
                <div className="stack" style={{ gap: 8 }}>
                  {[0, 1, 2].map((item) => (
                    <Skeleton key={item} h={26} />
                  ))}
                </div>
              ) : meta.error ? (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="tiny muted">演示账号加载失败，请手动输入邮箱与密码。</div>
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => void meta.refresh()}>
                    重新加载
                  </Button>
                </div>
              ) : (
                demoAccounts.map((account) => (
                  <button
                    type="button"
                    key={account.email}
                    className="login-demo__account"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(account.password);
                      setError(null);
                    }}
                  >
                    <Avatar name={account.name} tone={toneFor(account.email)} size="sm" />
                    <span className="cx-demo-account__meta">
                      <span className="cx-demo-account__name">
                        {account.name}
                        <span className="cx-demo-account__title">{account.title}</span>
                      </span>
                      <span className="cx-demo-account__email mono">{account.email}</span>
                    </span>
                    <Badge size="sm" tone={account.role.includes('管理员') ? 'violet' : 'slate'}>
                      {account.role}
                    </Badge>
                  </button>
                ))
              )}
            </div>
          </Card>

          <div className="cx-login-foot">
            <span>Ryan（瑞安）· 网络安全 DSH 编排平台</span>
            <span className="dim">演示密码：ryan-demo</span>
          </div>
        </div>
      </section>
      <Modal
        open={Boolean(qrProvider)}
        onClose={closeQr}
        title={`企业微信扫码登录${qrProvider ? ` · ${qrProvider.name}` : ''}`}
        description="使用企业微信扫描二维码，授权后自动登录 Ryan。"
        size="sm"
        footer={<Button variant="ghost" onClick={closeQr}>取消</Button>}
      >
        {qrError ? (
          <Callout tone="red" icon="xCircle">
            {qrError}
            {qrConfig ? <div className="mt-8"><a href={qrConfig.qrUrl || qrConfig.authorizeUrl} target="_blank" rel="noreferrer">在企业微信中打开登录面板</a></div> : null}
          </Callout>
        ) : !qrConfig ? (
          <div className="vstack gap-8"><Skeleton h={180} /><span className="tiny dim">正在准备二维码…</span></div>
        ) : (
          <div className="wecom-qr-wrap">
            <iframe
              title="企业微信扫码登录"
              src={qrConfig.qrUrl}
              width="320"
              height="360"
              frameBorder={0}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        )}
        <div className="tiny dim center">二维码由企业微信提供，使用企业微信扫码授权。</div>
      </Modal>
    </div>
  );
}
