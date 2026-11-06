import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Instance } from '@shared';
import {
  Badge,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  PageHead,
  Stat,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api } from '../lib/api.ts';
import { fmtRelative, truncateMiddle } from '../lib/format.ts';
import { apiErrorMessage, errorText, useResource } from '../components/projects/helpers.tsx';
import { InstanceRegisterGuide, InstanceStatus } from '../components/instances/index.tsx';

/** 实例列表：在线 / 离线状态、工作区与吊销操作，附注册指引。 */
export function InstancesPage() {
  const toast = useToast();
  const { data: instances, loading, error, status, reload } = useResource<Instance[]>(() => api.instances(), []);
  const [target, setTarget] = useState<Instance | null>(null);
  const [revoking, setRevoking] = useState(false);

  const list = useMemo(() => instances ?? [], [instances]);
  const online = list.filter((instance) => instance.status === 'online').length;
  const offline = list.filter((instance) => instance.status === 'offline').length;
  const revoked = list.filter((instance) => instance.status === 'revoked').length;

  const handleRevoke = async () => {
    if (!target) return;
    setRevoking(true);
    try {
      await api.revokeInstance(target.id);
      toast.success(`实例「${target.name}」已吊销`);
      setTarget(null);
      await reload();
    } catch (cause) {
      toast.error(apiErrorMessage(cause, '吊销实例失败'));
    } finally {
      setRevoking(false);
    }
  };

  const columns: Column<Instance>[] = [
    {
      key: 'name',
      header: '实例',
      render: (instance) => (
        <div>
          <div className="cell-strong truncate">{instance.name}</div>
          <div className="tiny dim mono truncate">{truncateMiddle(instance.id, 14, 6)}</div>
        </div>
      ),
    },
    {
      key: 'agentName',
      header: '智员',
      width: 150,
      render: (instance) => (
        <Link to={`/agents/${instance.agentId}`} className="cx-table-link truncate">
          {instance.agentName}
        </Link>
      ),
    },
    {
      key: 'host',
      header: '主机',
      width: 130,
      mono: true,
      render: (instance) => <span className="truncate">{instance.host}</span>,
    },
    {
      key: 'workspacePath',
      header: 'Workspace',
      mono: true,
      render: (instance) => (
        <span className="mono truncate" title={instance.workspacePath}>
          {instance.workspacePath}
        </span>
      ),
    },
    {
      key: 'version',
      header: '版本',
      width: 100,
      mono: true,
      render: (instance) => <span className="mono nowrap">{instance.version}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 100,
      render: (instance) => <InstanceStatus status={instance.status} />,
    },
    {
      key: 'lastSeenAt',
      header: '最近心跳',
      width: 120,
      render: (instance) => (instance.lastSeenAt ? fmtRelative(instance.lastSeenAt) : <span className="dim">从未</span>),
    },
    {
      key: 'currentTask',
      header: '当前任务',
      width: 180,
      render: (instance) =>
        instance.currentTask ? (
          <div style={{ minWidth: 0 }}>
            <div className="truncate">{instance.currentTask.title}</div>
            <div className="tiny dim truncate">{instance.currentTask.projectName}</div>
          </div>
        ) : (
          <span className="dim">空闲</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      width: 64,
      align: 'right',
      render: (instance) =>
        instance.status === 'revoked' ? null : (
          <span className="cx-row-actions">
            <IconButton icon="trash" label="吊销实例" size="sm" onClick={() => setTarget(instance)} />
          </span>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="实例 · Instances"
        title="实例"
        desc="实例是一台运行中的 DSH 数字员工运行时：注册后领取任务、上报进展并保持心跳。"
        actions={<IconButton icon="refresh" label="刷新实例" onClick={() => void reload()} />}
      />

      <div className="kpi-grid cx-kpi-grid-3">
        <Stat label="在线实例" value={online} icon="server" tone="green" hint="心跳正常，可领取任务" />
        <Stat label="离线实例" value={offline} icon="server" tone="slate" hint="心跳超时或未启动" />
        <Stat label="实例总数" value={list.length} icon="layers" tone="violet" hint={`${revoked} 个已吊销`} />
      </div>

      {error && !instances ? (
        <ErrorState message={errorText(status, error, '实例')} onRetry={() => void reload()} />
      ) : (
        <Card>
          <div className="card-head">
            <div>
              <div className="card-title">实例清单</div>
              <div className="card-sub">吊销后实例立即离线，需重新注册才能继续工作。</div>
            </div>
            <Link to="/agents" className="btn btn-ghost btn-sm">
              获取 Agent 令牌
            </Link>
          </div>
          <Table
            columns={columns}
            rows={list}
            rowKey={(instance) => instance.id}
            loading={loading && !instances}
            empty={
              <EmptyState
                icon="server"
                title="还没有注册实例"
                description="使用智员的 Agent 令牌运行 DSH 实例，注册后即可领取项目任务。"
                action={
                  <Link to="/agents" className="btn btn-secondary btn-sm">
                    前往智员创建令牌
                  </Link>
                }
              />
            }
          />
        </Card>
      )}

      <InstanceRegisterGuide />

      <div className="row-between">
        <span className="tiny dim">
          在线 {online} · 离线 {offline} · 已吊销 {revoked}
        </span>
        <Badge tone="slate" size="sm">
          runtime 协议
        </Badge>
      </div>

      <ConfirmDialog
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        onConfirm={() => void handleRevoke()}
        loading={revoking}
        title="吊销实例"
        description={target ? `吊销「${target.name}」后，该实例会立即离线且无法再领取任务。` : undefined}
        confirmLabel="吊销实例"
      />
    </div>
  );
}
