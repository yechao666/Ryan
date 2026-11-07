import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Automation, InboundDelivery } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDateTime, fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  PageHead,
  SectionHead,
  Skeleton,
  Switch,
  Table,
  useToast,
  type Column,
} from '@ui';
import { AutomationForm } from '../../components/project/AutomationForm.tsx';
import {
  automationTriggerMeta,
  deliveryStatusMeta,
  runStatusMeta,
  webhookEventLabel,
} from '../../components/project/meta.ts';
import { useProject } from '../ProjectLayout.tsx';

/** 项目自动化：维护触发规则、运行记录与入站 Webhook 配置。 */
export function ProjectAutomationsPage() {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const navigate = useNavigate();
  const toast = useToast();
  const base = `/projects/${encodeURIComponent(projectId)}`;

  const automations = useAsync(() => api.automations(projectId), [projectId]);
  const deliveries = useAsync(() => api.deliveries(projectId), [projectId]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const webhookUrls = [
    { provider: 'GitHub', url: `${origin}/api/integrations/github/${projectId}`, tone: 'violet' as const },
    { provider: 'GitLab', url: `${origin}/api/integrations/gitlab/${projectId}`, tone: 'amber' as const },
  ];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (automation: Automation) => {
    setEditing(automation);
    setFormOpen(true);
  };

  const handleToggle = async (automation: Automation, next: boolean) => {
    setTogglingId(automation.id);
    try {
      await api.updateAutomation(automation.id, { enabled: next });
      toast.success(next ? '自动化已启用' : '自动化已停用');
      await automations.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '更新自动化失败');
    } finally {
      setTogglingId(null);
    }
  };

  const handleRun = async (automation: Automation) => {
    setRunningId(automation.id);
    try {
      const result = await api.runAutomation(automation.id);
      toast.success('已触发自动化，任务已创建');
      await automations.refresh();
      if (result?.task?.id) navigate(`${base}/tasks/${encodeURIComponent(result.task.id)}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '运行自动化失败，请重试');
    } finally {
      setRunningId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteAutomation(deleteTarget.id);
      toast.success('自动化已删除');
      setDeleteTarget(null);
      await automations.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除自动化失败');
    } finally {
      setDeleting(false);
    }
  };

  const deliveryColumns: Column<InboundDelivery>[] = [
    {
      key: 'time',
      header: '投递时间',
      render: (row) => <span className="tiny dim">{fmtDateTime(row.createdAt)}</span>,
    },
    {
      key: 'provider',
      header: '提供方',
      render: (row) => (
        <Badge tone={row.provider === 'github' ? 'violet' : 'amber'} size="sm">
          {row.provider === 'github' ? 'GitHub' : 'GitLab'}
        </Badge>
      ),
    },
    {
      key: 'event',
      header: '事件',
      render: (row) => (
        <span className="hstack gap-4">
          <code className="ws-inline-code">{row.event}</code>
          <span className="tiny dim truncate ws-mono-cell">{row.deliveryId}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (row) => {
        const meta = deliveryStatusMeta(row.status);
        return (
          <Badge tone={meta.tone} size="sm" dot>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'task',
      header: '任务',
      align: 'right',
      render: (row) =>
        row.taskId ? (
          <Link className="ws-link small" to={`${base}/tasks/${encodeURIComponent(row.taskId)}`}>
            打开任务
            <Icon name="arrowRight" size={11} />
          </Link>
        ) : (
          <span className="dim tiny">—</span>
        ),
    },
  ];

  return (
    <div className="ws-page">
      <PageHead
        title="自动化"
        desc="仓库事件、定时任务或手动操作都能自动生成 Ryan 任务，并复用项目提示词与记忆。"
        actions={
          <>
            <Button variant="ghost" icon="refresh" onClick={() => void automations.refresh()}>
              刷新
            </Button>
            <Button variant="primary" icon="plus" onClick={openCreate}>
              新建自动化
            </Button>
          </>
        }
      />

      {automations.error && !automations.data ? (
        <Card>
          <div style={{ padding: 18 }}>
            <ErrorState message={automations.error} onRetry={() => void automations.refresh()} />
          </div>
        </Card>
      ) : automations.loading && !automations.data ? (
        <div className="ws-automation-grid">
          {[0, 1].map((item) => (
            <Skeleton key={item} h={186} style={{ borderRadius: 16 }} />
          ))}
        </div>
      ) : !automations.data?.length ? (
        <Card>
          <EmptyState
            icon="zap"
            title="还没有自动化"
            description="创建自动化，让仓库事件或定时计划自动驱动 Ryan 执行任务。"
            action={
              <Button size="sm" variant="primary" icon="plus" onClick={openCreate}>
                新建自动化
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="ws-automation-grid">
          {automations.data.map((automation) => {
            const trigger = automationTriggerMeta(automation.triggerType);
            const run = runStatusMeta(automation.lastRunStatus);
            const events = automation.triggerConfig.events ?? [];
            const active = togglingId === automation.id;
            return (
              <Card key={automation.id} className="ws-automation-card">
                <div className="ws-automation-head">
                  <div className="vstack" style={{ gap: 2, minWidth: 0 }}>
                    <span className="ws-automation-name truncate">{automation.name}</span>
                    <span className="tiny dim truncate">
                      {automation.instanceName ? `服务 ${automation.instanceName}` : '服务 自动分配'}
                      {' · '}
                      创建人 {automation.createdByName || '—'}
                    </span>
                  </div>
                  <Switch
                    checked={automation.enabled}
                    disabled={active}
                    onChange={(next) => void handleToggle(automation, next)}
                  />
                </div>

                <div className="hstack gap-6 wrap">
                  <Badge tone={trigger.tone} size="sm">
                    {trigger.label}
                  </Badge>
                  {automation.triggerType === 'cron' && automation.triggerConfig.schedule ? (
                    <span className="chip mono">{automation.triggerConfig.schedule}</span>
                  ) : null}
                  {events.map((event) => (
                    <span className="chip" key={event}>
                      {webhookEventLabel(event)}
                    </span>
                  ))}
                  {automation.promptCardIds?.length ? (
                    <span className="chip">
                      <Icon name="book" size={11} />
                      {automation.promptCardIds.length} 提示卡
                    </span>
                  ) : null}
                  {run ? (
                    <Badge tone={run.tone} size="sm">
                      {run.label}
                    </Badge>
                  ) : null}
                </div>

                <p className="ws-automation-prompt clamp-2">{automation.promptTemplate}</p>

                <div className="ws-automation-foot">
                  <span className="tiny dim hstack gap-4">
                    <Icon name="clock" size={12} />
                    {automation.lastRunAt ? `最近运行 ${fmtRelative(automation.lastRunAt)}` : '尚未运行'}
                  </span>
                  <div className="hstack gap-4">
                    <Button
                      size="sm"
                      variant="outline"
                      icon="play"
                      loading={runningId === automation.id}
                      disabled={!automation.enabled}
                      onClick={() => void handleRun(automation)}
                    >
                      运行
                    </Button>
                    <Button size="sm" variant="ghost" icon="pencil" onClick={() => openEdit(automation)}>
                      编辑
                    </Button>
                    <IconButton
                      icon="trash"
                      label="删除自动化"
                      size="sm"
                      onClick={() => setDeleteTarget(automation)}
                    />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="card-pad">
        <SectionHead
          title={
            <>
              <Icon name="globe" size={14} />
              入站 Webhook
            </>
          }
          desc="在 GitHub / GitLab 仓库中配置以下地址，投递会按自动化规则触发任务。"
        />
        <div className="ws-webhook-list">
          {webhookUrls.map((item) => (
            <div className="ws-webhook-row" key={item.provider}>
              <Badge tone={item.tone} size="sm">
                {item.provider}
              </Badge>
              <code className="ws-webhook-url" title={item.url}>
                {item.url}
              </code>
              <CopyButton value={item.url} label="复制地址" />
            </div>
          ))}
        </div>
        <Callout tone="cyan" icon="info">
          Secret 在每个自动化的 Webhook 配置中单独填写；GitHub 校验 X-Hub-Signature-256，GitLab 校验 X-Gitlab-Token。
          未匹配任何自动化的事件会记录为「已忽略」。
        </Callout>
      </Card>

      <Card>
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <SectionHead
            title={
              <>
                <Icon name="download" size={14} />
                投递记录
              </>
            }
            desc="最近的 Webhook 投递与处理结果"
            actions={
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void deliveries.refresh()}>
                刷新
              </Button>
            }
          />
        </div>
        {deliveries.error && !deliveries.data ? (
          <div style={{ padding: 18 }}>
            <ErrorState message={deliveries.error} onRetry={() => void deliveries.refresh()} />
          </div>
        ) : (
          <Table
            columns={deliveryColumns}
            rows={deliveries.data ?? []}
            rowKey={(row) => row.id}
            loading={deliveries.loading && !deliveries.data}
            empty={
              <EmptyState
                icon="download"
                title="暂无投递记录"
                description="仓库配置 Webhook 并产生事件后，这里会显示投递与处理结果。"
                compact
              />
            }
          />
        )}
      </Card>

      <AutomationForm
        open={formOpen}
        automation={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          setEditing(null);
          void automations.refresh();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title="删除自动化"
        description={`确认删除「${deleteTarget?.name ?? ''}」？已创建的任务不受影响，但后续事件不再触发。`}
        confirmLabel="删除"
        loading={deleting}
      />
    </div>
  );
}
