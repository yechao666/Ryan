import { useMemo } from 'react';
import type { PromptCard } from '@shared';
import { INSTANCE_STATUSES } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { Badge, Callout, Checkbox, EmptyState, Field, Select, Skeleton } from '@ui';
import { promptCardCategoryMeta } from './meta.ts';

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

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  };

  return (
    <Field
      label={`提示词卡片${value.length ? `（已选 ${value.length}）` : ''}`}
      hint="可选，多选；卡片内容会作为可复用上下文随任务一起下发。"
    >
      {cards.loading && !cards.data ? (
        <div className="vstack gap-8">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} h={46} style={{ borderRadius: 10 }} />
          ))}
        </div>
      ) : cards.error ? (
        <Callout tone="red" icon="alert">
          加载提示词卡片失败：{cards.error}
        </Callout>
      ) : !cards.data?.length ? (
        <EmptyState
          icon="book"
          title="暂无可引用的提示词卡片"
          description="组织、团队或项目级的提示词卡片会出现在这里；可先在「提示词」页维护。"
          compact
        />
      ) : (
        <div className="ws-pick-list">
          {cards.data.map((card) => {
            const meta = promptCardCategoryMeta(card.category);
            const selected = value.includes(card.id);
            return (
              <div className={`ws-pick-item${selected ? ' active' : ''}`} key={card.id}>
                <Checkbox
                  checked={selected}
                  onChange={() => toggle(card.id)}
                  label={
                    <span className="ws-pick-main">
                      <span className="ws-pick-name truncate">{card.name}</span>
                      <span className="tiny dim truncate">
                        {card.description || card.content.slice(0, 90)}
                      </span>
                    </span>
                  }
                />
                <Badge tone={meta.tone} size="sm" className="ml-auto">
                  {meta.label}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </Field>
  );
}

/** 拉取绑定当前项目的 DSH 实例。 */
export function useProjectInstances(projectId: string, enabled: boolean) {
  const query = useAsync(() => api.instances(), [enabled], enabled);
  const instances = useMemo(
    () => (query.data ?? []).filter((instance) => instance.projectIds.includes(projectId)),
    [query.data, projectId],
  );
  return { ...query, instances };
}

export interface ProjectInstanceSelectProps {
  projectId: string;
  open: boolean;
  value: string;
  onChange: (next: string) => void;
}

/** 可选 DSH 实例：仅列出绑定当前项目的实例，留空由服务端自动分配。 */
export function ProjectInstanceSelect({ projectId, open, value, onChange }: ProjectInstanceSelectProps) {
  const query = useProjectInstances(projectId, open);

  const options = [
    { value: '', label: '自动分配（推荐）' },
    ...query.instances.map((instance) => {
      const status = INSTANCE_STATUSES.find((item) => item.value === instance.status)?.label ?? instance.status;
      return { value: instance.id, label: `${instance.name} · ${status}` };
    }),
  ];

  return (
    <Field label="DSH 实例" hint="留空由服务端自动选择绑定该项目的可用实例。">
      {query.loading && !query.data ? (
        <Skeleton h={36} />
      ) : query.error ? (
        <Callout tone="red" icon="alert">
          加载实例失败：{query.error}
        </Callout>
      ) : query.instances.length === 0 ? (
        <Callout tone="amber" icon="info">
          当前没有绑定该项目的 DSH 实例，任务将由平台自动匹配可用实例。
        </Callout>
      ) : (
        <Select value={value} options={options} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}
