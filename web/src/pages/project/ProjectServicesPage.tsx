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
  ErrorState,
  Icon,
  PageHead,
  SectionHead,
  Skeleton,
  useToast,
  type Tone,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';

/** 项目服务资源：项目绑定的 DSH 服务与公平调度范围。 */
export function ProjectServicesPage() {
  const { detail, reload } = useProject();
  const projectId = detail.project.id;
  const toast = useToast();
  const services = useAsync(() => api.instances(), []);
  const [serviceIds, setServiceIds] = useState<string[]>(detail.project.serviceIds ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setServiceIds(detail.project.serviceIds ?? []);
  }, [detail.project.id, detail.project.serviceIds]);

  const available = useMemo(
    () => (services.data ?? []).filter((service: DshInstance) => service.status !== 'revoked'),
    [services.data],
  );
  const online = available.filter((service) => service.status === 'online').length;

  const toggle = (serviceId: string) => {
    setServiceIds((current) => (
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId]
    ));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateProjectServices(projectId, serviceIds);
      toast.success('项目服务绑定已保存');
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存项目服务绑定失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ws-page">
      <PageHead
        title="项目 DSH 服务"
        desc="绑定到本项目的 DSH 服务；本项目的任务只会在绑定服务之间公平调度。不绑定则使用共享服务池。"
        actions={
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            保存绑定
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
          <div className="pm-value">{online} / {available.length}</div>
          <div className="card-sub">可参与公平调度</div>
        </Card>
      </div>

      <Card className="card-pad">
        <SectionHead
          title={
            <>
              <Icon name="server" size={14} />
              可绑定服务
            </>
          }
          desc="可多选。任务创建时默认在绑定服务之间轮询；任务也可以进一步限定服务范围。"
        />
        {services.loading && !services.data ? (
          <div className="vstack gap-8 mt-12">
            {[0, 1, 2].map((item) => <Skeleton key={item} h={54} />)}
          </div>
        ) : services.error ? (
          <ErrorState message={services.error} onRetry={() => void services.refresh()} />
        ) : available.length === 0 ? (
          <Callout tone="amber" icon="info">
            暂无可用 DSH 服务。项目任务会留在队列，等待服务上线或绑定服务。
          </Callout>
        ) : (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            {available.map((service) => {
              const status = INSTANCE_STATUSES.find((item) => item.value === service.status) ?? { label: service.status, tone: 'slate' as const };
              return (
                <div className={`ws-pick-item${serviceIds.includes(service.id) ? ' active' : ''}`} key={service.id}>
                  <Checkbox
                    checked={serviceIds.includes(service.id)}
                    onChange={() => toggle(service.id)}
                    label={
                      <span className="ws-pick-main">
                        <span className="ws-pick-name">{service.name}</span>
                        <span className="tiny dim">
                          {service.id} · {service.host || '未设置主机'}
                          {service.port ? `:${service.port}` : ''}
                        </span>
                      </span>
                    }
                  />
                  <Badge tone={status.tone as Tone} size="sm" dot>{status.label}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {serviceIds.length === 0 ? (
        <Callout tone="amber" icon="info">
          当前项目未绑定服务：任务会进入共享服务池，由任意在线服务领取。
        </Callout>
      ) : (
        <Callout tone="cyan" icon="info">
          已绑定 {serviceIds.length} 个服务。任务创建时默认在这些服务之间按项目轮询公平分配；也可在新建任务时限定一个或多个服务。
        </Callout>
      )}
    </div>
  );
}
