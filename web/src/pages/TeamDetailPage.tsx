import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Person, TeamMember, TeamRole } from '@shared';
import { TEAM_ROLES } from '@shared';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Modal,
  PageHead,
  SectionHead,
  Select,
  Skeleton,
  Table,
  useToast,
  type Column,
} from '@ui';
import { api, type TeamDetail } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate } from '../lib/format.ts';
import {
  apiErrorMessage,
  CardGridSkeleton,
  errorText,
  toneFor,
  useResource,
} from '../components/projects/helpers.tsx';
import { ProjectCard } from '../components/projects/index.tsx';
import { PersonPicker } from '../components/people/PersonPicker.tsx';

/** 团队详情：成员管理 + 团队项目。负责人 / 组织管理员可增删成员。 */
export function TeamDetailPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const { person } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const { data, loading, error, status, reload } = useResource<TeamDetail>(
    () => api.team(teamId ?? ''),
    [teamId],
    Boolean(teamId),
  );

  const [addOpen, setAddOpen] = useState(false);
  const [addPersonId, setAddPersonId] = useState('');
  const [personPickerOpen, setPersonPickerOpen] = useState(false);
  const [addRole, setAddRole] = useState<TeamRole>('member');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState(false);

  const persons = useResource<Person[]>(() => api.persons(), [addOpen], addOpen);
  const team = data?.team;
  const members = data?.members ?? [];
  const projects = data?.projects ?? [];
  const canManage = Boolean(person?.isAdmin || (team && person?.id === team.leadPersonId));
  const memberIds = new Set(members.map((member) => member.personId));
  const candidates = (persons.data ?? []).filter((item) => !memberIds.has(item.id));
  const selectedCandidate = candidates.find((item) => item.id === addPersonId);

  const openAdd = () => {
    setAddError(null);
    setAddPersonId('');
    setPersonPickerOpen(false);
    setAddRole('member');
    setAddOpen(true);
  };

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!team) return;
    const candidate = candidates.find((item) => item.id === addPersonId);
    if (!candidate) {
      setAddError('请选择要添加的成员。');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await api.addTeamMember(team.id, candidate.id, addRole);
      toast.success(`${candidate.name} 已加入团队`);
      setAddOpen(false);
      await reload();
    } catch (cause) {
      const message = apiErrorMessage(cause, '添加成员失败');
      setAddError(message);
      toast.error(message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async () => {
    if (!team || !removeTarget) return;
    setRemoving(true);
    try {
      await api.removeTeamMember(team.id, removeTarget.personId);
      toast.success(`${removeTarget.name} 已移出团队`);
      setRemoveTarget(null);
      await reload();
    } catch (cause) {
      toast.error(apiErrorMessage(cause, '移除成员失败'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="page">
        <Skeleton w="30%" h={26} />
        <Skeleton w="55%" h={14} />
        <div className="card card-pad">
          <Skeleton h={64} />
        </div>
        <CardGridSkeleton count={3} />
      </div>
    );
  }

  if (status === 404) {
    return (
      <div className="page">
        <EmptyState
          icon="users"
          title="团队不存在"
          description="该团队可能已被删除。"
          action={
            <Link to="/teams" className="btn btn-secondary btn-sm">
              返回团队列表
            </Link>
          }
        />
      </div>
    );
  }

  if (error || !data || !team) {
    return (
      <div className="page">
        <ErrorState message={errorText(status, error, '团队')} onRetry={() => void reload()} />
      </div>
    );
  }

  const memberColumns: Column<TeamMember>[] = [
    {
      key: 'name',
      header: '成员',
      render: (member) => (
        <div className="hstack gap-10">
          <Avatar name={member.name} tone={toneFor(member.personId)} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="cell-strong truncate">{member.name}</div>
            <div className="tiny dim truncate">{member.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色',
      width: 120,
      render: (member) => (
        <Badge size="sm" tone={member.role === 'lead' ? 'amber' : 'slate'}>
          {roleLabel(member.role)}
        </Badge>
      ),
    },
    {
      key: 'joinedAt',
      header: '加入时间',
      width: 140,
      mono: true,
      render: (member) => fmtDate(member.joinedAt),
    },
    {
      key: 'actions',
      header: '',
      width: 64,
      align: 'right',
      render: (member) =>
        canManage ? (
          <span className="cx-row-actions">
            <IconButton icon="trash" label={`移除 ${member.name}`} size="sm" onClick={() => setRemoveTarget(member)} />
          </span>
        ) : null,
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow={
          <Link to="/teams" className="cx-crumb-link">
            ← 团队
          </Link>
        }
        title={team.name}
        desc={team.description || '暂无团队描述'}
        actions={canManage ? <Button variant="primary" icon="plus" onClick={openAdd}>添加成员</Button> : undefined}
      />

      <Card pad className="cx-team-hero">
        <div className="cx-meta-grid">
          <div className="metric">
            <span className="metric-label">负责人</span>
            <span className="metric-value hstack gap-6">
              {team.leadName ? (
                <>
                  <Avatar name={team.leadName} tone={toneFor(team.leadName)} size="sm" />
                  {team.leadName}
                </>
              ) : (
                <span className="dim">未指派</span>
              )}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">成员</span>
            <span className="metric-value">{team.memberCount} 人</span>
          </div>
          <div className="metric">
            <span className="metric-label">项目</span>
            <span className="metric-value">{team.projectCount} 个</span>
          </div>
          <div className="metric">
            <span className="metric-label">创建时间</span>
            <span className="metric-value mono">{fmtDate(team.createdAt)}</span>
          </div>
        </div>
        <div className="tiny dim" style={{ marginTop: 12 }}>
          团队标识 <span className="mono">{team.slug}</span>
          {canManage ? ' · 你可以管理该团队成员' : ' · 仅负责人或组织管理员可管理成员'}
        </div>
      </Card>

      <section className="cx-section">
        <SectionHead
          title="团队成员"
          desc={`共 ${members.length} 位成员`}
          actions={
            canManage ? (
              <Button size="sm" variant="ghost" icon="plus" onClick={openAdd}>
                添加成员
              </Button>
            ) : undefined
          }
        />
        <Card>
          <Table
            columns={memberColumns}
            rows={members}
            rowKey={(member) => member.personId}
            empty={<EmptyState compact icon="users" title="暂无成员" description="添加成员后可共同管理团队项目。" />}
          />
        </Card>
      </section>

      <section className="cx-section">
        <SectionHead
          title="团队项目"
          desc={`共 ${projects.length} 个项目`}
          actions={
            <Link to="/projects" className="btn btn-ghost btn-sm">
              全部项目
            </Link>
          }
        />
        {projects.length ? (
          <div className="cx-project-grid cx-project-grid--team">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                showTeam={false}
                onOpen={() => navigate(`/projects/${project.id}`)}
              />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              compact
              icon="folder"
              title="团队还没有项目"
              description="创建项目并归属该团队，团队成员即可按可见性访问。"
            />
          </Card>
        )}
      </section>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="添加团队成员"
        description="成员加入后可访问可见性为团队的项目。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" form="add-team-member-form" loading={adding} icon="plus">
              添加成员
            </Button>
          </>
        }
      >
        <form id="add-team-member-form" className="stack" style={{ gap: 14 }} onSubmit={handleAdd}>
          <Field
            label="选择人员"
            htmlFor="team-member-person"
            required
            hint={
              persons.error
                ? '人员列表暂不可用，请稍后重试。'
                : persons.loading
                  ? '正在加载组织成员…'
                  : candidates.length === 0
                    ? '所有人员都已在团队中。'
                    : undefined
            }
          >
            {selectedCandidate ? (
              <div className="ws-pick-item">
                <Avatar name={selectedCandidate.name} tone={toneFor(selectedCandidate.email)} size="sm" />
                <div className="ws-pick-main grow">
                  <span className="ws-pick-name">{selectedCandidate.name}</span>
                  <span className="tiny dim">{selectedCandidate.title || '—'} · {selectedCandidate.email}</span>
                </div>
                <Button size="sm" variant="ghost" icon="users" onClick={() => setPersonPickerOpen(true)}>更换</Button>
              </div>
            ) : (
              <Button variant="outline" icon="users" onClick={() => setPersonPickerOpen(true)}>选择人员</Button>
            )}
            <PersonPicker
              open={personPickerOpen}
              people={candidates}
              value={addPersonId}
              loading={persons.loading && !persons.data}
              onClose={() => setPersonPickerOpen(false)}
              onSelect={(selected) => setAddPersonId(selected.id)}
            />
          </Field>

          <Field label="团队角色" htmlFor="team-member-role" hint="团队负责人可管理团队项目。">
            <Select
              id="team-member-role"
              value={addRole}
              onChange={(event) => setAddRole(event.target.value as TeamRole)}
              options={TEAM_ROLES.map((role) => ({ value: role.value, label: role.label }))}
            />
          </Field>

          {addError ? (
            <Callout tone="red" icon="xCircle">
              {addError}
            </Callout>
          ) : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void handleRemove()}
        loading={removing}
        title="移除团队成员"
        description={removeTarget ? `确定将 ${removeTarget.name} 从「${team.name}」移除？该成员将失去团队可见性项目的访问权限。` : undefined}
        confirmLabel="移除成员"
      />
    </div>
  );
}

function roleLabel(role: TeamRole): string {
  return TEAM_ROLES.find((item) => item.value === role)?.label ?? role;
}
