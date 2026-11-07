import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PromptCard, PromptCardCategory, PromptCardInput, PromptCardScope, ProjectSummary, Team } from '@shared';
import { PROMPT_CARD_CATEGORIES, PROMPT_CARD_SCOPES } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHead,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Table,
  Textarea,
  useToast,
  type Column,
  type Tone,
} from '@ui';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtRelative } from '../lib/format.ts';
import { useAsync } from '../lib/hooks.ts';

type EnabledFilter = 'all' | 'on' | 'off';

interface CardFormState {
  name: string;
  category: PromptCardCategory;
  description: string;
  content: string;
  scope: PromptCardScope;
  projectId: string;
  teamId: string;
  enabled: boolean;
}

function emptyForm(isAdmin: boolean): CardFormState {
  return {
    name: '',
    category: 'workflow',
    description: '',
    content: '',
    scope: isAdmin ? 'org' : 'project',
    projectId: '',
    teamId: '',
    enabled: true,
  };
}

function categoryMeta(category: string) {
  return PROMPT_CARD_CATEGORIES.find((item) => item.value === category) ?? { label: category, tone: 'slate' as Tone };
}

function scopeMeta(scope: string) {
  return PROMPT_CARD_SCOPES.find((item) => item.value === scope) ?? { label: scope, desc: '' };
}

