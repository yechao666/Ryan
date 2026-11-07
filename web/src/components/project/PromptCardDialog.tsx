import { useEffect, useMemo, useState } from 'react';
import type { PromptCard, PromptCardScope } from '@shared';
import { PROMPT_CARD_CATEGORIES, PROMPT_CARD_SCOPES } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
} from '@ui';
import { promptCardCategoryMeta } from './meta.ts';

export interface PromptCardDialogProps {
  projectId: string;
  open: boolean;
  value: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
}

/** 大量提示词卡片的专用选择对话框：搜索 + 分类/范围筛选。 */
export function PromptCardDialog({ projectId, open, value, onChange, onClose }: PromptCardDialogProps) {
  const cards = useAsync<PromptCard[]>(() => api.projectPromptCards(projectId), [projectId, open], open);
  const [draft, setDraft] = useState<string[]>(value);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [scope, setScope] = useState<'all' | PromptCardScope>('all');

  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setSearch('');
    setCategory('all');
    setScope('all');
  }, [open, value]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (cards.data ?? []).filter((card) => {
      if (category !== 'all' && card.category !== category) return false;
      if (scope !== 'all' && card.scope !== scope) return false;
      if (!keyword) return true;
      return `${card.name} ${card.description} ${card.content}`.toLowerCase().includes(keyword);
    });
  }, [cards.data, search, category, scope]);

  const toggle = (id: string) => {
    setDraft((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const scopeTarget = (card: PromptCard): string => {
    if (card.scope === 'project') return card.projectName ?? '';
    if (card.scope === 'team') return card.teamName ?? '';
    if (card.scope === 'person') return card.personName ?? '';
    return '全员';
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="选择提示词卡片"
      description="可按名称搜索，按分类或适用范围筛选；可多选。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => {
              onChange(draft);
              onClose();
            }}
          >
            确定{draft.length ? `（${draft.length}）` : ''}
          </Button>
        </>
      }
    >
      <div className="grid grid-3" style={{ gap: 8 }}>
        <Field label="搜索">
          <Input value={search} placeholder="搜索名称、说明或内容…" onChange={(event) => setSearch(event.target.value)} />
        </Field>
        <Field label="分类">
          <Select
            value={category}
            options={[
              { value: 'all', label: '全部分类' },
              ...PROMPT_CARD_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
            ]}
            onChange={(event) => setCategory(event.target.value)}
          />
        </Field>
        <Field label="适用范围">
          <Select
            value={scope}
            options={[
              { value: 'all', label: '全部范围' },
              ...PROMPT_CARD_SCOPES.map((item) => ({ value: item.value, label: item.label })),
            ]}
            onChange={(event) => setScope(event.target.value as 'all' | PromptCardScope)}
          />
        </Field>
      </div>

      <div className="ws-prompt-dialog-list" style={{ marginTop: 10 }}>
        {cards.loading && !cards.data ? (
          <div className="vstack gap-8">
            {[0, 1, 2, 3].map((item) => <Skeleton key={item} h={54} />)}
          </div>
        ) : cards.error ? (
          <Callout tone="red" icon="alert">加载提示词卡片失败：{cards.error}</Callout>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="book"
            title={cards.data?.length ? '没有匹配的卡片' : '暂无可引用的提示词卡片'}
            description={cards.data?.length ? '调整搜索或筛选条件。' : '组织、团队、项目或人员级卡片会出现在这里。'}
            compact
          />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {filtered.map((card) => {
              const meta = promptCardCategoryMeta(card.category);
              return (
                <div className={`ws-pick-item${draft.includes(card.id) ? ' active' : ''}`} key={card.id}>
                  <Checkbox
                    checked={draft.includes(card.id)}
                    onChange={() => toggle(card.id)}
                    label={
                      <span className="ws-pick-main">
                        <span className="ws-pick-name">{card.name}</span>
                        <span className="tiny dim clamp-1">
                          {card.description || card.content.slice(0, 100)}
                        </span>
                      </span>
                    }
                  />
                  <div className="hstack gap-4 wrap" style={{ marginLeft: 'auto' }}>
                    <Badge size="sm" tone={meta.tone}>{meta.label}</Badge>
                    <span className="tiny dim">{scopeTarget(card)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
