import { useEffect, useState } from 'react';
import { DEFAULT_SECURITY_SETTINGS } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorState,
  Field,
  Icon,
  Input,
  PageHead,
  SectionHead,
  Skeleton,
  Switch,
  useToast,
} from '@ui';
import { api, type SecurityTestResult } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtRelative } from '../lib/format.ts';
import { useAsync } from '../lib/hooks.ts';
import { AuthProvidersSection } from '../components/settings/AuthProvidersSection.tsx';

interface SecurityFormState {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: string;
  blockMessage: string;
}

interface AssistantFormState {
  enabled: boolean;
  instanceId: string;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * 系统设置：安全检查组与助手运行服务。
 * API Key 只显示「已配置」，服务端不回显明文；留空保存表示保持原值。
 */
export function SettingsPage() {
  const { person } = useAuth();
  const toast = useToast();
  const isAdmin = Boolean(person?.isAdmin);
  const settings = useAsync(() => api.settings(), []);

  const [security, setSecurity] = useState<SecurityFormState>({
    enabled: DEFAULT_SECURITY_SETTINGS.enabled,
    endpoint: DEFAULT_SECURITY_SETTINGS.endpoint,
    model: DEFAULT_SECURITY_SETTINGS.model,
    apiKey: '',
    timeoutMs: String(DEFAULT_SECURITY_SETTINGS.timeoutMs),
    blockMessage: DEFAULT_SECURITY_SETTINGS.blockMessage,
  });
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SecurityTestResult | null>(null);

  const [assistant, setAssistant] = useState<AssistantFormState>({ enabled: true, instanceId: '' });
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [savingAssistant, setSavingAssistant] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    const next = settings.data;
    setSecurity({
      enabled: next.security.enabled,
      endpoint: next.security.endpoint,
      model: next.security.model,
      apiKey: '',
      timeoutMs: String(next.security.timeoutMs),
      blockMessage: next.security.blockMessage,
    });
    setAssistant({
      enabled: next.assistant.enabled,
      instanceId: next.assistant.instanceId ?? '',
    });
  }, [settings.data]);

  const handleSaveSecurity = async () => {
    if (!isAdmin) return;
    const timeout = Number(security.timeoutMs);
    if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) {
      setSecurityError('超时时间需为 500–60000 毫秒的整数。');
      return;
    }
    setSavingSecurity(true);
    setSecurityError(null);
    try {
      const response = await api.updateSecuritySettings({
        enabled: security.enabled,
        endpoint: security.endpoint.trim(),
        model: security.model.trim(),
        timeoutMs: timeout,
        blockMessage: security.blockMessage.trim(),
        ...(security.apiKey.trim() ? { apiKey: security.apiKey.trim() } : {}),
      });
      setSecurity((prev) => ({
        ...prev,
        enabled: response.security.enabled,
        endpoint: response.security.endpoint,
        model: response.security.model,
        apiKey: '',
        timeoutMs: String(response.security.timeoutMs),
        blockMessage: response.security.blockMessage,
      }));
      setTestResult(null);
      toast.success('安全检查设置已保存');
      await settings.refresh();
    } catch (cause) {
      const message = errorMessage(cause, '保存安全检查设置失败');
      setSecurityError(message);
      toast.error(message);
    } finally {
      setSavingSecurity(false);
    }
  };

  const handleTest = async () => {
    if (!isAdmin) return;
    setTesting(true);
    try {
      const result = await api.testSecurity();
      setTestResult(result);
      if (result.skipped) toast.info(result.message ?? '安全检查未启用');
      else if (result.ok) toast.success('安全检查组连接成功');
      else toast.error(result.error ?? result.message ?? '安全检查组连接失败');
    } catch (cause) {
      const message = errorMessage(cause, '测试安全检查连接失败');
      setTestResult({ ok: false, error: message });
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const handleSaveAssistant = async () => {
    if (!isAdmin) return;
    setSavingAssistant(true);
    setAssistantError(null);
    try {
      const response = await api.updateAssistantSettings({
        enabled: assistant.enabled,
        instanceId: assistant.instanceId || null,
      });
      setAssistant({
        enabled: response.assistant.enabled,
        instanceId: response.assistant.instanceId ?? '',
      });
      toast.success('助手配置已保存');
      await settings.refresh();
    } catch (cause) {
      const message = errorMessage(cause, '保存助手配置失败');
      setAssistantError(message);
      toast.error(message);
    } finally {
      setSavingAssistant(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="系统设置 · Settings"
        title="系统设置"
        desc="配置输入安全检查与助手运行服务。敏感配置只保存在服务端，接口不会回显明文。"
        actions={
          <Button variant="ghost" icon="refresh" onClick={() => void settings.refresh()}>
            刷新
          </Button>
        }
      />

      {!isAdmin ? (
        <Callout tone="amber" icon="shield">
          系统设置仅组织管理员可修改；当前账号可以查看配置状态，但无法保存或测试连接。
        </Callout>
      ) : null}

      {settings.error && !settings.data ? (
        <ErrorState message={settings.error} onRetry={() => void settings.refresh()} />
      ) : settings.loading && !settings.data ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <Card className="card-pad">
            <Skeleton h={20} />
            <div style={{ height: 12 }} />
            <Skeleton h={40} />
            <div style={{ height: 10 }} />
            <Skeleton h={40} />
            <div style={{ height: 10 }} />
            <Skeleton h={72} />
          </Card>
          <Card className="card-pad">
            <Skeleton h={20} />
            <div style={{ height: 12 }} />
            <Skeleton h={40} />
            <div style={{ height: 10 }} />
            <Skeleton h={40} />
          </Card>
        </div>
      ) : settings.data ? (
        <>
          <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
            <Card className="card-pad">
              <SectionHead
                title="安全检查组"
                desc="创建任务前调用安全模型检查输入；endpoint 为空时自动关闭。"
                actions={
                  <Badge size="sm" tone={settings.data.security.enabled ? 'green' : 'slate'} dot>
                    {settings.data.security.enabled ? '已启用' : '未启用'}
                  </Badge>
                }
              />

              <div className="stack" style={{ gap: 14 }}>
                <Switch
                  checked={security.enabled}
                  disabled={!isAdmin}
                  onChange={(next) => setSecurity((prev) => ({ ...prev, enabled: next }))}
                  label={security.enabled ? '启用输入安全检查' : '关闭输入安全检查'}
                />

                <div className="grid grid-2">
                  <Field
                    label="Endpoint"
                    htmlFor="security-endpoint"
                    hint="兼容 OpenAI Chat Completions，或填写完整的 /v1/chat/completions 地址。"
                  >
                    <Input
                      id="security-endpoint"
                      value={security.endpoint}
                      disabled={!isAdmin}
                      placeholder="https://api.example.com"
                      onChange={(event) => setSecurity((prev) => ({ ...prev, endpoint: event.target.value }))}
                    />
                  </Field>
                  <Field label="Model" htmlFor="security-model" hint="安全检查调用的模型名。">
                    <Input
                      id="security-model"
                      value={security.model}
                      disabled={!isAdmin}
                      placeholder="security-check"
                      onChange={(event) => setSecurity((prev) => ({ ...prev, model: event.target.value }))}
                    />
                  </Field>
                </div>

                <Field
                  label={
                    <span className="hstack gap-6">
                      API Key
                      <Badge size="sm" tone={settings.data.security.apiKeyConfigured ? 'green' : 'slate'}>
                        {settings.data.security.apiKeyConfigured ? '已配置' : '未配置'}
                      </Badge>
                    </span>
                  }
                  htmlFor="security-api-key"
                  hint="只保存在服务端，不会回显；留空保存表示保持当前值。"
                >
                  <Input
                    id="security-api-key"
                    type="password"
                    value={security.apiKey}
                    disabled={!isAdmin}
                    autoComplete="new-password"
                    placeholder={settings.data.security.apiKeyConfigured ? '已配置，留空保持不变' : '输入 API Key'}
                    onChange={(event) => setSecurity((prev) => ({ ...prev, apiKey: event.target.value }))}
                  />
                </Field>

                <div className="grid grid-2">
                  <Field label="超时（毫秒）" htmlFor="security-timeout" hint="500–60000。">
                    <Input
                      id="security-timeout"
                      type="number"
                      min={500}
                      max={60000}
                      value={security.timeoutMs}
                      disabled={!isAdmin}
                      onChange={(event) => setSecurity((prev) => ({ ...prev, timeoutMs: event.target.value }))}
                    />
                  </Field>
                  <Field label="拦截提示语" htmlFor="security-block-message">
                    <Input
                      id="security-block-message"
                      value={security.blockMessage}
                      disabled={!isAdmin}
                      placeholder="该输入未通过安全检查，请调整后重试。"
                      onChange={(event) => setSecurity((prev) => ({ ...prev, blockMessage: event.target.value }))}
                    />
                  </Field>
                </div>

                {!security.endpoint.trim() ? (
                  <Callout tone="amber" icon="info">
                    Endpoint 为空时，安全检查会自动关闭；填写地址后启用才会生效。
                  </Callout>
                ) : null}

                {testResult ? (
                  <Callout
                    tone={testResult.skipped ? 'amber' : testResult.ok ? 'green' : 'red'}
                    icon={testResult.ok ? 'checkCircle' : 'alert'}
                  >
                    {testResult.skipped
                      ? testResult.message ?? '安全检查未启用，已跳过测试。'
                      : testResult.ok
                        ? `连接成功${testResult.status ? `（HTTP ${testResult.status}）` : ''}${testResult.latencyMs != null ? ` · ${testResult.latencyMs}ms` : ''}`
                        : `连接失败：${testResult.error ?? testResult.message ?? '未知错误'}`}
                  </Callout>
                ) : null}

                {securityError ? (
                  <Callout tone="red" icon="xCircle">
                    {securityError}
                  </Callout>
                ) : null}

                <div className="row-between" style={{ paddingTop: 4 }}>
                  <span className="tiny dim">最近更新 {settings.data.updatedAt ? fmtRelative(settings.data.updatedAt) : '—'}</span>
                  <div className="hstack gap-6">
                    <Button
                      variant="outline"
                      size="sm"
                      icon="activity"
                      loading={testing}
                      disabled={!isAdmin}
                      onClick={() => void handleTest()}
                    >
                      测试连接
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      icon="check"
                      loading={savingSecurity}
                      disabled={!isAdmin}
                      onClick={() => void handleSaveSecurity()}
                    >
                      保存安全检查
                    </Button>
                  </div>
                </div>
              </div>
            </Card>

            <div className="stack" style={{ gap: 16 }}>
              <Card className="card-pad">
                <SectionHead
                  title="助手配置"
                  desc="助手运行在服务端本地 DSH 服务中，可调用 Ryan 开放 API。"
                  actions={
                    <Badge size="sm" tone={settings.data.assistant.enabled ? 'green' : 'slate'} dot>
                      {settings.data.assistant.enabled ? '已启用' : '已停用'}
                    </Badge>
                  }
                />
                <div className="stack" style={{ gap: 14 }}>
                  <Switch
                    checked={assistant.enabled}
                    disabled={!isAdmin}
                    onChange={(next) => setAssistant((prev) => ({ ...prev, enabled: next }))}
                    label={assistant.enabled ? '启用系统助手' : '停用系统助手'}
                  />
                  <Callout tone="slate" icon="info">
                    当前版本助手固定使用服务端本地 DSH（headless）；远端服务助手路由将在后续版本开放。
                  </Callout>
                  {assistantError ? (
                    <Callout tone="red" icon="xCircle">
                      {assistantError}
                    </Callout>
                  ) : null}
                  <Button
                    variant="primary"
                    size="sm"
                    icon="check"
                    loading={savingAssistant}
                    disabled={!isAdmin}
                    onClick={() => void handleSaveAssistant()}
                  >
                    保存助手配置
                  </Button>
                </div>
              </Card>

              <Card className="card-pad">
                <div className="card-title">
                  <Icon name="shield" size={15} />
                  安全边界
                </div>
                <ul className="small muted" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.8, listStyle: 'disc' }}>
                  <li>API Key 只保存在服务端，任何接口都不回显明文。</li>
                  <li>Endpoint 为空时安全检查自动关闭，不会发请求。</li>
                  <li>安全检查组超时或异常时按失败处理，不阻塞控制台其他功能。</li>
                </ul>
              </Card>
            </div>
          </div>

          {isAdmin ? <AuthProvidersSection /> : null}
        </>
      ) : null}
    </div>
  );
}