function cardTarget(card: PromptCard): string | undefined {
  if (card.scope === 'org') return '全员';
  if (card.scope === 'project') return card.projectName;
  if (card.scope === 'team') return card.teamName;
  if (card.scope === 'person') return card.personName;
  return undefined;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * 提示卡：工作流 / 风格 / 标准 / 角色等可复用上下文。
 * 卡片可由任务引用，实际内容会注入 DSH 的任务提示词。
 */
export function PromptCardsPage() {
  const { person } = useAuth();
  const toast = useToast();
  const isAdmin = Boolean(person?.isAdmin);
  const cards = useAsync(() => api.promptCards(), []);
  const projects = useAsync(() => api.projects(), []);
  const teams = useAsync(() => api.teams(), []);
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | PromptCardCategory>('all');
  const [scope, setScope] = useState<'all' | PromptCardScope>('all');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [formOpen, setFormOpen] = useState(() => params.get('new') === '1');
  const [editing, setEditing] = useState<PromptCard | null>(null);
  const [form, setForm] = useState<CardFormState>(() => emptyForm(isAdmin));
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PromptCard | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (params.get('new') === '1') {
      setFormOpen(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const list = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (cards.data ?? []).filter((card) => {
      if (category !== 'all' && card.category !== category) return false;
      if (scope !== 'all' && card.scope !== scope) return false;
      if (enabledFilter === 'on' && !card.enabled) return false;
      if (enabledFilter === 'off' && card.enabled) return false;
      if (!keyword) return true;
      return [card.name, card.description, card.content, card.projectName ?? '', card.teamName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [cards.data, search, category, scope, enabledFilter]);

  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedList = useMemo(
    () => list.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [list, currentPage, pageSize],
  );
  useEffect(() => { setPage(1); }, [search, category, scope, enabledFilter, pageSize]);

  const scopeOptions = useMemo(
    () =>
      PROMPT_CARD_SCOPES.filter((item) => item.value !== 'org' || isAdmin).map((item) => ({
        value: item.value,
        label: item.label,
      })),
    [isAdmin],
  );

  const update = <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(isAdmin));
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (card: PromptCard) => {
    setEditing(card);
    setForm({
      name: card.name,
      category: card.category,
      description: card.description,
      content: card.content,
      scope: card.scope,
      projectId: card.projectId ?? '',
      teamId: card.teamId ?? '',
      enabled: card.enabled,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setFormError(null);
    if (params.get('new') === '1') setParams({}, { replace: true });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setFormError('请填写卡片名称。');
      return;
    }
    if (!form.content.trim()) {
      setFormError('请填写提示卡内容。');
      return;
    }
    if (form.scope === 'project' && !form.projectId) {
      setFormError('项目级提示卡需要选择项目。');
      return;
    }
    if (form.scope === 'team' && !form.teamId) {
      setFormError('团队级提示卡需要选择团队。');
      return;
    }

    const base: PromptCardInput = {
      name: form.name.trim(),
      category: form.category,
      description: form.description.trim(),
      content: form.content.trim(),
      enabled: form.enabled,
    };

    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        // scope / projectId / teamId 创建后不可修改，只更新内容与启用状态。
        await api.updatePromptCard(editing.id, {
          name: base.name,
          category: base.category,
          description: base.description,
          content: base.content,
          enabled: base.enabled,
        });
        toast.success(`提示卡「${base.name}」已更新`);
      } else {
        await api.createPromptCard({
          ...base,
          scope: form.scope,
          projectId: form.scope === 'project' ? form.projectId : undefined,
          teamId: form.scope === 'team' ? form.teamId : undefined,
        });
        toast.success(`提示卡「${base.name}」已创建`);
      }
      closeForm();
      await cards.refresh();
    } catch (cause) {
      const message = errorMessage(cause, editing ? '更新提示卡失败' : '创建提示卡失败');
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (card: PromptCard) => {
    setTogglingId(card.id);
    try {
      await api.updatePromptCard(card.id, { enabled: !card.enabled });
      toast.success(card.enabled ? `已停用「${card.name}」` : `已启用「${card.name}」`);
      await cards.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '切换卡片状态失败'));
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deletePromptCard(deleteTarget.id);
      toast.success(`提示卡「${deleteTarget.name}」已删除`);
      setDeleteTarget(null);
      await cards.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '删除提示卡失败'));
    } finally {
      setDeleting(false);
    }
  };

  const hasFilter =
    Boolean(search.trim()) || category !== 'all' || scope !== 'all' || enabledFilter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setCategory('all');
    setScope('all');
    setEnabledFilter('all');
  };

  const columns: Column<PromptCard>[] = [
    {
      key: 'name',
      header: '提示卡',
      render: (card) => {
        const meta = categoryMeta(card.category);
        return (
          <div className="hstack gap-8">
            <span className={`cx-metric-icon tone-${meta.tone}`}><Icon name="book" size={14} /></span>
            <div className="vstack gap-2" style={{ minWidth: 0 }}>
              <span className="strong truncate">{card.name}</span>
              <span className="tiny dim truncate">{card.description || '暂无说明'}</span>
            </div>
          </div>
        );
      },
    },
    {
      key: 'category',
      header: '类别',
      width: 105,
      render: (card) => {
        const meta = categoryMeta(card.category);
        return <Badge size="sm" tone={meta.tone as Tone}>{meta.label}</Badge>;
      },
    },
    {
      key: 'scope',
      header: '范围',
      width: 150,
      render: (card) => (
        <div className="vstack gap-2" style={{ minWidth: 0, alignItems: 'flex-start' }}>
          <Badge size="sm" tone={card.scope === 'org' ? 'violet' : card.scope === 'team' ? 'cyan' : card.scope === 'project' ? 'blue' : 'slate'}>{scopeMeta(card.scope).label}</Badge>
          <span className="tiny dim truncate">{cardTarget(card) || '—'}</span>
        </div>
      ),
    },
    {
      key: 'content',
      header: '内容',
      render: (card) => <span className="prompt-card-preview" title={card.content}>{card.content}</span>,
    },
    {
      key: 'enabled',
      header: '状态',
      width: 100,
      render: (card) => (
        <div className="hstack gap-6" onClick={(event) => event.stopPropagation()}>
          <Switch checked={card.enabled} disabled={togglingId === card.id} onChange={() => void handleToggle(card)} />
          <span className="tiny dim">{card.enabled ? '启用' : '停用'}</span>
        </div>
      ),
      sortValue: (card) => (card.enabled ? 1 : 0),
    },
    {
      key: 'updatedAt',
      header: '最近更新',
      width: 135,
      render: (card) => (
        <div className="vstack gap-2">
          <span className="tiny dim">{fmtRelative(card.updatedAt)}</span>
          <span className="tiny dim truncate">{card.createdByName || '—'}</span>
        </div>
      ),
      sortValue: (card) => Date.parse(card.updatedAt) || 0,
    },
    {
      key: 'actions',
      header: '操作',
      width: 96,
      align: 'right',
      render: (card) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }} onClick={(event) => event.stopPropagation()}>
          <IconButton icon="pencil" label={`编辑 ${card.name}`} size="sm" onClick={() => openEdit(card)} />
          <IconButton icon="trash" label={`删除 ${card.name}`} size="sm" onClick={() => setDeleteTarget(card)} />
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="提示卡 · Prompt Cards"
        title="提示卡"
        desc="把工作流、工作风格、质量标准与角色说明沉淀成卡片；任务引用后，卡片内容会注入 DSH 提示词。"
        actions={
          <>
            <IconButton icon="refresh" label="刷新提示卡" onClick={() => void cards.refresh()} />
            <Button variant="primary" icon="plus" onClick={openCreate}>
              新建卡片
            </Button>
          </>
        }
      />

      <div className="cx-filter-bar">
        <div className="cx-filter-left">
          <SearchInput value={search} onChange={setSearch} placeholder="搜索名称、内容或项目…" />
          <Select
            value={category}
            style={{ width: 150 }}
            options={[
              { value: 'all', label: '全部类别' },
              ...PROMPT_CARD_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
            ]}
            onChange={(event) => setCategory(event.target.value as 'all' | PromptCardCategory)}
          />
          <Select
            value={scope}
            style={{ width: 150 }}
            options={[
              { value: 'all', label: '全部范围' },
              ...PROMPT_CARD_SCOPES.map((item) => ({ value: item.value, label: item.label })),
            ]}
            onChange={(event) => setScope(event.target.value as 'all' | PromptCardScope)}
          />
          <Segmented<EnabledFilter>
            value={enabledFilter}
            onChange={setEnabledFilter}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
          {hasFilter ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>
        <span className="tiny dim">共 {list.length} 张卡片</span>
      </div>

      {cards.error && !cards.data ? (
        <Card><div style={{ padding: 18 }}><ErrorState message={cards.error} onRetry={() => void cards.refresh()} /></div></Card>
      ) : (
        <Card>
          <Table
            columns={columns}
            rows={pagedList}
            rowKey={(card) => card.id}
            sortable
            resizable
            loading={cards.loading && !cards.data}
            empty={
              hasFilter ? (
                <EmptyState
                  icon="filter"
                  title="没有匹配的提示卡"
                  description="试试其他关键词、类别或范围筛选。"
                  compact
                  action={<Button size="sm" onClick={clearFilters}>清除筛选</Button>}
                />
              ) : (
                <EmptyState
                  icon="book"
                  title="还没有提示卡"
                  description="创建第一张卡片，把可复用的工作方式沉淀下来。"
                  action={<Button size="sm" variant="primary" icon="plus" onClick={openCreate}>新建卡片</Button>}
                />
              )
            }
          />
          {!cards.loading && list.length > 0 ? (
            <div className="ws-table-foot">
              <Pagination
                page={currentPage}
                totalPages={totalPages}
                total={list.length}
                pageSize={pageSize}
                pageSizeOptions={[
                  { value: '10', label: '每页 10 行' },
                  { value: '20', label: '每页 20 行' },
                  { value: '50', label: '每页 50 行' },
                ]}
                onPageSizeChange={setPageSize}
                onChange={setPage}
              />
            </div>
          ) : null}
        </Card>
      )}

      <Modal
        open={formOpen}
        onClose={closeForm}
        title={editing ? '编辑提示卡' : '新建提示卡'}
        description={
          editing
            ? '卡片范围创建后不可修改；可更新名称、类别、说明、内容与启用状态。'
            : '卡片会按范围注入引用它的任务内容。'
        }
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              取消
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="prompt-card-form"
              loading={submitting}
              icon={editing ? 'check' : 'plus'}
            >
              {editing ? '保存修改' : '创建卡片'}
            </Button>
          </>
        }
      >
        <form id="prompt-card-form" className="stack" style={{ gap: 14 }} onSubmit={handleSubmit}>
          <div className="grid grid-2">
            <Field label="卡片名称" htmlFor="prompt-card-name" required>
              <Input
                id="prompt-card-name"
                value={form.name}
                autoFocus
                placeholder="例如：功能开发工作流"
                onChange={(event) => update('name', event.target.value)}
              />
            </Field>
            <Field label="类别" htmlFor="prompt-card-category">
              <Select
                id="prompt-card-category"
                value={form.category}
                options={PROMPT_CARD_CATEGORIES.map((item) => ({ value: item.value, label: item.label }))}
                onChange={(event) => update('category', event.target.value as PromptCardCategory)}
              />
            </Field>
          </div>

          <div className="grid grid-2">
            <Field
              label="适用范围"
              htmlFor="prompt-card-scope"
              hint={
                editing
                  ? '范围创建后不可修改。'
                  : form.scope === 'org'
                    ? '组织范围仅管理员可创建。'
                    : form.scope === 'team'
                      ? '团队级卡片由团队负责人维护。'
                      : form.scope === 'project'
                        ? '项目级卡片仅指定项目可引用。'
                        : '个人级卡片仅本人可引用。'
              }
            >
              <Select
                id="prompt-card-scope"
                value={form.scope}
                disabled={Boolean(editing)}
                options={scopeOptions}
                onChange={(event) => {
                  const next = event.target.value as PromptCardScope;
                  setForm((prev) => ({ ...prev, scope: next, projectId: '', teamId: '' }));
                }}
              />
            </Field>

            {form.scope === 'project' ? (
              <Field label="选择项目" htmlFor="prompt-card-project" required>
                <Select
                  id="prompt-card-project"
                  value={form.projectId}
                  disabled={Boolean(editing)}
                  options={[
                    { value: '', label: '选择项目…' },
                    ...(projects.data ?? []).map((project: ProjectSummary) => ({
                      value: project.id,
                      label: project.name,
                    })),
                  ]}
                  onChange={(event) => update('projectId', event.target.value)}
                />
              </Field>
            ) : form.scope === 'team' ? (
              <Field label="选择团队" htmlFor="prompt-card-team" required>
                <Select
                  id="prompt-card-team"
                  value={form.teamId}
                  disabled={Boolean(editing)}
                  options={[
                    { value: '', label: '选择团队…' },
                    ...(teams.data ?? []).map((team: Team) => ({ value: team.id, label: team.name })),
                  ]}
                  onChange={(event) => update('teamId', event.target.value)}
                />
              </Field>
            ) : form.scope === 'person' ? (
              <Field label="可见范围" hint="个人级卡片只属于当前账号，不共享给其他人。">
                <Input value={`${person?.name ?? '当前人员'}（仅本人）`} disabled readOnly />
              </Field>
            ) : (
              <Field label="可见范围" hint="组织级卡片对全员所有项目可引用。">
                <Input value="组织级（全员可引用）" disabled readOnly />
              </Field>
            )}
          </div>

          <Field label="说明" htmlFor="prompt-card-desc" hint="一句话说明这张卡片解决什么问题。">
            <Input
              id="prompt-card-desc"
              value={form.description}
              placeholder="例如：从需求到交付的标准开发步骤"
              onChange={(event) => update('description', event.target.value)}
            />
          </Field>

          <Field
            label="提示卡内容"
            htmlFor="prompt-card-content"
            required
            hint="任务引用后作为上下文注入 DSH 提示词；建议写清步骤、标准与禁止事项。"
          >
            <Textarea
              id="prompt-card-content"
              rows={8}
              value={form.content}
              placeholder={'例如：\n1. 先阅读项目提示词与相关文件；\n2. 在 feature/* 分支实现；\n3. 运行测试并输出结果；\n4. 输出变更摘要与风险。'}
              onChange={(event) => update('content', event.target.value)}
            />
          </Field>

          <div className="hstack gap-10">
            <Switch checked={form.enabled} onChange={(next) => update('enabled', next)} label="启用卡片" />
          </div>

          {formError ? (
            <Callout tone="red" icon="xCircle">
              {formError}
            </Callout>
          ) : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        loading={deleting}
        title="删除提示卡"
        description={
          deleteTarget
            ? `确认删除「${deleteTarget.name}」？引用该卡片的任务不会被回滚，但后续任务将无法再选择它。`
            : undefined
        }
        confirmLabel="删除卡片"
      />
    </div>
  );
}
