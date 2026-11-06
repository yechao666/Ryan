import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AgentToken, AgentTokenWithSecret, Instance, ProjectAgent } from '@shared';
import { PROJECT_ROLES } from '@shared';
import {
  Avatar,
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
  Skeleton,
  Table,
  Tabs,
  useToast,
  type Column,
} from '@ui';
import { api, type AgentDetail } from '../lib/api.ts';
import { fmtDate, fmtRelative, maskKey, truncateMiddle } from '../lib/format.ts';
import { apiErrorMessage, errorText, toneFor, useResource } from '../components/projects/helpers.tsx';
import { AgentStatusBadge, CapabilityChips } from '../components/agents/index.tsx';
import { InstanceStatus } from '../components/instances/index.tsx';

type AgentTab = 'projects' | 'tokens' | 'instances';

/** 智员详情：项目绑定、访问令牌（一次性 secret）与实例。 */
export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const toast = useToast();
  const { data, loading, error, status, reload } = useResource<AgentDetail>(
    () => api.agent(agentId ?? ''),
    [agentId],
    Boolean(agentId),
  );

  const [tab, setTab] = useState<AgentTab>('projects');
  const [bindingTarget, setBindingTarget] = useState<ProjectAgent | null>(null);
  const [unbinding, setUnbinding] = useState(false);
  const [tokenTarget, setTokenTarget] = useState<AgentToken | null>(null);
  const [revokingToken, setRevokingToken] = useState(false);
  const [instanceTarget, setInstanceTarget] = useState<Instance | null>(null);
  const [revokingInstance, setRevokingInstance] = useState(false);
  const [createTokenOpen, setCreateTokenOpen] = useState(false);
  const [tokenLabel, setTokenLabel] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [secretToken, setSecretToken] = useState<AgentTokenWithSecret | null>(null);

  const agent = data?.agent;
  const projects = data?.projects ?? [];
  const tokens = data?.tokens ?? [];
  const instances = data?.instances ?? [];

  const openCreateToken = () => {
    setTokenLabel('');
    setTokenError(null);
    setCreateTokenOpen(true);
  };

  const handleCreateToken = async () => {
    if (!agent) return;
    setCreatingToken(true);
    setTokenError(null);
    try {
      const created = await api.createAgentToken(agent.id, tokenLabel.trim() || '默认令牌');
      setCreateTokenOpen(false);
      setSecretToken(created);
      toast.success('访问令牌已创建，请立即保存 secret');
      await reload();
    } catch (cause) {
      const message = apiErrorMessage(cause, '创建访问令牌失败');
      setTokenError(message);
      toast.error(message);
    } finally {
      setCreatingToken(false);
    }
  };

  const handleUnbind = async () => {
    if (!agent || !bindingTarget) return;
    setUnbinding(true);
    try {
      await api.unbindAgent(bindingTarget.projectId, agent.id);
      toast.success('已解除项目绑定');
      setBindingTarget(null);
      await reload();
    } catch (cause) {
      toast.error(apiErrorMessage(cause, '解除绑定失败'));
    } finally {
      setUnbinding(false);
    }
  };

  const handleRevokeToken = async () => {
    if (!agent || !tokenTarget) return;
    setRevokingToken(true);
    try {
      await api.revokeAgentToken(agent.id, tokenTarget.id);
      toast.success(`令牌「${tokenTarget.label}」已吊销`);
      setTokenTarget(null);
      await reload();
    } catch (cause) {
      toast.error(apiErrorMessage(cause, '吊销令牌失败'));
    } finally {
      setRevokingToken(false);
    }
  };

  const handleRevokeInstance = async () => {
    if (!instanceTarget) return;
    setRevokingInstance(true);
    try {
      await api.revokeInstance(instanceTarget.id);
      toast.success(`实例「${instanceTarget.name}」已吊销`);
      setInstanceTarget(null);
      await reload();
    } catch (cause) {
      toast.error(apiErrorMessage(cause, '吊销实例失败'));
    } finally {
      setRevokingInstance(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="page">
        <Skeleton w="26%" h={26} />
        <Skeleton w="52%" h={14} />
        <div className="card card-pad">
          <Skeleton h={72} />
        </div>
        <div className="card card-pad">
          <Skeleton w="30%" h={14} />
          <div style={{ height: 14 }} />
          <Skeleton h={160} />
        </div>
      </div>
    );
  }

  if (status === 404) {
    return (
      <div className="page">
        <EmptyState
          icon="bot"
          title="智员不存在"
          description="该智员可能已被删除，或你没有访问权限。"
          action={
            <Link to="/agents" className="btn btn-secondary btn-sm">
              返回智员列表
            </Link>
          }
        />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="page">
        <ErrorState message={errorText(status, error, '智员')} onRetry={() => void reload()} />
      </div>
    );
  }

  const projectColumns: Column<ProjectAgent>[] = [
    {
      key: 'project',
      header: '项目',
      render: (binding) => (
        <Link to={`/projects/${binding.projectId}`} className="hstack gap-6 cx-table-link">
          <Icon name="folder" size={13} />
          <span className="mono truncate">{truncateMiddle(binding.projectId, 14, 6)}</span>
        </Link>
      ),
    },
    {
      key: 'memoryAgentId',
      header: '记忆身份',
      mono: true,
      render: (binding) => (
        <span className="mono truncate" title={binding.memoryAgentId}>
          {truncateMiddle(binding.memoryAgentId, 16, 6)}
        </span>
      ),
    },
    {
      key: 'role',
      header: '项目角色',
      width: 120,
      render: (binding) => <span className="small muted">{projectRoleLabel(binding.role)}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 100,
      render: (binding) => (
        <Badge size="sm" tone={binding.status === 'active' ? 'green' : 'amber'} dot>
          {binding.status === 'active' ? '生效中' : '已暂停'}
        </Badge>
      ),
    },
    {
      key: 'instances',
      header: '在线实例',
      width: 90,
      align: 'center',
      mono: true,
      render: (binding) => binding.onlineInstances,
    },
    {
      key: 'addedAt',
      header: '加入时间',
      width: 110,
      mono: true,
      render: (binding) => fmtDate(binding.addedAt),
    },
    {
      key: 'actions',
      header: '',
      width: 64,
      align: 'right',
      render: (binding) => (
        <span className="cx-row-actions">
          <IconButton
            icon="trash"
            label="解除绑定"
            size="sm"
            onClick={() => setBindingTarget(binding)}
          />
        </span>
      ),
    },
  ];

  const tokenColumns: Column<AgentToken>[] = [
    {
      key: 'label',
      header: '标签',
      render: (token) => <span className="cell-strong">{token.label}</span>,
    },
    {
      key: 'prefix',
      header: 'Prefix',
      mono: true,
      render: (token) => <span className="mono">{maskKey(token.prefix)}</span>,
    },
    {
      key: 'createdAt',
      header: '创建时间',
      width: 120,
      mono: true,
      render: (token) => fmtDate(token.createdAt),
    },
    {
      key: 'lastUsedAt',
      header: '最近使用',
      width: 130,
      render: (token) => (token.lastUsedAt ? fmtRelative(token.lastUsedAt) : <span className="dim">从未</span>),
    },
    {
      key: 'status',
      header: '状态',
      width: 100,
      render: (token) => (
        <Badge size="sm" tone={token.revokedAt ? 'red' : 'green'} dot>
          {token.revokedAt ? '已吊销' : '有效'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 64,
      align: 'right',
      render: (token) =>
        token.revokedAt ? null : (
          <span className="cx-row-actions">
            <IconButton icon="trash" label="吊销令牌" size="sm" onClick={() => setTokenTarget(token)} />
          </span>
        ),
    },
  ];

  const instanceColumns: Column<Instance>[] = [
    {
      key: 'name',
      header: '实例',
      render: (instance) => (
        <div>
          <div className="cell-strong truncate">{instance.name}</div>
          <div className="tiny dim mono truncate">{truncateMiddle(instance.id, 12, 6)}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 100,
      render: (instance) => <InstanceStatus status={instance.status} />,
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
      key: 'lastSeenAt',
      header: '最近心跳',
      width: 120,
      render: (instance) => (instance.lastSeenAt ? fmtRelative(instance.lastSeenAt) : <span className="dim">从未</span>),
    },
    {
      key: 'actions',
      header: '',
      width: 64,
      align: 'right',
      render: (instance) =>
        instance.status === 'revoked' ? null : (
          <span className="cx-row-actions">
            <IconButton icon="trash" label="吊销实例" size="sm" onClick={() => setInstanceTarget(instance)} />
          </span>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow={
          <Link to="/agents" className="cx-crumb-link">
            ← 智员
          </Link>
        }
        title={agent.name}
        desc={agent.description || '暂无智员描述'}
        actions={
          <>
            <Link to="/agents" className="btn btn-ghost btn-sm">
              返回列表
            </Link>
            <Button variant="primary" icon="key" onClick={openCreateToken}>
              创建令牌
            </Button>
          </>
        }
      />

      <Card pad className="cx-agent-hero">
        <div className="cx-agent-hero__top">
          <Avatar name={agent.name} tone={toneFor(agent.id || agent.name)} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="hstack wrap gap-8">
              <AgentStatusBadge status={agent.status} />
              <span className="pill">
                <Icon name="cpu" size={13} />
                <span className="mono">{agent.model}</span>
              </span>
              <span className="tiny dim">所有者 {agent.ownerName}</span>
              <span className="tiny dim">创建于 {fmtDate(agent.createdAt)}</span>
            </div>
            <div className="cx-cap-row" style={{ marginTop: 10 }}>
              <CapabilityChips capabilities={agent.capabilities} max={20} />
            </div>
          </div>
        </div>

        <div className="cx-meta-grid">
          <div className="metric">
            <span className="metric-label">绑定项目</span>
            <span className="metric-value">{agent.stats.projects}</span>
          </div>
          <div className="metric">
            <span className="metric-label">运行任务</span>
            <span className="metric-value">{agent.stats.runningTasks}</span>
          </div>
          <div className="metric">
            <span className="metric-label">排队任务</span>
            <span className="metric-value">{agent.stats.queuedTasks}</span>
          </div>
          <div className="metric">
            <span className="metric-label">在线实例</span>
            <span className="metric-value">{agent.stats.onlineInstances}</span>
          </div>
        </div>
      </Card>

      <Tabs
        value={tab}
        onChange={(key) => setTab(key as AgentTab)}
        tabs={[
          { key: 'projects', label: '项目绑定', count: projects.length },
          { key: 'tokens', label: '访问令牌', count: tokens.length },
          { key: 'instances', label: '实例', count: instances.length },
        ]}
      />

      {tab === 'projects' ? (
        <Card>
          <div className="card-head">
            <div>
              <div className="card-title">
                <Icon name="link" size={15} />
                项目绑定
              </div>
              <div className="card-sub">每个项目拥有独立的记忆身份，避免跨项目记忆串味。</div>
            </div>
            <Link to="/projects" className="btn btn-ghost btn-sm">
              前往项目
            </Link>
          </div>
          <Table
            columns={projectColumns}
            rows={projects}
            rowKey={(binding) => binding.id}
            empty={
              <EmptyState
                compact
                icon="link"
                title="还没有项目绑定"
                description="在项目工作区把该智员加入项目，即可绑定项目记忆身份。"
                action={
                  <Link to="/projects" className="btn btn-secondary btn-sm">
                    选择项目
                  </Link>
                }
              />
            }
          />
        </Card>
      ) : null}

      {tab === 'tokens' ? (
        <Card>
          <div className="card-head">
            <div>
              <div className="card-title">
                <Icon name="key" size={15} />
                访问令牌
              </div>
              <div className="card-sub">用于注册 DSH 实例；secret 只在创建时显示一次。</div>
            </div>
            <Button size="sm" icon="plus" onClick={openCreateToken}>
              创建令牌
            </Button>
          </div>
          <Table
            columns={tokenColumns}
            rows={tokens}
            rowKey={(token) => token.id}
            empty={
              <EmptyState
                compact
                icon="key"
                title="还没有访问令牌"
                description="创建 Agent 令牌后，就可以在各台机器上注册 DSH 实例。"
                action={
                  <Button size="sm" icon="plus" onClick={openCreateToken}>
                    创建令牌
                  </Button>
                }
              />
            }
          />
        </Card>
      ) : null}

      {tab === 'instances' ? (
        <Card>
          <div className="card-head">
            <div>
              <div className="card-title">
                <Icon name="server" size={15} />
                实例
              </div>
              <div className="card-sub">该智员注册的 DSH 运行时；离线实例会在心跳超时后标记。</div>
            </div>
            <Link to="/instances" className="btn btn-ghost btn-sm">
              全部实例
            </Link>
          </div>
          <Table
            columns={instanceColumns}
            rows={instances}
            rowKey={(instance) => instance.id}
            empty={
              <EmptyState
                compact
                icon="server"
                title="还没有实例"
                description="使用上方创建的 Agent 令牌注册实例后，任务才会被领取执行。"
              />
            }
          />
        </Card>
      ) : null}

      <Modal
        open={createTokenOpen}
        onClose={() => setCreateTokenOpen(false)}
        title="创建访问令牌"
        description="令牌用于注册 DSH 实例，secret 只显示一次。"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateTokenOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={creatingToken} onClick={() => void handleCreateToken()} icon="key">
              创建令牌
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <Field label="令牌标签" htmlFor="token-label" required hint="例如：开发机、CI 或某台实例。">
            <Input
              id="token-label"
              value={tokenLabel}
              autoFocus
              placeholder="开发机"
              onChange={(event) => setTokenLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleCreateToken();
                }
              }}
            />
          </Field>
          <Callout tone="violet" icon="info">
            创建后完整 secret 只显示一次，请立即复制并保存。
          </Callout>
          {tokenError ? (
            <Callout tone="red" icon="xCircle">
              {tokenError}
            </Callout>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={Boolean(secretToken)}
        onClose={() => setSecretToken(null)}
        title="访问令牌已创建"
        description="这是唯一一次显示完整 secret。"
        footer={
          <Button variant="primary" onClick={() => setSecretToken(null)}>
            我已保存
          </Button>
        }
      >
        {secretToken ? (
          <div className="stack" style={{ gap: 12 }}>
            <Callout tone="amber" icon="alert">
              <strong>密钥只显示一次。</strong>关闭后无法再次查看，请立即复制并妥善保存。
            </Callout>
            <div className="cx-token-meta">
              <span className="metric-label">标签</span>
              <span className="strong">{secretToken.label}</span>
              <span className="metric-label">Prefix</span>
              <span className="mono">{secretToken.prefix}</span>
            </div>
            <CodeBlock title="Agent 令牌 secret" code={secretToken.secret} />
            <div className="tiny dim">在实例注册接口中作为 Authorization: Bearer 令牌使用。</div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(bindingTarget)}
        onClose={() => setBindingTarget(null)}
        onConfirm={() => void handleUnbind()}
        loading={unbinding}
        title="解除项目绑定"
        description={
          bindingTarget
            ? `确定将智员从项目 ${truncateMiddle(bindingTarget.projectId, 14, 6)} 移除？智员将不再接收该项目的任务。`
            : undefined
        }
        confirmLabel="解除绑定"
      />

      <ConfirmDialog
        open={Boolean(tokenTarget)}
        onClose={() => setTokenTarget(null)}
        onConfirm={() => void handleRevokeToken()}
        loading={revokingToken}
        title="吊销访问令牌"
        description={tokenTarget ? `吊销「${tokenTarget.label}」后，使用该令牌的实例将无法再注册或心跳。` : undefined}
        confirmLabel="吊销令牌"
      />

      <ConfirmDialog
        open={Boolean(instanceTarget)}
        onClose={() => setInstanceTarget(null)}
        onConfirm={() => void handleRevokeInstance()}
        loading={revokingInstance}
        title="吊销实例"
        description={instanceTarget ? `吊销「${instanceTarget.name}」后，实例会立即离线且无法再领取任务。` : undefined}
        confirmLabel="吊销实例"
      />
    </div>
  );
}

/** 项目角色中文名；未知角色回退原始值。 */
function projectRoleLabel(role: string): string {
  return PROJECT_ROLES.find((item) => item.value === role)?.label ?? (role || '成员');
}
