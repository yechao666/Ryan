import { useEffect, useMemo, useState } from 'react';
import type { Person } from '@shared';
import { Avatar, Button, EmptyState, Icon, Modal, SearchInput, Select, Skeleton } from '@ui';
import { toneFor } from '../projects/helpers.tsx';

export interface PersonPickerProps {
  open: boolean;
  title?: string;
  description?: string;
  people: Person[];
  value?: string;
  values?: string[];
  multiple?: boolean;
  teams?: { id: string; name: string }[];
  loading?: boolean;
  emptyText?: string;
  onClose: () => void;
  onSelect?: (person: Person) => void;
  onSelectMany?: (people: Person[]) => void;
}

/** 可搜索、多选、按团队过滤的人员选择对话框。 */
export function PersonPicker({
  open,
  title = '选择人员',
  description,
  people,
  value,
  values,
  multiple = false,
  teams,
  loading,
  emptyText = '没有可添加的人员',
  onClose,
  onSelect,
  onSelectMany,
}: PersonPickerProps) {
  const [keyword, setKeyword] = useState('');
  const [teamId, setTeamId] = useState('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setSelectedIds(multiple ? (values ?? []) : value ? [value] : []);
    setKeyword('');
    setTeamId('all');
  }, [open, value, values, multiple]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return people.filter((person) => {
      if (teamId !== 'all' && !person.teamIds?.includes(teamId)) return false;
      if (!needle) return true;
      return `${person.name} ${person.email} ${person.title} ${person.teamNames?.join(' ') ?? ''}`.toLowerCase().includes(needle);
    });
  }, [people, keyword, teamId]);

  const selectedPeople = people.filter((person) => selectedIds.includes(person.id));
  const toggle = (person: Person) => {
    if (!multiple) {
      setSelectedIds([person.id]);
      return;
    }
    setSelectedIds((current) => current.includes(person.id)
      ? current.filter((id) => id !== person.id)
      : [...current, person.id]);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description ?? (multiple ? '按姓名、邮箱、职位或团队搜索，可一次选择多人。' : '按姓名、邮箱或职位搜索组织成员。')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            icon="check"
            disabled={selectedPeople.length === 0}
            onClick={() => {
              if (multiple) onSelectMany?.(selectedPeople);
              else if (selectedPeople[0]) onSelect?.(selectedPeople[0]);
              onClose();
            }}
          >
            {multiple && selectedPeople.length > 0 ? `选择 ${selectedPeople.length} 人` : '选择'}
          </Button>
        </>
      }
    >
      <div className="vstack gap-10">
        <div className="hstack gap-8">
          <div className="grow">
            <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索姓名 / 邮箱 / 职位" />
          </div>
          {teams?.length ? (
            <Select
              className="ws-filter-select"
              value={teamId}
              options={[{ value: 'all', label: '全部团队' }, ...teams.map((team) => ({ value: team.id, label: team.name }))]}
              onChange={(event) => setTeamId(event.target.value)}
            />
          ) : null}
        </div>
        <div className="tiny dim">
          {selectedPeople.length > 0 ? `已选 ${selectedPeople.length} 人` : `${people.length} 位可选人员`}
        </div>
        <div className="person-picker-list">
          {loading ? (
            <div className="vstack gap-6">{[0, 1, 2, 3].map((item) => <Skeleton key={item} h={52} />)}</div>
          ) : filtered.length === 0 ? (
            <EmptyState icon="users" title={people.length ? '没有匹配的人员' : emptyText} description={people.length ? '调整搜索关键词或团队筛选。' : undefined} compact />
          ) : filtered.map((person) => {
            const selected = selectedIds.includes(person.id);
            return (
              <button
                type="button"
                key={person.id}
                className={`person-picker-row${selected ? ' active' : ''}`}
                onClick={() => toggle(person)}
              >
                <Avatar name={person.name} tone={toneFor(person.email)} size="sm" />
                <span className="person-picker-main">
                  <span className="person-picker-name">{person.name}</span>
                  <span className="person-picker-meta">{person.title || '—'} · {person.email}</span>
                  {person.teamNames?.length ? <span className="person-picker-teams">{person.teamNames.join(' · ')}</span> : null}
                </span>
                {person.isAdmin ? <span className="tiny dim">管理员</span> : null}
                {multiple ? (
                  <span className={`person-picker-check${selected ? ' is-checked' : ''}`}>
                    {selected ? <Icon name="check" size={12} /> : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
