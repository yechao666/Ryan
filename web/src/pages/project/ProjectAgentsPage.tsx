import { useEffect, useMemo, useState } from 'react';
import type { ProjectAgent } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDate } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
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
  IconButton,
  Input,
  Modal,
  PageHead,
  Skeleton,
  Table,
  useToast,
  type Column,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';
import { toneForName } from '../../components/project/meta.ts';

/** 项目智员：查看关联智员、维护记忆标识与角色、暂停/启用或移除。 */
export function ProjectAgentsPage() {
  const { detail, reload } = useProject();
  const projectId = detail.project.id;
  const toast = useToast();

  const agents = useAsync(() => api.projectAgents(projectId), [projectId]);
  const [editTarget, setEditTarget] = useState<ProjectAgent | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editMemoryId, setEditMemoryId] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectAgent | null>(null);
  const [removing, setRemoving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [bindOpen, setBindOpen] = useState(false);
  const [bindCandidate, setBindCandidate] = useState('');
  const [bindMemoryId, setBindMemoryId] = useState('');
  const [binding, setBinding] = useState(false);

  const mine = useAsync(() => api.agents('mine'), [bindOpen], bindOpen);
  const boundIds = useMemo(
    () => new Set((agents.data ?? []).map((item) => item.agentId)),
    [agents.data],
  );
  const unbound = useMemo(
    () => (mine.data ?? []).filter((agent) => !boundIds.has(agent.id)),
    [mine.data, boundIds],
  );

  useEffect(() => {
    if (!bindOpen) return;
    setBindCandidate('');
    setBindMemoryId('');
  }, [bindOpen]);

  useEffect(() => {
    if (!bindOpen || bindCandidate) return;
    if (unbound[0]) setBindCandidate(unbound[0].id);
  }, [bindOpen, bindCandidate, unbound]);

  const openEdit = (item: ProjectAgent) => {
    setEditTarget(item);
    setEditRole(item.role ?? '');
    setEditMemoryId(item.memoryAgentId ?? '');
  };

  const handleToggle = async (item: ProjectAgent) => {
    const next = item.status === 'active' ? 'paused' : 'active';
    setTogglingId(item.agentId);
    try {
      await api.updateProjectAgent(projectId, item.agentId, { status: next });
      toast.success(next === 'paused' ? '智员已暂停' : '智员已启用');
      await agents.refresh();
      void reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '更新智员状态失败');
    } finally {
      setTogglingId(null);
    }
  };

  const handleSaveEdit = async () => {
    if (!editTarget) return;
    setSavingEdit(true);
    try {
      await api.updateProjectAgent(projectId, editTarget.agentId, {
        role: editRole.trim(),
        memoryAgentId: editMemoryId.trim(),
      });
      toast.success('智员信息已更新');
      setEditTarget(null);
      await agents.refresh();
      void reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.unbindAgent(projectId, removeTarget.agentId);
      toast.success('已从项目移除该智员');
      setRemoveTarget(null);
      await agents.refresh();
      void reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '移除失败，请重试');
    } finally {
      setRemoving(false);
    }
  };

  const handleBind = async () => {
    if (!bindCandidate) return;
    setBinding(true);
    try {
      await api.bindAgent(projectId, {
        agentId: bindCandidate,
        memoryAgentId: bindMemoryId.trim() || undefined,
      });
      toast.success('智员已关联到项目');
      setBindOpen(false);
      await agents.refresh();
      void reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '关联智员失败，请重试');
    } finally {
      setBinding(false);
    }
  };

  const columns: Column<ProjectAgent>[] = [
    {
      key: 'agent',
      header: '智员',
      render: (row) => (
        <div className="hstack gap-10">
          <Avatar name={row.agent.name} tone={toneForName(row.agent.name)} />
          <div className="vstack" style={{ gap: 1, minWidth: 0 }}>
            <span className="strong truncate">{row.agent.name}</span>
            <span className="tiny dim truncate">
              {row.agent.role || '未设置岗位'} · {row.agent.ownerName || '未知所有者'}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: 'memory',
      header: '记忆智员 ID',
      render: (row) =>
        row.memoryAgentId ? (
          <div className="hstack gap-4">
            <span className="mono tiny truncate ws-mono-cell" title={row.memoryAgentId}>
              {row.memoryAgentId}
            </span>
            <CopyButton value={row.memoryAgentId} label="复制" />
          </div>
        ) : (
          <span className="dim tiny">未设置</span>
        ),
    },
    {
      key: 'role',
      header: '角色',
      render: (row) => (row.role ? <Badge tone="slate">{row.role}</Badge> : <span className="dim">—</span>),
    },
    {
      key: 'status',
      header: '状态',
      render: (row) => (
        <Badge tone={row.status === 'active' ? 'green' : 'amber'} dot>
          {row.status === 'active' ? '启用中' : '已暂停'}
        </Badge>
      ),
    },
    {
      key: 'instances',
      header: '在线实例',
      align: 'center',
      render: (row) => (
        <span className={row.onlineInstances > 0 ? 'strong' : 'dim'}>{row.onlineInstances}</span>
      ),
    },
    {
      key: 'addedAt',
      header: '添加时间',
      render: (row) => <span className="tiny dim">{fmtDate(row.addedAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (row) => (
        <div className="hstack gap-2 row-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton
            icon={row.status === 'active' ? 'clock' : 'play'}
            label={row.status === 'active' ? '暂停智员' : '启用智员'}
            size="sm"
            disabled={togglingId === row.agentId}
            onClick={() => void handleToggle(row)}
          />
          <IconButton icon="pencil" label="编辑智员信息" size="sm" onClick={() => openEdit(row)} />
          <IconButton icon="trash" label="从项目移除" size="sm" onClick={() => setRemoveTarget(row)} />
        </div>
      ),
    },
  ];

  return (
    <div className="ws-page">
      <PageHead
        title="项目智员"
        desc="智员通过项目共享记忆与任务；记忆智员 ID 用于在 Mnemos 中定位该智员的记忆分区。"
        actions={
          <>
            <Button variant="ghost" icon="refresh" onClick={() => void agents.refresh()}>
              刷新
            </Button>
            <Button variant="primary" icon="link" onClick={() => setBindOpen(true)}>
              关联智员
            </Button>
          </>
        }
      />

      <Card>
        {agents.error && !agents.data ? (
          <div style={{ padding: 18 }}>
            <ErrorState message={agents.error} onRetry={() => void agents.refresh()} />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={agents.data ?? []}
            rowKey={(row) => row.id}
            loading={agents.loading && !agents.data}
            empty={
              <EmptyState
                icon="bot"
                title="还没有关联智员"
                description="把智员加入项目后，它们才能领取任务并写入项目记忆。"
                action={
                  <Button size="sm" variant="outline" icon="link" onClick={() => setBindOpen(true)}>
                    关联智员
                  </Button>
                }
              />
            }
          />
        )}
      </Card>

      {/* 编辑智员绑定信息 */}
      <Modal
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        title="编辑智员信息"
        description={editTarget ? `${editTarget.agent.name} · 项目 ${detail.project.name}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button variant="primary" loading={savingEdit} onClick={() => void handleSaveEdit()}>
              保存
            </Button>
          </>
        }
      >
        <Field label="记忆智员 ID" hint="对应 Mnemos 中的 agent_id，留空表示沿用默认值。">
          <Input
            value={editMemoryId}
            placeholder="例如：agent-reviewer"
            onChange={(event) => setEditMemoryId(event.target.value)}
          />
        </Field>
        <Field label="项目角色" hint="描述该智员在本项目中的职责，例如 reviewer / builder。">
          <Input
            value={editRole}
            placeholder="例如：代码审查"
            onChange={(event) => setEditRole(event.target.value)}
          />
        </Field>
      </Modal>

      {/* 关联智员 */}
      <Modal
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        title="关联智员"
        description="从你拥有的智员中选择一个加入项目。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBindOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={binding}
              disabled={!bindCandidate}
              onClick={() => void handleBind()}
            >
              关联
            </Button>
          </>
        }
      >
        <Field label="选择智员" required>
          {mine.loading && !mine.data ? (
            <div className="vstack gap-8">
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} h={46} style={{ borderRadius: 10 }} />
              ))}
            </div>
          ) : mine.error ? (
            <Callout tone="red" icon="alert">
              加载智员失败：{mine.error}
            </Callout>
          ) : unbound.length === 0 ? (
            <EmptyState
              icon="bot"
              title="没有可关联的智员"
              description="你拥有的智员都已加入本项目。可先在「智员」页创建新的智员。"
              compact
            />
          ) : (
            <div className="ws-pick-list">
              {unbound.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  className={`ws-pick-item${bindCandidate === agent.id ? ' active' : ''}`}
                  onClick={() => setBindCandidate(agent.id)}
                >
                  <Avatar name={agent.name} tone={toneForName(agent.name)} size="sm" />
                  <span className="ws-pick-main">
                    <span className="ws-pick-name truncate">{agent.name}</span>
                    <span className="tiny dim truncate">
                      {agent.role || '未设置岗位'} · {agent.model || '默认模型'}
                    </span>
                  </span>
                  {bindCandidate === agent.id ? <Icon name="check" size={15} /> : null}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="记忆智员 ID" hint="留空则由服务端自动生成。">
          <Input
            value={bindMemoryId}
            placeholder="留空自动生成"
            onChange={(event) => setBindMemoryId(event.target.value)}
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void handleRemove()}
        title="移除智员"
        description={`确认把「${removeTarget?.agent.name ?? ''}」从项目中移除？该智员将不再领取此项目的任务。`}
        confirmLabel="移除"
        loading={removing}
      />
    </div>
  );
}
