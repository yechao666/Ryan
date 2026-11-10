import { useEffect, useMemo, useState } from 'react';
import type { ProjectMember, ProjectRole } from '@shared';
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
  EmptyState,
  Field,
  Icon,
  Modal,
  PageHead,
  SearchInput,
  SectionHead,
  Select,
  Skeleton,
  Table,
  useToast,
  type Column,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';
import { PersonPicker } from '../../components/people/PersonPicker.tsx';
import { PROJECT_ROLE_OPTIONS, projectRoleLabel } from '../../components/project/meta.ts';

/** 项目成员：独立页签维护成员与项目角色。 */
export function ProjectMembersPage() {
  const { detail, reload } = useProject();
  const projectId = detail.project.id;
  const toast = useToast();

  const teams = useAsync(() => api.teams(), []);
  const [addOpen, setAddOpen] = useState(false);
  const [newPersonId, setNewPersonId] = useState('');
  const [personPickerOpen, setPersonPickerOpen] = useState(false);
  const [newRole, setNewRole] = useState<ProjectRole>('developer');
  const [adding, setAdding] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | ProjectRole>('all');
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);
  const [removing, setRemoving] = useState(false);

  const persons = useAsync(() => api.persons(), [addOpen], addOpen);

  useEffect(() => {
    if (!addOpen) return;
    setNewPersonId('');
    setPersonPickerOpen(false);
    setNewRole('developer');
  }, [addOpen]);

  const existingMemberIds = useMemo(
    () => new Set((detail.members ?? []).map((member) => member.personId)),
    [detail.members],
  );
  const availablePersons = useMemo(
    () => (persons.data ?? []).filter((item) => !existingMemberIds.has(item.id)),
    [persons.data, existingMemberIds],
  );
  const selectedPerson = availablePersons.find((item) => item.id === newPersonId);

  const handleAddMember = async () => {
    if (!newPersonId) return;
    setAdding(true);
    try {
      await api.addProjectMember(projectId, newPersonId, newRole);
      toast.success('成员已加入项目');
      setAddOpen(false);
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '添加成员失败，请重试');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.removeProjectMember(projectId, removeTarget.personId);
      toast.success('成员已移出项目');
      setRemoveTarget(null);
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '移除成员失败');
    } finally {
      setRemoving(false);
    }
  };

  const visibleMembers = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return (detail.members ?? []).filter((member) => (roleFilter === 'all' || member.role === roleFilter)
      && (!query || `${member.name}\n${member.email}`.toLowerCase().includes(query)));
  }, [detail.members, roleFilter, keyword]);

  const memberColumns: Column<ProjectMember>[] = [
    {
      key: 'member',
      header: '成员',
      width: 260,
      sortValue: (row) => row.name,
      render: (row) => (
        <div className="hstack gap-10">
          <Avatar name={row.name} tone="violet" />
          <div className="vstack" style={{ gap: 1, minWidth: 0 }}>
            <span className="strong truncate">{row.name}</span>
            <span className="tiny dim truncate">{row.email}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '项目角色',
      width: 140,
      sortValue: (row) => projectRoleLabel(row.role),
      render: (row) => <Badge tone="slate">{projectRoleLabel(row.role)}</Badge>,
    },
    {
      key: 'addedAt',
      header: '加入时间',
      width: 140,
      sortValue: (row) => row.addedAt,
      render: (row) => <span className="tiny dim">{fmtDate(row.addedAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      width: 100,
      sortable: false,
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" icon="trash" onClick={() => setRemoveTarget(row)}>
          移除
        </Button>
      ),
    },
  ];

  return (
    <div className="ws-page">
      <PageHead
        title="项目成员"
        desc="维护项目成员及角色。所有者可删除项目，维护者可管理智能体、提示卡与自动化，开发者可创建任务，观察者只读。"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            添加成员
          </Button>
        }
      />
      <Card>
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <SectionHead
            title={<><Icon name="users" size={14} /> 成员（{detail.members?.length ?? 0}）</>}
            desc="成员变更会立即影响项目权限；历史任务与记录会保留。"
          />
        </div>
        <div className="toolbar" style={{ padding: '10px 16px' }}>
          <div className="toolbar-left">
            <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索姓名或邮箱" />
            <Select
              value={roleFilter}
              options={[{ value: 'all', label: '全部角色' }, ...PROJECT_ROLE_OPTIONS]}
              onChange={(event) => setRoleFilter(event.target.value as 'all' | ProjectRole)}
              aria-label="按角色筛选"
              style={{ width: 140 }}
            />
            <span className="tiny dim">共 {visibleMembers.length} 人</span>
          </div>
        </div>
        <Table
          columns={memberColumns}
          rows={visibleMembers}
          sortable
          resizable
          rowKey={(row) => row.personId}
          empty={
            <EmptyState
              icon="users"
              title="暂无项目成员"
              description="添加成员后，他们可以在项目内创建任务并查看执行进展。"
              action={<Button size="sm" variant="outline" icon="plus" onClick={() => setAddOpen(true)}>添加成员</Button>}
              compact
            />
          }
        />
      </Card>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="添加项目成员"
        description="从组织成员中选择一位加入本项目。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>取消</Button>
            <Button variant="primary" loading={adding} disabled={!newPersonId} onClick={() => void handleAddMember()}>添加</Button>
          </>
        }
      >
        <Field label="成员" required hint="人员较多时可在对话框中搜索姓名、邮箱或职位。">
          {persons.loading && !persons.data ? (
            <Skeleton h={46} style={{ borderRadius: 10 }} />
          ) : persons.error ? (
            <Callout tone="red" icon="alert">加载成员列表失败：{persons.error}</Callout>
          ) : !availablePersons.length ? (
            <EmptyState icon="users" title="没有可添加的成员" description="组织内成员都已在项目中。" compact />
          ) : selectedPerson ? (
            <div className="ws-pick-item">
              <Avatar name={selectedPerson.name} tone={(selectedPerson.avatarColor as never) ?? 'violet'} size="sm" />
              <div className="ws-pick-main grow">
                <span className="ws-pick-name">{selectedPerson.name}</span>
                <span className="tiny dim">{selectedPerson.title || '—'} · {selectedPerson.email}</span>
              </div>
              <Button size="sm" variant="ghost" icon="users" onClick={() => setPersonPickerOpen(true)}>更换</Button>
            </div>
          ) : (
            <Button variant="outline" icon="users" onClick={() => setPersonPickerOpen(true)}>选择人员</Button>
          )}
          <PersonPicker
            open={personPickerOpen}
            people={availablePersons}
            teams={(teams.data ?? []).map((team) => ({ id: team.id, name: team.name }))}
            value={newPersonId}
            onClose={() => setPersonPickerOpen(false)}
            onSelect={(selected) => setNewPersonId(selected.id)}
          />
        </Field>
        <Field label="项目角色" required hint="所有者可删除项目，维护者可管理智能体、提示卡与自动化，开发者可创建任务，观察者只读。">
          <Select value={newRole} options={PROJECT_ROLE_OPTIONS} onChange={(event) => setNewRole(event.target.value as ProjectRole)} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void handleRemoveMember()}
        title="移除项目成员"
        description={`确认把「${removeTarget?.name ?? ''}」移出项目？其历史任务与记录会保留。`}
        confirmLabel="移除成员"
        loading={removing}
      />
    </div>
  );
}
