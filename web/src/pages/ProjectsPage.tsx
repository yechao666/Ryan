import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ProjectSummary, ProjectType, Team, Visibility } from '@shared';
import { PROJECT_TYPES, VISIBILITIES } from '@shared';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHead,
  SearchInput,
  Segmented,
  Select,
  Textarea,
  useToast,
} from '@ui';
import { api } from '../lib/api.ts';
import { useDebounced } from '../lib/hooks.ts';
import { apiErrorMessage, CardGridSkeleton, errorText, useResource } from '../components/projects/helpers.tsx';
import { ProjectCard } from '../components/projects/index.tsx';

type VisibilityFilter = 'all' | Visibility;

interface ProjectFormState {
  name: string;
  description: string;
  ownerTeamId: string;
  visibility: Visibility;
  type: ProjectType;
  prompt: string;
  repoUrl: string;
  mnemosProjectId: string;
  mnemosApiKey: string;
}

const EMPTY_FORM: ProjectFormState = {
  name: '',
  description: '',
  ownerTeamId: '',
  visibility: 'private',
  type: 'manual',
  prompt: '',
  repoUrl: '',
  mnemosProjectId: '',
  mnemosApiKey: '',
};

/** 项目列表页：搜索 + 可见性筛选 + 新建项目。 */
export function ProjectsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const createOpen = params.get('new') === '1';

  const { data: projects, loading, error, status, reload } = useResource<ProjectSummary[]>(() => api.projects(), []);
  const teamsRes = useResource<Team[]>(() => api.teams(), [createOpen], createOpen);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 200);
  const [visibility, setVisibility] = useState<VisibilityFilter>('all');
  const [form, setForm] = useState<ProjectFormState>(EMPTY_FORM);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const filtered = useMemo(() => {
    const list = projects ?? [];
    const keyword = debouncedSearch.trim().toLowerCase();
    return list.filter((project) => {
      if (visibility !== 'all' && project.visibility !== visibility) return false;
      if (!keyword) return true;
      return [project.name, project.slug, project.description, project.ownerTeamName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [projects, debouncedSearch, visibility]);

  const openCreate = () => {
    setSubmitError(null);
    setParams({ new: '1' });
  };
  const closeCreate = () => {
    setSubmitError(null);
    setParams({}, { replace: true });
  };

  const update = <K extends keyof ProjectFormState>(key: K, value: ProjectFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setSubmitError('请填写项目名称。');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await api.createProject({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        ownerTeamId: form.ownerTeamId || undefined,
        visibility: form.visibility,
        type: form.type,
        prompt: form.prompt.trim() || undefined,
        repoUrl: form.type === 'manual' ? undefined : form.repoUrl.trim() || undefined,
        mnemosProjectId: form.mnemosProjectId.trim() || undefined,
        mnemosApiKey: form.mnemosApiKey.trim() || undefined,
      });
      toast.success(`项目「${created.name}」已创建`);
      setForm(EMPTY_FORM);
      setParams({}, { replace: true });
      await reload();
      navigate(`/projects/${created.id}`);
    } catch (cause) {
      const message = apiErrorMessage(cause, '创建项目失败');
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const resetFilters = () => {
    setSearch('');
    setVisibility('all');
  };

  const hasFilter = debouncedSearch.trim().length > 0 || visibility !== 'all';

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · Projects"
        title="项目"
        desc="项目是智员协作的空间：可见性决定谁能看到，团队决定谁可以加入。"
        actions={
          <>
            <IconButton icon="refresh" label="刷新项目" onClick={() => void reload()} />
            <Button variant="primary" icon="plus" onClick={openCreate}>
              新建项目
            </Button>
          </>
        }
      />

      <div className="cx-filter-bar">
        <div className="cx-filter-left">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索项目名称、描述或团队…" />
          <Segmented<VisibilityFilter>
            value={visibility}
            onChange={setVisibility}
            options={[
              { value: 'all', label: '全部' },
              ...VISIBILITIES.map((item) => ({ value: item.value as VisibilityFilter, label: item.label })),
            ]}
          />
        </div>
        <span className="tiny dim">共 {filtered.length} 个项目</span>
      </div>

      {loading && !projects ? (
        <CardGridSkeleton count={6} />
      ) : error && !projects ? (
        <ErrorState message={errorText(status, error, '项目')} onRetry={() => void reload()} />
      ) : filtered.length === 0 ? (
        hasFilter ? (
          <Card>
            <EmptyState
              compact
              icon="search"
              title="没有匹配的项目"
              description="试试其他关键词，或切换可见性筛选。"
              action={
                <Button size="sm" onClick={resetFilters}>
                  清除筛选
                </Button>
              }
            />
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon="folder"
              title="还没有项目"
              description="创建第一个项目，把智员、任务与项目记忆组织到一起。"
              action={
                <Button variant="primary" icon="plus" onClick={openCreate}>
                  新建项目
                </Button>
              }
            />
          </Card>
        )
      ) : (
        <div className="grid-cards">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} onOpen={() => navigate(`/projects/${project.id}`)} />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="新建项目"
        description="创建后可在项目工作区关联智员、创建任务与配置记忆。"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate}>
              取消
            </Button>
            <Button variant="primary" type="submit" form="create-project-form" loading={submitting} icon="plus">
              创建项目
            </Button>
          </>
        }
      >
        <form id="create-project-form" className="stack" style={{ gap: 14 }} onSubmit={handleCreate}>
          <Field label="项目名称" htmlFor="project-name" required>
            <Input
              id="project-name"
              value={form.name}
              placeholder="例如：Orion 智能代码助手"
              autoFocus
              onChange={(event) => update('name', event.target.value)}
            />
          </Field>

          <Field label="项目描述" htmlFor="project-description" hint="一句话说明项目目标与协作方式。">
            <Textarea
              id="project-description"
              rows={3}
              value={form.description}
              placeholder="这个项目要解决什么问题？"
              onChange={(event) => update('description', event.target.value)}
            />
          </Field>

          <Field
            label="项目提示词"
            hint="项目基本面：目标、规范、约束。领取任务时由 dsh-hive-runtime 注入 DSH 提示词。"
          >
            <Textarea
              rows={4}
              value={form.prompt}
              placeholder="例如：这是 Python/FastAPI 订单服务；幂等键必须绑定业务单号；迁移先 staging 验证。"
              onChange={(event) => update('prompt', event.target.value)}
            />
          </Field>

          <div className="grid grid-2">
            <Field
              label="归属团队"
              htmlFor="project-team"
              hint={teamsRes.error ? '团队列表暂不可用，可创建个人项目。' : '不选择则创建个人项目。'}
            >
              <Select
                id="project-team"
                value={form.ownerTeamId}
                onChange={(event) => update('ownerTeamId', event.target.value)}
                options={[
                  { value: '', label: '不归属团队（个人项目）' },
                  ...(teamsRes.data ?? []).map((team) => ({ value: team.id, label: team.name })),
                ]}
              />
            </Field>

            <Field label="可见性" htmlFor="project-visibility">
              <Select
                id="project-visibility"
                value={form.visibility}
                onChange={(event) => update('visibility', event.target.value as Visibility)}
                options={VISIBILITIES.map((item) => ({ value: item.value, label: item.label }))}
              />
            </Field>
          </div>

          <div className="grid grid-2">
            <Field label="项目类型" htmlFor="project-type">
              <Select
                id="project-type"
                value={form.type}
                onChange={(event) => update('type', event.target.value as ProjectType)}
                options={PROJECT_TYPES.map((item) => ({ value: item.value, label: item.label }))}
              />
            </Field>

            {form.type === 'manual' ? (
              <Field label="仓库地址" hint="手动项目无需仓库；选择 GitHub / GitLab 后可填写。">
                <Input value="" placeholder="—" readOnly disabled />
              </Field>
            ) : (
              <Field
                label="仓库地址"
                htmlFor="project-repo"
                hint={
                form.type === 'github'
                  ? '例如：https://github.com/org/repo'
                  : form.type === 'gitlab'
                    ? '例如：https://gitlab.com/group/repo'
                    : '本地仓库绝对路径，例如：/Users/you/code/demo'
              }
              >
                <Input
                  id="project-repo"
                  value={form.repoUrl}
                  placeholder={
                    form.type === 'github'
                      ? 'https://github.com/org/repo'
                      : form.type === 'gitlab'
                        ? 'https://gitlab.com/group/repo'
                        : '/Users/you/code/demo'
                  }
                  onChange={(event) => update('repoUrl', event.target.value)}
                />
              </Field>
            )}
          </div>

          <div className="divider" />

          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="card-title">
                <Icon name="brain" size={15} />
                项目记忆（可选）
              </div>
              <div className="card-sub">接入 Mnemos 后，项目记忆可在任务中搜索与写回。</div>
            </div>

            <div className="grid grid-2">
              <Field label="Mnemos 项目 ID" htmlFor="project-mnemos-id">
                <Input
                  id="project-mnemos-id"
                  value={form.mnemosProjectId}
                  placeholder="prj_orion_python"
                  onChange={(event) => update('mnemosProjectId', event.target.value)}
                />
              </Field>
              <Field label="Mnemos API Key" htmlFor="project-mnemos-key" hint="只保存在服务端，不会回显。">
                <Input
                  id="project-mnemos-key"
                  type="password"
                  value={form.mnemosApiKey}
                  placeholder="粘贴 API Key"
                  autoComplete="new-password"
                  onChange={(event) => update('mnemosApiKey', event.target.value)}
                />
              </Field>
            </div>
          </div>

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
