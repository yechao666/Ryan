import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { DshInstance, InstanceKind } from '@shared';
import { INSTANCE_KINDS, INSTANCE_STATUSES } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHead,
  SectionHead,
  Select,
  Skeleton,
  Stat,
  useToast,
  type Tone,
} from '@ui';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtRelative, truncateMiddle } from '../lib/format.ts';
import { useAsync, useInterval } from '../lib/hooks.ts';

interface InstanceFormState {
  name: string;
  kind: InstanceKind;
  host: string;
  port: string;
  baseUrl: string;
}

interface SecretState {
  title: string;
  instanceName: string;
  token: string;
  command: string;
}

const EMPTY_FORM: InstanceFormState = {
  name: '',
  kind: 'local',
  host: '127.0.0.1',
  port: '4501',
  baseUrl: '',
};

function instanceStatusMeta(status: string) {
  return INSTANCE_STATUSES.find((item) => item.value === status) ?? { label: status, tone: 'slate' as Tone };
}

function instanceKindMeta(kind: string) {
  return INSTANCE_KINDS.find((item) => item.value === kind) ?? { label: kind, tone: 'slate' as Tone };
}

function hostLabel(instance: DshInstance): string {
  if (instance.baseUrl) return instance.baseUrl;
  if (!instance.host) return '未设置主机';
  return instance.port ? `${instance.host}:${instance.port}` : instance.host;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Aiwo DSH 服务资源：本机 / 远端服务的创建、接入、测试、token 轮换与吊销。
 * 服务是任务的执行者；创建时的一次性 token 与安装命令只展示一次。
 */
export function InstancesPage() {
  const { person } = useAuth();
  const toast = useToast();
  const isAdmin = Boolean(person?.isAdmin);
  const instances = useAsync(() => api.instances(), []);
  // 服务靠心跳更新在线状态，页面每 15s 静默刷新一次资源视图。
  useInterval(() => {
    void instances.refresh();
  }, 15_000);
  const [params, setParams] = useSearchParams();
  const createOpen = params.get('new') === '1';

  const [form, setForm] = useState<InstanceFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [secret, setSecret] = useState<SecretState | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<DshInstance | null>(null);
  const [rotating, setRotating] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<DshInstance | null>(null);
  const [revoking, setRevoking] = useState(false);

  const list = useMemo(() => instances.data ?? [], [instances.data]);
  const online = list.filter((item) => item.status === 'online').length;
  const unconfigured = list.filter((item) => item.status === 'unconfigured').length;
  const offline = list.filter((item) => item.status === 'offline').length;
  const abnormal = list.filter((item) => item.status === 'error').length;
  const revoked = list.filter((item) => item.status === 'revoked').length;

  const update = <K extends keyof InstanceFormState>(key: K, value: InstanceFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const openCreate = () => {
    setFormError(null);
    setParams({ new: '1' });
  };

  const closeCreate = () => {
    setFormError(null);
    setParams({}, { replace: true });
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setFormError('请填写服务名称。');
      return;
    }
    let port: number | undefined;
    if (form.port.trim()) {
      const parsed = Number(form.port);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        setFormError('端口需为 1–65535 的整数。');
        return;
      }
      port = parsed;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await api.createInstance({
        name: form.name.trim(),
        kind: form.kind,
        host: form.host.trim() || undefined,
        port,
        baseUrl: form.baseUrl.trim() || undefined,
      });
      toast.success(`服务「${created.instance.name}」已创建`);
      setForm(EMPTY_FORM);
      setParams({}, { replace: true });
      setSecret({
        title: '服务已创建',
        instanceName: created.instance.name,
        token: created.token,
        command: created.command,
      });
      await instances.refresh();
    } catch (cause) {
      const message = errorMessage(cause, '创建服务失败');
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStart = async (instance: DshInstance) => {
    setStartingId(instance.id);
    try {
      const result = await api.startInstance(instance.id);
      toast.success(`已启动「${instance.name}」本机服务代理，等待注册`);
      if (result.logPath) toast.info(`代理日志：${result.logPath}`);
      await instances.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '启动服务代理失败'));
    } finally {
      setStartingId(null);
    }
  };

  const handleTest = async (instance: DshInstance) => {
    setTestingId(instance.id);
    try {
      const result = await api.testInstance(instance.id);
      const heartbeat =
        result.latencyMs != null
          ? fmtRelative(new Date(Date.now() - Math.max(0, result.latencyMs)).toISOString())
          : null;
      const detail = heartbeat ? `（最近心跳 ${heartbeat}）` : '';
      if (result.ok) toast.success(`${result.message}${detail}`);
      else toast.warning(`${result.message}${detail}`);
      await instances.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '测试连接失败'));
    } finally {
      setTestingId(null);
    }
  };

  const handleRotate = async () => {
    if (!rotateTarget) return;
    setRotating(true);
    try {
      const result = await api.rotateInstanceToken(rotateTarget.id);
      toast.success(`服务「${rotateTarget.name}」的 token 已轮换`);
      setSecret({
        title: 'Token 已轮换',
        instanceName: rotateTarget.name,
        token: result.token,
        command: result.command,
      });
      setRotateTarget(null);
      await instances.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '轮换 token 失败'));
    } finally {
      setRotating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api.revokeInstance(revokeTarget.id);
      toast.success(`服务「${revokeTarget.name}」已吊销`);
      setRevokeTarget(null);
      await instances.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '吊销服务失败'));
    } finally {
      setRevoking(false);
    }
  };

  const kindOptions = INSTANCE_KINDS.map((item) => ({ value: item.value, label: item.label }));

  return (
    <div className="page">
      <PageHead
        eyebrow="服务 · DSH Services"
        title="DSH 服务"
        desc="服务是 Aiwo 的执行资源：本机或远端 DSH 通过服务代理接入，领取任务并回传执行过程。"
        actions={
          <>
            <IconButton icon="refresh" label="刷新服务" onClick={() => void instances.refresh()} />
            {isAdmin ? (
              <Button variant="primary" icon="plus" onClick={openCreate}>
                新增服务
              </Button>
            ) : null}
          </>
        }
      />

      {!isAdmin ? (
        <Callout tone="amber" icon="shield">
          当前账号不是组织管理员：可以查看服务状态，但新增、测试、轮换 token 与吊销需要管理员权限。
        </Callout>
      ) : null}

      <div className="kpi-grid">
        <Stat label="在线服务" value={online} icon="server" tone="green" hint="心跳正常，可领取任务" />
        <Stat label="待接入" value={unconfigured} icon="package" tone="amber" hint="已创建，等待安装通讯插件" />
        <Stat label="离线 / 异常" value={offline + abnormal} icon="alert" tone="red" hint={`离线 ${offline} · 异常 ${abnormal}`} />
        <Stat label="服务总数" value={list.length} icon="layers" tone="violet" hint={`${revoked} 个已吊销`} />
      </div>

      {instances.error && !instances.data ? (
        <ErrorState message={instances.error} onRetry={() => void instances.refresh()} />
      ) : instances.loading && !instances.data ? (
        <div className="grid-cards">
          {[0, 1, 2].map((item) => (
            <Card className="card-pad" key={item}>
              <Skeleton h={22} />
              <div style={{ height: 12 }} />
              <Skeleton h={12} />
              <div style={{ height: 8 }} />
              <Skeleton h={48} />
              <div style={{ height: 12 }} />
              <Skeleton h={30} />
            </Card>
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon="server"
            title="还没有 DSH 服务"
            description="新增本机或远端服务，复制安装命令启动服务代理；任务会由在线服务领取执行。"
            action={
              isAdmin ? (
                <Button variant="primary" icon="plus" onClick={openCreate}>
                  新增服务
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid-cards">
          {list.map((instance) => {
            const status = instanceStatusMeta(instance.status);
            const kind = instanceKindMeta(instance.kind);
            const disabled = instance.status === 'revoked';
            return (
              <Card
                className="card-pad"
                key={instance.id}
                style={disabled ? { opacity: 0.68 } : undefined}
              >
                <div className="hstack gap-10" style={{ alignItems: 'flex-start' }}>
                  <span className={`cx-metric-icon tone-${status.tone}`}>
                    <Icon name="server" size={15} />
                  </span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="strong truncate">{instance.name}</div>
                    <div className="tiny dim mono truncate" title={instance.id}>
                      {truncateMiddle(instance.id, 14, 6)}
                    </div>
                    <div className="badge-dot-list" style={{ marginTop: 6 }}>
                      <Badge size="sm" tone={kind.tone as Tone}>
                        {kind.label}
                      </Badge>
                      <Badge size="sm" tone={status.tone as Tone} dot>
                        {status.label}
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="hstack gap-6 wrap" style={{ marginTop: 10 }}>
                  <span className="chip mono">{hostLabel(instance)}</span>
                </div>
                <div className="badge-dot-list" style={{ marginTop: 8 }}>
                  <span className="chip">共享调度池</span>
                  <span className="tiny dim">工作目录由任务所属项目决定</span>
                </div>

                <div className="metric-grid" style={{ marginTop: 12 }}>
                  <div className="metric">
                    <span className="metric-label">最后心跳</span>
                    <span className="metric-value">
                      {instance.lastSeenAt ? fmtRelative(instance.lastSeenAt) : '从未'}
                    </span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">插件版本</span>
                    <span className="metric-value mono">{instance.pluginVersion || '—'}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">服务 token</span>
                    <span className="metric-value">{instance.hasToken ? '已签发' : '未签发'}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">当前任务</span>
                    <span className="metric-value truncate" title={instance.currentTask?.title ?? '空闲'}>
                      {instance.currentTask?.title ?? '空闲'}
                    </span>
                  </div>
                </div>

                {instance.currentTask ? (
                  <div className="tiny dim" style={{ marginTop: 4 }}>
                    正在执行 · {instance.currentTask.projectName}
                  </div>
                ) : null}

                {isAdmin && !disabled ? (
                  <div
                    className="row-between"
                    style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-faint)' }}
                  >
                    <div className="hstack gap-4">
                      {instance.kind === 'local' && instance.status !== 'online' ? (
                        <Button
                          size="sm"
                          variant="primary"
                          icon="play"
                          loading={startingId === instance.id}
                          onClick={() => void handleStart(instance)}
                        >
                          启动本机代理
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        icon="activity"
                        loading={testingId === instance.id}
                        onClick={() => void handleTest(instance)}
                      >
                        测试连接
                      </Button>
                    </div>
                    <div className="hstack gap-4">
                      <Button size="sm" variant="ghost" icon="key" onClick={() => setRotateTarget(instance)}>
                        轮换 token
                      </Button>
                      <IconButton
                        icon="trash"
                        label={`吊销服务 ${instance.name}`}
                        size="sm"
                        onClick={() => setRevokeTarget(instance)}
                      />
                    </div>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <Card className="card-pad">
        <SectionHead
          title="如何接入 DSH 服务"
          desc="服务只登记连接信息，不绑定项目或工作目录；注册后进入共享调度池，从项目任务队列领取任务。"
        />
        <ol className="cx-guide-steps" style={{ marginTop: 10 }}>
          <li>
            <span className="cx-guide-step__num">1</span>
            <div>新增服务，选择本机 / 远端，填写 host、端口等连接信息。</div>
          </li>
          <li>
            <span className="cx-guide-step__num">2</span>
            <div>本机服务可直接点「启动本机代理」；远端服务复制一次性安装命令在目标机器执行；token 只展示一次。</div>
          </li>
          <li>
            <span className="cx-guide-step__num">3</span>
            <div>启动后服务会自动注册与心跳，状态从「待接入」变为「在线」，加入调度池。</div>
          </li>
          <li>
            <span className="cx-guide-step__num">4</span>
            <div>在服务卡片上点击「测试连接」确认心跳，然后即可在任意项目中派发任务。</div>
          </li>
        </ol>
        <CodeBlock
          title="安装命令模板"
          code={`node integrations/aiwo-instance/agent.mjs --base http://127.0.0.1:4500 --token aiwo_ins_...`}
        />
      </Card>

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="新增 DSH 服务"
        description="创建后会返回一次性 token 与安装命令，用于在目标机器接入服务代理。"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate}>
              取消
            </Button>
            <Button variant="primary" type="submit" form="create-instance-form" loading={submitting} icon="plus">
              创建服务
            </Button>
          </>
        }
      >
        <form id="create-instance-form" className="stack" style={{ gap: 14 }} onSubmit={handleCreate}>
          <div className="grid grid-2">
            <Field label="服务名称" htmlFor="instance-name" required>
              <Input
                id="instance-name"
                value={form.name}
                autoFocus
                placeholder="例如：本机 DSH 服务"
                onChange={(event) => update('name', event.target.value)}
              />
            </Field>
            <Field label="类型" htmlFor="instance-kind" hint="本机由 Aiwo 拉起代理；远端需安装通讯插件。">
              <Select
                id="instance-kind"
                value={form.kind}
                options={kindOptions}
                onChange={(event) => update('kind', event.target.value as InstanceKind)}
              />
            </Field>
          </div>

          <div className="grid grid-3">
            <Field label="Host" htmlFor="instance-host" hint="可为 IP 或主机名。">
              <Input
                id="instance-host"
                value={form.host}
                placeholder="127.0.0.1"
                onChange={(event) => update('host', event.target.value)}
              />
            </Field>
            <Field label="Port" htmlFor="instance-port">
              <Input
                id="instance-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                placeholder="4501"
                onChange={(event) => update('port', event.target.value)}
              />
            </Field>
            <Field label="Base URL（可选）" htmlFor="instance-base-url" hint="如需通过反向代理访问。">
              <Input
                id="instance-base-url"
                value={form.baseUrl}
                placeholder="http://host:4501"
                onChange={(event) => update('baseUrl', event.target.value)}
              />
            </Field>
          </div>

          {formError ? (
            <Callout tone="red" icon="xCircle">
              {formError}
            </Callout>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={Boolean(secret)}
        onClose={() => setSecret(null)}
        title={secret?.title ?? '服务凭据'}
        description="凭据只展示一次，关闭后无法再次查看。"
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            我已保存
          </Button>
        }
      >
        {secret ? (
          <div className="stack" style={{ gap: 12 }}>
            <Callout tone="amber" icon="alert">
              <strong>token 只显示一次。</strong>请立即复制保存；如遗失，可在服务卡片上轮换 token。
            </Callout>
            <div className="hstack gap-8 wrap">
              <span className="metric-label">服务</span>
              <span className="strong">{secret.instanceName}</span>
            </div>
            <CodeBlock title="一次性 token" code={secret.token} language="text" />
            <CodeBlock title="安装命令" code={secret.command} />
            <div className="tiny dim">
              在目标机器执行安装命令即可启动服务代理；服务会注册、心跳并领取项目任务队列中的任务。
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(rotateTarget)}
        onClose={() => setRotateTarget(null)}
        onConfirm={() => void handleRotate()}
        loading={rotating}
        title="轮换服务 token"
        description={
          rotateTarget
            ? `轮换「${rotateTarget.name}」的 token 后，旧 token 立即失效，已运行的代理需要重新配置。`
            : undefined
        }
        confirmLabel="轮换 token"
      />

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => void handleRevoke()}
        loading={revoking}
        title="吊销服务"
        description={
          revokeTarget
            ? `吊销「${revokeTarget.name}」后，该服务会立即离线且无法再领取任务。`
            : undefined
        }
        confirmLabel="吊销服务"
      />
    </div>
  );
}
