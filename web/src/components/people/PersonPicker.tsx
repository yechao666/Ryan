import { useEffect, useMemo, useState } from 'react';
import type { Person } from '@shared';
import { Avatar, Button, EmptyState, Input, Modal, SearchInput, Skeleton } from '@ui';
import { toneFor } from '../projects/helpers.tsx';

export interface PersonPickerProps {
  open: boolean;
  title?: string;
  description?: string;
  people: Person[];
  value?: string;
  loading?: boolean;
  emptyText?: string;
  onClose: () => void;
  onSelect: (person: Person) => void;
}

/** 可搜索的人员选择对话框，避免人员很多时使用原生下拉。 */
export function PersonPicker({
  open,
  title = '选择人员',
  description = '按姓名、邮箱或职位搜索组织成员。',
  people,
  value,
  loading,
  emptyText = '没有可添加的人员',
  onClose,
  onSelect,
}: PersonPickerProps) {
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState(value ?? '');

  useEffect(() => {
    if (!open) return;
    setSelectedId(value ?? '');
    setKeyword('');
  }, [open, value]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((person) => `${person.name} ${person.email} ${person.title}`.toLowerCase().includes(needle));
  }, [people, keyword]);

  const selected = people.find((person) => person.id === selectedId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            icon="check"
            disabled={!selected}
            onClick={() => {
              if (selected) {
                onSelect(selected);
                onClose();
              }
            }}
          >
            选择
          </Button>
        </>
      }
    >
      <div className="vstack gap-10">
        <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索姓名 / 邮箱 / 职位" />
        <div className="person-picker-list">
          {loading ? (
            <div className="vstack gap-6">{[0, 1, 2, 3].map((item) => <Skeleton key={item} h={52} />)}</div>
          ) : filtered.length === 0 ? (
            <EmptyState icon="users" title={people.length ? '没有匹配的人员' : emptyText} description={people.length ? '调整搜索关键词。' : undefined} compact />
          ) : filtered.map((person) => (
            <button
              type="button"
              key={person.id}
              className={`person-picker-row${selectedId === person.id ? ' active' : ''}`}
              onClick={() => setSelectedId(person.id)}
            >
              <Avatar name={person.name} tone={toneFor(person.email)} size="sm" />
              <span className="person-picker-main">
                <span className="person-picker-name">{person.name}</span>
                <span className="person-picker-meta">{person.title || '—'} · {person.email}</span>
              </span>
              {person.isAdmin ? <span className="tiny dim">管理员</span> : null}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
