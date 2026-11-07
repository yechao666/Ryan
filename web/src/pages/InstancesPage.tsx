import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
  Pagination,
  PageHead,
  SectionHead,
  SearchInput,
  Select,
  Skeleton,
  Table,
  useToast,
  type Column,
  type Tone,
} from '@ui';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime, fmtRelative, truncateMiddle } from '../lib/format.ts';
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
  const settings = useAsync(() => api.settings(), []);
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [editTarget, setEditTarget] = useState<DshInstance | null>(null);
  const [editForm, setEditForm] = useState<InstanceFormState>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const list = useMemo(() => instances.data ?? [], [instances.data]);
  const filteredList = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return list.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      if (!needle) return true;
      return `${item.name} ${item.id} ${item.host} ${item.baseUrl ?? ''}`.toLowerCase().includes(needle);
    });
  }, [list, search, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredList.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedList = useMemo(
    () => filteredList.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filteredList, currentPage, pageSize],
  );
  useEffect(() => { setPage(1); }, [search, statusFilter, pageSize]);
  const defaultServiceId = settings.data?.defaultServiceId ?? '';
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

  const openEdit = (instance: DshInstance) => {
    setEditTarget(instance);
    setEditError(null);
    setEditForm({
      name: instance.name,
      kind: instance.kind,
      host: instance.host,
      port: instance.port ? String(instance.port) : '',
      baseUrl: instance.baseUrl ?? '',
    });
  };

  const updateEdit = <K extends keyof InstanceFormState>(key: K, value: InstanceFormState[K]) => {
    setEditForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editTarget) return;
    if (!editForm.name.trim()) { setEditError('请填写服务名称。'); return; }
    let port: number | null | undefined;
    if (editForm.port.trim()) {
      const parsed = Number(editForm.port);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) { setEditError('端口需为 1–65535 的整数。'); return; }
      port = parsed;
    } else {
      port = null;
    }
    setSavingEdit(true);
    try {
      await api.updateInstance(editTarget.id, {
        name: editForm.name.trim(),
        kind: editForm.kind,
        host: editForm.host.trim(),
        port,
        baseUrl: editForm.baseUrl.trim() || null,
      });
      toast.success('服务配置已更新');
      setEditTarget(null);
      await instances.refresh();
    } catch (cause) {
      setEditError(errorMessage(cause, '更新服务失败'));
    } finally { setSavingEdit(false); }
  };

  const handleRestore = async (instance: DshInstance) => {
    try {
      const result = await api.restoreInstance(instance.id);
      toast.success(`服务「${instance.name}」已恢复，请重新配置代理 token`);
      setSecret({ title: '服务已恢复', instanceName: instance.name, token: result.token, command: result.command });
      await instances.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '恢复服务失败'));
    }
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

  const handleDefault = async (instance: DshInstance) => {
    try {
      const isDefault = defaultServiceId === instance.id;
      await api.updateDefaultService(isDefault ? null : instance.id);
      toast.success(isDefault ? `已取消默认服务：${instance.name}` : `已设为默认服务：${instance.name}`);
      await Promise.all([settings.refresh(), instances.refresh()]);
    } catch (cause) {
      toast.error(errorMessage(cause, '设置默认服务失败'));
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
      toast.success(`服务「${revokeTarget.name}」已删除`);
      setRevokeTarget(null);
      await instances.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '吊销服务失败'));
    } finally {
      setRevoking(false);
    }
  };

  const kindOptions = INSTANCE_KINDS.map((item) => ({ value: item.value, label: item.label }));

  const columns: Column<DshInstance>[] = [
    {
      key: 'name',
      header: '服务',
      render: (instance) => {
        const status = instanceStatusMeta(instance.status);
        return (
          <div className="hstack gap-8">
            <span className={`cx-metric-icon tone-${status.tone}`}><Icon name="server" size={14} /></span>
            <div className="vstack gap-2" style={{ minWidth: 0 }}>
              <span className="strong truncate">{instance.name}</span>
              <span className="tiny dim mono truncate" title={instance.id}>{truncateMiddle(instance.id, 16, 6)}</span>
            </div>
          </div>
        );
      },
    },
    {
      key: 'kind',
      header: '类型',
      width: 100,
      render: (instance) => {
        const kind = instanceKindMeta(instance.kind);
        return <Badge size="sm" tone={kind.tone as Tone}>{kind.label}</Badge>;
      },
    },
    {
      key: 'host',
      header: '地址',
      width: 180,
      render: (instance) => <span className="tiny mono">{hostLabel(instance)}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 120,
      render: (instance) => {
        const status = instanceStatusMeta(instance.status);
        return <Badge size="sm" tone={status.tone as Tone} dot>{status.label}</Badge>;
      },
      sortValue: (instance) => instance.status,
    },
    {
      key: 'currentTask',
      header: '当前任务',
      width: 170,
      render: (instance) => instance.currentTask ? (
        <div className="vstack gap-2" style={{ minWidth: 0 }}>
          <span className="truncate small">{instance.currentTask.title}</span>
          <span className="tiny dim truncate">{instance.currentTask.projectName}</span>
        </div>
      ) : <span className="tiny dim">空闲</span>,
    },
    {
      key: 'lastSeenAt',
      header: '最后心跳',
      width: 105,
      render: (instance) => (
        <span className="tiny dim" title={instance.lastSeenAt ? fmtDateTime(instance.lastSeenAt) : '从未'}>
          {instance.lastSeenAt ? fmtRelative(instance.lastSeenAt) : '从未'}
        </span>
      ),
      sortValue: (instance) => (instance.lastSeenAt ? Date.parse(instance.lastSeenAt) : 0),
    },
    {
      key: 'default',
      header: '默认',
      width: 70,
      render: (instance) => defaultServiceId === instance.id ? <Badge size="sm" tone="green">默认</Badge> : <span className="tiny dim">—</span>,
    },
    {
      key: 'actions',
      header: '操作',
      width: 210,
      align: 'right',
      render: (instance) => {
        if (!isAdmin) return <span className="tiny dim">只读</span>;
        if (instance.status === 'revoked') {
          return <Button size="sm" variant="outline" icon="refresh" onClick={() => void handleRestore(instance)}>恢复</Button>;
        }
        return (
          <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }}>
            {instance.kind === 'local' && instance.status !== 'online' ? (
              <IconButton icon="play" label="启动本机代理" size="sm" disabled={startingId === instance.id} onClick={() => void handleStart(instance)} />
            ) : null}
            <IconButton icon="activity" label="测试连接" size="sm" disabled={testingId === instance.id} onClick={() => void handleTest(instance)} />
            <IconButton icon="settings" label="编辑服务" size="sm" onClick={() => openEdit(instance)} />
            <IconButton icon="key" label="轮换 token" size="sm" onClick={() => setRotateTarget(instance)} />
            <IconButton
              icon="star"
              label={defaultServiceId === instance.id ? '取消默认服务' : '设为默认服务'}
              size="sm"
              onClick={() => void handleDefault(instance)}
            />
            <IconButton icon="trash" label="删除服务" size="sm" onClick={() => setRevokeTarget(instance)} />
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="服务 · DSH Services"
        title="DSH 服务"
        desc={
          <>
            服务是 Aiwo 的执行资源：本机或远端 DSH 通过服务代理接入，领取任务并回传执行过程。
            <button type="button" className="ws-inline-link" onClick={() => setGuideOpen(true)}>
              如何接入 DSH 服务？
            </button>
          </>
        }
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

      <Card className="service-summary-strip">
        <div className="service-summary-label">
          <Icon name="activity" size={14} />
          服务概览
        </div>
        <div className="service-summary-items">
          <div className="service-summary-item">
            <span className="cx-metric-icon tone-green"><Icon name="server" size={14} /></span>
            <div><strong>{online}</strong><span>在线服务</span><em>心跳正常，可领取任务</em></div>
          </div>
          <div className="service-summary-item">
            <span className="cx-metric-icon tone-amber"><Icon name="package" size={14} /></span>
            <div><strong>{unconfigured}</strong><span>待接入</span><em>等待安装通讯插件</em></div>
          </div>
          <div className="service-summary-item">
            <span className="cx-metric-icon tone-red"><Icon name="alert" size={14} /></span>
            <div><strong>{offline + abnormal}</strong><span>离线 / 异常</span><em>离线 {offline} · 异常 {abnormal}</em></div>
          </div>
          <div className="service-summary-item">
            <span className="cx-metric-icon tone-violet"><Icon name="layers" size={14} /></span>
            <div><strong>{list.length}</strong><span>服务总数</span><em>{revoked} 个已吊销</em></div>
          </div>
        </div>
      </Card>

      <div className="toolbar">
        <div className="toolbar-left">
          <Select
            className="ws-filter-select"
            value={statusFilter}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'online', label: '在线' },
              { value: 'unconfigured', label: '待接入' },
              { value: 'offline', label: '离线' },
              { value: 'error', label: '异常' },
              { value: 'revoked', label: '已删除' },
            ]}
            onChange={(event) => setStatusFilter(event.target.value)}
          />
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="搜索名称 / ID / Host"
            className="ws-search"
          />
          <span className="tiny dim">共 {filteredList.length} 个服务</span>
        </div>
        {search || statusFilter !== 'all' ? (
          <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setStatusFilter('all'); }}>清除筛选</Button>
        ) : null}
      </div>

      {instances.error && !instances.data ? (
        <Card><div style={{ padding: 18 }}><ErrorState message={instances.error} onRetry={() => void instances.refresh()} /></div></Card>
      ) : (
        <Card>
          <Table
            columns={columns}
            rows={pagedList}
            rowKey={(instance) => instance.id}
            sortable
            resizable
            loading={instances.loading && !instances.data}
            empty={
              filteredList.length === 0 && list.length > 0 ? (
                <EmptyState icon="filter" title="没有匹配的服务" description="调整搜索或状态筛选。" compact />
              ) : (
                <EmptyState
                  icon="server"
                  title="还没有 DSH 服务"
                  description="新增本机或远端服务，复制安装命令启动服务代理。"
                  action={isAdmin ? <Button size="sm" variant="primary" icon="plus" onClick={openCreate}>新增服务</Button> : undefined}
                />
              )
            }
          />
          {!instances.loading && filteredList.length > 0 ? (
            <div className="ws-table-foot">
              <Pagination
                page={currentPage}
                totalPages={totalPages}
                total={filteredList.length}
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
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        title="如何接入 DSH 服务"
        description="服务只登记连接信息，不绑定项目或工作目录；注册后进入共享调度池。"
        size="lg"
        footer={<Button variant="primary" onClick={() => setGuideOpen(false)}>知道了</Button>}
      >
        <ol className="cx-guide-steps" style={{ marginTop: 4 }}>
          <li><span className="cx-guide-step__num">1</span><div>新增服务，选择本机 / 远端，填写 host、端口等连接信息。</div></li>
          <li><span className="cx-guide-step__num">2</span><div>本机服务可直接点「启动本机代理」；远端服务复制一次性安装命令在目标机器执行；token 只展示一次。</div></li>
          <li><span className="cx-guide-step__num">3</span><div>启动后服务会自动注册与心跳，状态从「待接入」变为「在线」，加入调度池。</div></li>
          <li><span className="cx-guide-step__num">4</span><div>在服务行点击「测试连接」确认心跳，然后即可在任意项目中派发任务。</div></li>
        </ol>
        <div className="mt-12">
          <CodeBlock
            title="安装命令模板"
            code={`node integrations/aiwo-instance/agent.mjs --base http://127.0.0.1:4500 --token aiwo_ins_...`}
          />
        </div>
      </Modal>

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
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        title="编辑 DSH 服务"
        description="修改服务名称、类型与连接信息；不会改变 token 和当前在线状态。"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>取消</Button>
            <Button variant="primary" type="submit" form="edit-instance-form" loading={savingEdit} icon="check">保存修改</Button>
          </>
        }
      >
        <form id="edit-instance-form" className="stack" style={{ gap: 14 }} onSubmit={handleEdit}>
          <div className="grid grid-2">
            <Field label="服务名称" required>
              <Input value={editForm.name} autoFocus onChange={(event) => updateEdit('name', event.target.value)} />
            </Field>
            <Field label="类型" hint="本机由 Aiwo 拉起代理；远端需安装通讯插件。">
              <Select value={editForm.kind} options={kindOptions} onChange={(event) => updateEdit('kind', event.target.value as InstanceKind)} />
            </Field>
          </div>
          <div className="grid grid-3">
            <Field label="Host"><Input value={editForm.host} placeholder="127.0.0.1" onChange={(event) => updateEdit('host', event.target.value)} /></Field>
            <Field label="Port"><Input type="number" min={1} max={65535} value={editForm.port} onChange={(event) => updateEdit('port', event.target.value)} /></Field>
            <Field label="Base URL（可选）"><Input value={editForm.baseUrl} placeholder="http://host:4501" onChange={(event) => updateEdit('baseUrl', event.target.value)} /></Field>
          </div>
          {editError ? <Callout tone="red" icon="xCircle">{editError}</Callout> : null}
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
        title="删除 DSH 服务"
        description={
          revokeTarget
            ? `删除「${revokeTarget.name}」后，该服务会立即离线且无法再领取任务；可在“已删除”筛选中恢复。`
            : undefined
        }
        confirmLabel="删除服务"
      />
    </div>
  );
}
