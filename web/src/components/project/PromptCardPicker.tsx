import { useMemo, useState } from 'react';
import type { PromptCard } from '@shared';
import { INSTANCE_STATUSES } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { Badge, Button, Callout, Checkbox, EmptyState, Field, Icon, Select, Skeleton } from '@ui';
import { promptCardCategoryMeta } from './meta.ts';
import { PromptCardDialog } from './PromptCardDialog.tsx';

/** 拉取项目可引用的提示词卡片（组织 / 团队 / 项目级）。 */
export function useProjectPromptCards(projectId: string, enabled: boolean) {
  return useAsync<PromptCard[]>(() => api.projectPromptCards(projectId), [projectId, enabled], enabled);
}

export interface PromptCardPickerProps {
  projectId: string;
  open: boolean;
  value: string[];
  onChange: (next: string[]) => void;
}

/**
 * 提示词卡片多选：引用可复用的工作流 / 风格 / 标准 / 角色卡片，
 * 执行任务时与任务提示词一起注入 DSH。
 */
export function PromptCardPicker({ projectId, open, value, onChange }: PromptCardPickerProps) {
  const cards = useProjectPromptCards(projectId, open);
  const [dialogOpen, setDialogOpen] = useState(false);
  const selected = (cards.data ?? []).filter((card) => value.includes(card.id));

  return (
    <Field
      label={`提示词卡片${value.length ? `（已选 ${value.length}）` : ''}`}
      hint="卡片内容会作为可复用上下文随任务一起注入；卡片较多时在弹窗中搜索选择。"
    >
      <div className="hstack gap-6 wrap">
        {selected.length ? selected.map((card) => (
          <span className="chip" key={card.id}>
            <Icon name="book" size={11} />
            {card.name}
          </span>
        )) : <span className="tiny dim">未引用提示词卡片</span>}
        <Button
          type="button"
          size="sm"
          variant="outline"
          icon="book"
          onClick={() => setDialogOpen(true)}
        >
          选择卡片
        </Button>
      </div>
      {cards.error ? <Callout tone="red" icon="alert">加载提示词卡片失败：{cards.error}</Callout> : null}
      <PromptCardDialog
        projectId={projectId}
        open={dialogOpen}
        value={value}
        onChange={onChange}
        onClose={() => setDialogOpen(false)}
      />
    </Field>
  );
}

/** 拉取项目可调度服务：项目有绑定时只显示绑定服务，否则显示共享池。 */
export function useProjectInstances(projectId: string, enabled: boolean) {
  const query = useAsync(async () => {
    const [instances, binding] = await Promise.all([api.instances(), api.projectServices(projectId)]);
    const bound = new Set(binding.serviceIds);
    return {
      instances: instances.filter((instance) => instance.status !== 'revoked' && (bound.size === 0 || bound.has(instance.id))),
      boundIds: binding.serviceIds,
    };
  }, [projectId, enabled], enabled);
  return { ...query, instances: query.data?.instances ?? [], boundIds: query.data?.boundIds ?? [] };
}

export interface ProjectInstanceSelectProps {
  projectId: string;
  open: boolean;
  value: string;
  onChange: (next: string) => void;
}

/** 可选 DSH 服务：仅列出绑定当前项目的服务，留空由服务端自动分配。 */
export function ProjectInstanceSelect({ projectId, open, value, onChange }: ProjectInstanceSelectProps) {
  const query = useProjectInstances(projectId, open);

  const options = [
    { value: '', label: '自动调度（推荐）' },
    ...query.instances.map((instance) => {
      const status = INSTANCE_STATUSES.find((item) => item.value === instance.status)?.label ?? instance.status;
      return { value: instance.id, label: `${instance.name} · ${status}` };
    }),
  ];

  return (
    <Field label="DSH 服务" hint="留空由调度器自动选择可用服务；指定则只由该服务领取。">
      {query.loading && !query.data ? (
        <Skeleton h={36} />
      ) : query.error ? (
        <Callout tone="red" icon="alert">
          加载服务失败：{query.error}
        </Callout>
      ) : query.instances.length === 0 ? (
        <Callout tone="amber" icon="info">
          当前没有可用的 DSH 服务，任务会留在队列等待服务上线。
        </Callout>
      ) : (
        <Select value={value} options={options} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}

export interface ProjectInstanceMultiSelectProps {
  projectId: string;
  open: boolean;
  value: string[];
  onChange: (next: string[]) => void;
}

/** 任务可指定一个或多个服务；空表示由项目绑定服务公平调度。 */
export function ProjectInstanceMultiSelect({ projectId, open, value, onChange }: ProjectInstanceMultiSelectProps) {
  const query = useProjectInstances(projectId, open);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);

  return (
    <Field
      label={`DSH 服务范围${value.length ? `（已选 ${value.length} 个）` : ''}`}
      hint="不选则由项目绑定服务公平调度；选择多个时任务只会在这些服务中分配。"
    >
      {query.loading && !query.data ? (
        <Skeleton h={48} />
      ) : query.error ? (
        <Callout tone="red" icon="alert">
          加载服务失败：{query.error}
        </Callout>
      ) : query.instances.length === 0 ? (
        <Callout tone="amber" icon="info">
          项目未绑定服务且服务池为空；任务会留在队列等待服务上线。
        </Callout>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {query.instances.map((instance) => (
            <Checkbox
              key={instance.id}
              checked={value.includes(instance.id)}
              onChange={() => toggle(instance.id)}
              label={
                <span className="hstack gap-6">
                  <span>{instance.name}</span>
                  <span className="tiny dim mono">{instance.id}</span>
                  <span className="tiny dim">{instance.status === 'online' ? '在线' : '离线'}</span>
                </span>
              }
            />
          ))}
          {query.boundIds.length === 0 ? (
            <span className="tiny dim">项目未绑定服务：以上为共享服务池。</span>
          ) : null}
        </div>
      )}
    </Field>
  );
}
