import { useEffect, useMemo, useState } from 'react';
import type { DshInstance } from '@shared';
import { INSTANCE_STATUSES } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Icon,
  Modal,
  PageHead,
  SectionHead,
  Skeleton,
  useToast,
  type Tone,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';

/** 项目服务资源：显式添加/解除绑定的 DSH 服务。 */
export function ProjectServicesPage() {
  const { detail, reload } = useProject();
  const projectId = detail.project.id;
  const toast = useToast();
  const services = useAsync(() => api.instances(), []);
  const settings = useAsync(() => api.settings(), []);
  const [serviceIds, setServiceIds] = useState<string[]>(detail.project.serviceIds ?? []);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    setServiceIds(detail.project.serviceIds ?? []);
  }, [detail.project.id, detail.project.serviceIds]);

  const available = useMemo(
    () => (services.data ?? []).filter((service: DshInstance) => service.status !== 'revoked'),
    [services.data],
  );
  const bound = available.filter((service) => serviceIds.includes(service.id));
  const unbound = available.filter((service) => !serviceIds.includes(service.id));
  const online = bound.filter((service) => service.status === 'online').length;
  const defaultService = available.find((service) => service.id === settings.data?.defaultServiceId);

  const save = async (next: string[], message: string) => {
    setSaving(true);
    try {
      await api.updateProjectServices(projectId, next);
      setServiceIds(next);
      toast.success(message);
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存项目服务绑定失败');
    } finally {
      setSaving(false);
    }
  };

  const openAdd = () => {
    setSelected([]);
    setAddOpen(true);
  };

  const addSelected = async () => {
    if (selected.length === 0) return;
    await save([...serviceIds, ...selected], `已添加 ${selected.length} 个服务`);
    setAddOpen(false);
  };

  return (
    <div className="ws-page">
      <PageHead
        title="项目 DSH 服务"
        desc="绑定到本项目的 DSH 服务；本项目的任务只会在绑定服务之间公平调度。不绑定则使用共享服务池。"
        actions={
          <Button variant="primary" icon="plus" disabled={unbound.length === 0} onClick={openAdd}>
            添加服务
          </Button>
        }
      />

      <div className="kpi-grid">
        <Card className="card-pad">
          <div className="pm-label">已绑定服务</div>
          <div className="pm-value">{serviceIds.length}</div>
          <div className="card-sub">项目任务调度范围</div>
        </Card>
        <Card className="card-pad">
          <div className="pm-label">在线服务</div>
          <div className="pm-value">{online} / {bound.length}</div>
          <div className="card-sub">可参与公平调度</div>
        </Card>
      </div>

      <Card className="card-pad">
        <SectionHead
          title={
            <>
              <Icon name="server" size={14} />
              已绑定服务
            </>
          }
          desc="项目任务默认在这些服务之间按项目轮询公平分配；每个服务都可以解除绑定。"
          actions={
            <Button size="sm" variant="outline" icon="plus" disabled={unbound.length === 0} onClick={openAdd}>
              添加服务
            </Button>
          }
        />
        {services.loading && !services.data ? (
          <div className="vstack gap-8 mt-12">
            {[0, 1, 2].map((item) => <Skeleton key={item} h={58} />)}
          </div>
        ) : services.error ? (
          <ErrorState message={services.error} onRetry={() => void services.refresh()} />
        ) : bound.length === 0 ? (
          <EmptyState
            icon="server"
            title="尚未绑定 DSH 服务"
            description="绑定服务后，项目任务只在绑定服务间调度；不绑定则使用默认服务或共享池。"
            action={<Button size="sm" variant="primary" icon="plus" onClick={openAdd}>添加服务</Button>}
            compact
          />
        ) : (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            {bound.map((service) => {
              const status = INSTANCE_STATUSES.find((item) => item.value === service.status) ?? { label: service.status, tone: 'slate' as const };
              return (
                <div className="ws-pick-item" key={service.id}>
                  <span className={`cx-metric-icon tone-${status.tone}`}>
                    <Icon name="server" size={14} />
                  </span>
                  <div className="ws-pick-main grow">
                    <span className="ws-pick-name">{service.name}</span>
                    <span className="tiny dim">
                      {service.id} · {service.host || '未设置主机'}
                      {service.port ? `:${service.port}` : ''}
                      {service.currentTask ? ` · 正在执行：${service.currentTask.title}` : ' · 空闲'}
                    </span>
                  </div>
                  <Badge tone={status.tone as Tone} size="sm" dot>{status.label}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    loading={saving}
                    onClick={() => void save(serviceIds.filter((id) => id !== service.id), `已解除绑定：${service.name}`)}
                  >
                    解除绑定
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {serviceIds.length === 0 ? (
        <Callout tone="amber" icon="info">
          当前项目未绑定服务：{defaultService ? `任务将使用默认服务「${defaultService.name}」` : '任务会进入共享服务池，由任意在线服务领取'}。
        </Callout>
      ) : (
        <Callout tone="cyan" icon="info">
          已绑定 {serviceIds.length} 个服务。任务创建时默认在这些服务之间按项目轮询公平分配；也可在新建任务时限定一个或多个服务。
        </Callout>
      )}

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="添加 DSH 服务"
        description="选择要绑定到本项目的 DSH 服务。已绑定的服务不会出现在这里。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>取消</Button>
            <Button
              variant="primary"
              icon="plus"
              loading={saving}
              disabled={selected.length === 0}
              onClick={() => void addSelected()}
            >
              添加{selected.length ? `（${selected.length}）` : ''}
            </Button>
          </>
        }
      >
        {unbound.length === 0 ? (
          <Callout tone="amber" icon="info">
            没有可添加的服务。请先在「服务」页新增 DSH 服务。
          </Callout>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {unbound.map((service) => {
              const status = INSTANCE_STATUSES.find((item) => item.value === service.status) ?? { label: service.status, tone: 'slate' as const };
              return (
                <div className={`ws-pick-item${selected.includes(service.id) ? ' active' : ''}`} key={service.id}>
                  <Checkbox
                    checked={selected.includes(service.id)}
                    onChange={() => setSelected((current) => (
                      current.includes(service.id) ? current.filter((id) => id !== service.id) : [...current, service.id]
                    ))}
                    label={
                      <span className="ws-pick-main">
                        <span className="ws-pick-name">{service.name}</span>
                        <span className="tiny dim">{service.id} · {service.host || '未设置主机'}</span>
                      </span>
                    }
                  />
                  <Badge tone={status.tone as Tone} size="sm" dot>{status.label}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    </div>
  );
}
