import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Person, Team } from '@shared';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHead,
  Select,
  Textarea,
  useToast,
} from '@ui';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { apiErrorMessage, CardGridSkeleton, errorText, useResource } from '../components/projects/helpers.tsx';
import { TeamCard } from '../components/teams/index.tsx';

/** 团队列表页：团队卡片与新建团队（仅管理员）。 */
export function TeamsPage() {
  const { person } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const isAdmin = Boolean(person?.isAdmin);

  const { data: teams, loading, error, status, reload } = useResource<Team[]>(() => api.teams(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const persons = useResource<Person[]>(() => api.persons(), [createOpen], createOpen);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [leadPersonId, setLeadPersonId] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const closeCreate = () => {
    setCreateOpen(false);
    setSubmitError(null);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      setSubmitError('请填写团队名称。');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await api.createTeam({
        name: name.trim(),
        description: description.trim() || undefined,
        leadPersonId: leadPersonId || undefined,
      });
      toast.success(`团队「${created.name}」已创建`);
      setName('');
      setDescription('');
      setLeadPersonId('');
      setCreateOpen(false);
      await reload();
    } catch (cause) {
      const message = apiErrorMessage(cause, '创建团队失败');
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const memberTotal = (teams ?? []).reduce((sum, team) => sum + team.memberCount, 0);

  return (
    <div className="page">
      <PageHead
        eyebrow="团队 · Teams"
        title="团队"
        desc="人员可属于多个团队；团队负责人可以创建项目，并把项目开放给团队成员。"
        actions={
          isAdmin ? (
            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
              新建团队
            </Button>
          ) : undefined
        }
      />

      <div className="row-between">
        <span className="tiny dim">
          共 {teams?.length ?? 0} 个团队 · {memberTotal} 人次成员关系
        </span>
        {!isAdmin ? <span className="tiny dim">仅组织管理员可新建团队</span> : null}
      </div>

      {loading && !teams ? (
        <CardGridSkeleton count={4} />
      ) : error && !teams ? (
        <ErrorState message={errorText(status, error, '团队')} onRetry={() => void reload()} />
      ) : (teams ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon="users"
            title="还没有团队"
            description={isAdmin ? '创建团队并指定负责人，把成员和项目组织起来。' : '你还没有加入任何团队，请联系组织管理员。'}
            action={
              isAdmin ? (
                <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                  新建团队
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid-cards">
          {(teams ?? []).map((team) => (
            <TeamCard key={team.id} team={team} onOpen={() => navigate(`/teams/${team.id}`)} />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="新建团队"
        description="团队负责人默认拥有团队项目管理权限。"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate}>
              取消
            </Button>
            <Button variant="primary" type="submit" form="create-team-form" loading={submitting} icon="plus">
              创建团队
            </Button>
          </>
        }
      >
        <form id="create-team-form" className="stack" style={{ gap: 14 }} onSubmit={handleCreate}>
          <Field label="团队名称" htmlFor="team-name" required>
            <Input
              id="team-name"
              value={name}
              placeholder="例如：研发一组"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field label="团队描述" htmlFor="team-description" hint="团队负责的业务范围与协作方式。">
            <Textarea
              id="team-description"
              rows={3}
              value={description}
              placeholder="这个团队负责什么？"
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <Field
            label="团队负责人"
            htmlFor="team-lead"
            hint={persons.error ? '人员列表暂不可用，可稍后在团队详情中设置。' : '负责人可管理团队成员与团队项目。'}
          >
            <Select
              id="team-lead"
              value={leadPersonId}
              onChange={(event) => setLeadPersonId(event.target.value)}
              options={[
                { value: '', label: persons.loading ? '正在加载人员…' : '暂不指定' },
                ...(persons.data ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.name} · ${item.title || item.email}`,
                })),
              ]}
            />
          </Field>

          {submitError ? (
            <Callout tone="red" icon="xCircle">
              {submitError}
            </Callout>
          ) : null}
        </form>
      </Modal>
    </div>
  );
}
