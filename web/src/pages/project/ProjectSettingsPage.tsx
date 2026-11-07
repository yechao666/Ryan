import { useEffect, useMemo, useState } from 'react';
import type { DshInstance, ProjectMember, ProjectRole, ProjectType, Visibility } from '@shared';
import { PROJECT_TYPES, VISIBILITIES } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDate, fmtMs } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHead,
  SectionHead,
  Select,
  Skeleton,
  Table,
  Textarea,
  useToast,
  type Column,
  type Tone,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';
import {
  PROJECT_ROLE_OPTIONS,
  projectRoleLabel,
  projectTypeMeta,
  visibilityMeta,
} from '../../components/project/meta.ts';

const VISIBILITY_OPTIONS = VISIBILITIES.map((item) => ({ value: item.value, label: item.label }));
const TYPE_OPTIONS = PROJECT_TYPES.map((item) => ({ value: item.value, label: item.label }));

interface BasicForm {
  name: string;
  description: string;
  visibility: Visibility;
  type: ProjectType;
  prompt: string;
  repoUrl: string;
  ownerTeamId: string;
}

/** 项目设置：基本信息、Mnemos 集成、成员与危险操作。 */
export function ProjectSettingsPage() {
  const { detail, reload } = useProject();
  const projectId = detail.project.id;
  const { person } = useAuth();
  const toast = useToast();

  const teams = useAsync(() => api.teams(), []);
  const services = useAsync(() => api.instances(), []);
  const [form, setForm] = useState<BasicForm>({
    name: detail.project.name,
    description: detail.project.description ?? '',
    visibility: detail.project.visibility,
    type: detail.project.type,
    prompt: detail.project.prompt ?? '',
    repoUrl: detail.project.repoUrl ?? '',
    ownerTeamId: detail.project.ownerTeamId ?? '',
  });
  const [savingBasic, setSavingBasic] = useState(false);

  const [serviceIds, setServiceIds] = useState<string[]>(detail.project.serviceIds ?? []);
  const [savingServices, setSavingServices] = useState(false);

  useEffect(() => {
    setServiceIds(detail.project.serviceIds ?? []);
  }, [detail.project.id, detail.project.serviceIds]);

  const [mnemosProjectId, setMnemosProjectId] = useState(detail.project.mnemosProjectId ?? '');
  const [mnemosApiKey, setMnemosApiKey] = useState('');
  const [savingMnemos, setSavingMnemos] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: Tone; text: string } | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newPersonId, setNewPersonId] = useState('');
  const [newRole, setNewRole] = useState<ProjectRole>('developer');
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);
  const [removing, setRemoving] = useState(false);

  const persons = useAsync(() => api.persons(), [addOpen], addOpen);

  // 项目详情刷新后同步表单（保存成功后回填最新值）。
  useEffect(() => {
    setForm({
      name: detail.project.name,
      description: detail.project.description ?? '',
      visibility: detail.project.visibility,
      type: detail.project.type,
      prompt: detail.project.prompt ?? '',
      repoUrl: detail.project.repoUrl ?? '',
      ownerTeamId: detail.project.ownerTeamId ?? '',
    });
    setMnemosProjectId(detail.project.mnemosProjectId ?? '');
  }, [detail.project]);

  useEffect(() => {
    if (!addOpen) return;
    setNewPersonId('');
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

  useEffect(() => {
    if (!addOpen || newPersonId) return;
    if (availablePersons[0]) setNewPersonId(availablePersons[0].id);
  }, [addOpen, newPersonId, availablePersons]);

  const teamOptions = useMemo(
    () => [{ value: '', label: '不归属团队' }, ...(teams.data ?? []).map((team) => ({ value: team.id, label: team.name }))],
    [teams.data],
  );

  const isOwnerOrAdmin = Boolean(person?.isAdmin) || detail.project.ownerPersonId === person?.id;

  const handleSaveBasic = async () => {
    if (!form.name.trim()) {
      toast.error('项目名称不能为空');
      return;
    }
    setSavingBasic(true);
    try {
      await api.updateProject(projectId, {
        name: form.name.trim(),
        description: form.description.trim(),
        visibility: form.visibility,
        type: form.type,
        prompt: form.prompt,
        repoUrl: form.repoUrl.trim() || undefined,
        ownerTeamId: form.ownerTeamId || undefined,
      });
      toast.success('项目信息已保存');
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存项目信息失败，请重试');
    } finally {
      setSavingBasic(false);
    }
  };

  const handleSaveServices = async () => {
    setSavingServices(true);
    try {
      await api.updateProjectServices(projectId, serviceIds);
      toast.success('项目服务绑定已保存');
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存项目服务绑定失败');
    } finally {
      setSavingServices(false);
    }
  };

  const toggleService = (serviceId: string) => {
    setServiceIds((current) => (
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId]
    ));
  };

  const handleSaveMnemos = async () => {
    setSavingMnemos(true);
    try {
      await api.updateProject(projectId, {
        mnemosProjectId: mnemosProjectId.trim(),
        mnemosApiKey: mnemosApiKey.trim() || undefined,
      });
      setMnemosApiKey('');
      toast.success('Mnemos 集成配置已保存');
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存 Mnemos 配置失败');
    } finally {
      setSavingMnemos(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.memorySearch(projectId, '测试记忆连接', undefined, 3);
      if (result.configured) {
        setTestResult({
          tone: 'green',
          text: `记忆检索正常：命中 ${result.hits.length} 条，耗时 ${fmtMs(result.tookMs)}。`,
        });
      } else {
        setTestResult({
          tone: 'amber',
          text: result.error ?? 'Mnemos 尚未就绪，请检查项目 ID 与 API Key。',
        });
      }
    } catch (cause) {
      setTestResult({
        tone: 'red',
        text: cause instanceof Error ? cause.message : '测试搜索失败，请检查集成配置。',
      });
    } finally {
      setTesting(false);
    }
  };

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

  const memberColumns: Column<ProjectMember>[] = [
    {
      key: 'member',
      header: '成员',
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
      render: (row) => <Badge tone="slate">{projectRoleLabel(row.role)}</Badge>,
    },
    {
      key: 'addedAt',
      header: '加入时间',
      render: (row) => <span className="tiny dim">{fmtDate(row.addedAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (row) => (
        <IconButton
          icon="trash"
          label={`移除 ${row.name}`}
          size="sm"
          onClick={() => setRemoveTarget(row)}
        />
      ),
    },
  ];

  const visibility = visibilityMeta(form.visibility);
  const type = projectTypeMeta(form.type);

  return (
    <div className="ws-page">
      <PageHead title="项目设置" desc="维护项目基本信息、记忆集成与成员权限。工作区由 DSH 服务按项目 ID 自动生成，不需要配置。" />

      <div className="ws-settings-stack">
        <Card className="card-pad">
          <SectionHead
            title={
              <>
                <Icon name="settings" size={14} />
                基本信息
              </>
            }
            desc="项目名称、可见性与仓库信息会展示在项目工作区头部与项目列表。"
            actions={
              <div className="hstack gap-6">
                <Badge tone={visibility.tone} size="sm">
                  {visibility.label}
                </Badge>
                <Badge tone={type.tone} size="sm">
                  {type.label}
                </Badge>
              </div>
            }
          />
          <div className="ws-form-grid mt-12">
            <Field label="项目名称" required>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </Field>
            <Field label="可见性" hint={visibility.desc}>
              <Select
                value={form.visibility}
                options={VISIBILITY_OPTIONS}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, visibility: event.target.value as Visibility }))
                }
              />
            </Field>
            <Field label="项目类型">
              <Select
                value={form.type}
                options={TYPE_OPTIONS}
                onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value as ProjectType }))}
              />
            </Field>
            <Field
              label="归属团队"
              hint={
                teams.error
                  ? `团队列表加载失败：${teams.error}`
                  : teams.loading && !teams.data
                    ? '团队加载中…'
                    : undefined
              }
            >
              <Select
                value={form.ownerTeamId}
                options={teamOptions}
                onChange={(event) => setForm((prev) => ({ ...prev, ownerTeamId: event.target.value }))}
              />
            </Field>
            <Field label="仓库地址" hint="GitHub / GitLab 仓库 HTTPS 地址，用于仓库事件关联。">
              <Input
                value={form.repoUrl}
                placeholder="https://github.com/org/repo"
                onChange={(event) => setForm((prev) => ({ ...prev, repoUrl: event.target.value }))}
              />
            </Field>
            <div className="ws-form-field-full">
              <Field label="项目描述">
                <Textarea
                  rows={3}
                  value={form.description}
                  placeholder="一句话描述项目目标"
                  onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                />
              </Field>
            </div>
            <div className="ws-form-field-full">
              <Field
                label="项目提示词"
                hint="项目基本面：目标、规范、约束。任务执行时会把这部分注入 DSH 提示词；改动立即对后续任务生效。"
              >
                <Textarea
                  rows={6}
                  value={form.prompt}
                  placeholder="例如：这是 Python/FastAPI 订单服务；幂等键必须绑定业务单号；迁移先 staging 验证；合并前必须跑测试。"
                  onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))}
                />
              </Field>
            </div>
          </div>
          <div className="ws-card-actions">
            <Button variant="primary" icon="check" loading={savingBasic} onClick={() => void handleSaveBasic()}>
              保存基本信息
            </Button>
          </div>
        </Card>

        <Card className="card-pad">
          <SectionHead
            title={
              <>
                <Icon name="brain" size={14} />
                Mnemos 集成
              </>
            }
            desc="任务执行时，Aiwo 会按项目 ID 与 API Key 读取 / 写入 Mnemos 记忆。"
            actions={
              <Badge tone={detail.project.mnemosConfigured ? 'green' : 'slate'} dot>
                {detail.project.mnemosConfigured ? '已配置' : '未配置'}
              </Badge>
            }
          />
          <div className="ws-form-grid mt-12">
            <Field label="Mnemos 项目 ID" hint="Mnemos 中用于隔离项目记忆的标识。">
              <Input
                value={mnemosProjectId}
                placeholder="例如：mb_xxxx 或项目 slug"
                onChange={(event) => setMnemosProjectId(event.target.value)}
              />
            </Field>
            <Field label="API Key" hint="密码框留空表示不修改；写入后只返回是否已配置。">
              <Input
                type="password"
                value={mnemosApiKey}
                placeholder={detail.project.mnemosConfigured ? '已配置，留空不修改' : '填写 Mnemos API Key'}
                autoComplete="new-password"
                onChange={(event) => setMnemosApiKey(event.target.value)}
              />
            </Field>
          </div>
          <div className="ws-card-actions">
            <Button
              variant="primary"
              icon="check"
              loading={savingMnemos}
              onClick={() => void handleSaveMnemos()}
            >
              保存集成配置
            </Button>
            <Button
              variant="outline"
              icon="search"
              loading={testing}
              onClick={() => void handleTest()}
            >
              测试搜索
            </Button>
          </div>
          {testResult ? (
            <Callout tone={testResult.tone} icon={testResult.tone === 'green' ? 'checkCircle' : 'alert'}>
              {testResult.text}
            </Callout>
          ) : null}
        </Card>

        <Card className="card-pad">
          <SectionHead
            title={
              <>
                <Icon name="server" size={14} />
                项目 DSH 服务
              </>
            }
            desc="绑定后，项目任务只在绑定服务之间公平调度；不绑定则使用共享服务池。"
            actions={
              <Button size="sm" variant="primary" icon="check" loading={savingServices} onClick={() => void handleSaveServices()}>
                保存绑定
              </Button>
            }
          />
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {(services.data ?? []).filter((service: DshInstance) => service.status !== 'revoked').map((service: DshInstance) => (
              <Checkbox
                key={service.id}
                checked={serviceIds.includes(service.id)}
                onChange={() => toggleService(service.id)}
                label={
                  <span className="hstack gap-6">
                    <span>{service.name}</span>
                    <span className="tiny dim mono">{service.id}</span>
                    <Badge size="sm" tone={service.status === 'online' ? 'green' : 'slate'} dot>
                      {service.status === 'online' ? '在线' : '离线'}
                    </Badge>
                  </span>
                }
              />
            ))}
            {!services.loading && !services.error && (services.data ?? []).filter((service: DshInstance) => service.status !== 'revoked').length === 0 ? (
              <span className="tiny dim">暂无可用 DSH 服务。</span>
            ) : null}
            {services.error ? <Callout tone="red" icon="alert">加载服务列表失败：{services.error}</Callout> : null}
          </div>
          {serviceIds.length === 0 ? (
            <Callout tone="amber" icon="info">
              未绑定服务：项目任务会进入共享服务池，由任意在线服务领取。
            </Callout>
          ) : null}
        </Card>

        <Card>
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <SectionHead
              title={
                <>
                  <Icon name="users" size={14} />
                  成员
                </>
              }
              desc="项目成员可以查看项目、创建任务，并按角色获得相应权限。"
              actions={
                <Button size="sm" variant="outline" icon="plus" onClick={() => setAddOpen(true)}>
                  添加成员
                </Button>
              }
            />
          </div>
          <Table
            columns={memberColumns}
            rows={detail.members ?? []}
            rowKey={(row) => row.personId}
            empty={
              <EmptyState
                icon="users"
                title="暂无项目成员"
                description="添加成员后，他们可以在项目内创建任务并查看执行进展。"
                action={
                  <Button size="sm" variant="outline" icon="plus" onClick={() => setAddOpen(true)}>
                    添加成员
                  </Button>
                }
                compact
              />
            }
          />
        </Card>

        {isOwnerOrAdmin ? (
          <Card className="card-pad ws-danger-card">
            <SectionHead
              title={
                <>
                  <Icon name="alert" size={14} />
                  危险操作
                </>
              }
              desc="删除项目会移除项目下的任务、自动化与成员关系，且不可撤销。"
            />
            <Callout tone="amber" icon="info">
              当前版本的服务端 API 尚未开放删除项目；如需归档或清理项目，请联系平台管理员处理。
            </Callout>
          </Card>
        ) : null}
      </div>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="添加项目成员"
        description="从组织成员中选择一位加入本项目。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={adding}
              disabled={!newPersonId}
              onClick={() => void handleAddMember()}
            >
              添加
            </Button>
          </>
        }
      >
        <Field label="成员" required>
          {persons.loading && !persons.data ? (
            <div className="vstack gap-8">
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} h={46} style={{ borderRadius: 10 }} />
              ))}
            </div>
          ) : persons.error ? (
            <Callout tone="red" icon="alert">
              加载成员列表失败：{persons.error}
            </Callout>
          ) : !availablePersons.length ? (
            <EmptyState
              icon="users"
              title="没有可添加的成员"
              description="组织内成员都已在项目中。"
              compact
            />
          ) : (
            <Select
              value={newPersonId}
              options={availablePersons.map((item) => ({
                value: item.id,
                label: `${item.name} · ${item.title || item.email}`,
              }))}
              onChange={(event) => setNewPersonId(event.target.value)}
            />
          )}
        </Field>
        <Field label="项目角色" required hint="所有者可删除项目，维护者可管理服务、提示词与自动化，开发者可创建任务，观察者只读。">
          <Select
            value={newRole}
            options={PROJECT_ROLE_OPTIONS}
            onChange={(event) => setNewRole(event.target.value as ProjectRole)}
          />
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
