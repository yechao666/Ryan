import { useEffect, useMemo, useState } from 'react';
import type { ProjectReportSettings, ProjectType, Visibility } from '@shared';
import { PROJECT_TYPES, VISIBILITIES } from '@shared';
import { api } from '@lib/api.ts';
import { fmtDate, fmtMs } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  PageHead,
  SectionHead,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@ui';
import { useProject } from '../ProjectLayout.tsx';
import { MentionTextarea } from '../../components/project/MentionTextarea.tsx';
import {
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

/** 项目设置：基本信息、复盘报告与危险操作。 */
export function ProjectSettingsPage() {
  const { detail, reload } = useProject();
  const projectId = detail.project.id;
  const { person } = useAuth();
  const toast = useToast();

  const teams = useAsync(() => api.teams(), []);
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
  const [reportForm, setReportForm] = useState<ProjectReportSettings>(detail.project.reportSettings);
  const [reportBase, setReportBase] = useState<ProjectReportSettings>(detail.project.reportSettings);
  const [savingReport, setSavingReport] = useState(false);

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
  }, [detail.project]);

  useEffect(() => {
    setReportForm(detail.project.reportSettings);
    setReportBase(detail.project.reportSettings);
  }, [detail.project.id]);

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

  const handleSaveReport = async () => {
    setSavingReport(true);
    try {
      await api.updateProject(projectId, {
        reportsEnabled: reportForm.enabled,
        weeklyReportDay: reportForm.weeklyDay,
        weeklyReportTime: reportForm.weeklyTime,
        monthlyReportDay: reportForm.monthlyDay,
        monthlyReportTime: reportForm.monthlyTime,
      });
      toast.success('复盘报告设置已保存');
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存复盘报告设置失败，请重试');
    } finally {
      setSavingReport(false);
    }
  };

  const visibility = visibilityMeta(form.visibility);
  const type = projectTypeMeta(form.type);

  return (
    <div className="ws-page">
      <PageHead title="项目设置" desc="维护项目基本信息、复盘报告与危险操作。项目成员请到「成员」页管理。" />

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
                <MentionTextarea
                  rows={6}
                  value={form.prompt}
                  placeholder="例如：这是 Python/FastAPI 订单服务；输入 @ 可提及人员或智能体；合并前必须跑测试。"
                  onChange={(value) => setForm((prev) => ({ ...prev, prompt: value }))}
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
                <Icon name="calendar" size={14} />
                复盘与报告
              </>
            }
            desc="控制是否在项目导航中显示「复盘总结」，并设置周报/月报的计划生成时间。关闭后不会显示报告页。"
            actions={<Badge tone={reportForm.enabled ? 'green' : 'slate'} size="sm" dot>{reportForm.enabled ? '已开启' : '已关闭'}</Badge>}
          />
          <div className="ws-form-grid mt-12">
            <div className="ws-form-field-full between">
              <div>
                <div className="strong">启用周报 / 月报</div>
                <div className="tiny dim mt-4">关闭后隐藏项目导航中的「复盘总结」入口，不影响已有过程记录。</div>
              </div>
              <Switch
                checked={reportForm.enabled}
                onChange={(checked) => setReportForm((prev) => ({ ...prev, enabled: checked }))}
                label={reportForm.enabled ? '已开启' : '已关闭'}
              />
            </div>
            <Field label="周报生成日" hint="按周一至周日选择。">
              <Select
                value={String(reportForm.weeklyDay)}
                options={[
                  { value: '1', label: '周一' }, { value: '2', label: '周二' }, { value: '3', label: '周三' },
                  { value: '4', label: '周四' }, { value: '5', label: '周五' }, { value: '6', label: '周六' }, { value: '7', label: '周日' },
                ]}
                disabled={!reportForm.enabled}
                onChange={(event) => setReportForm((prev) => ({ ...prev, weeklyDay: Number(event.target.value) }))}
              />
            </Field>
            <Field label="周报生成时间" hint="使用本机本地时间。">
              <Input
                type="time"
                value={reportForm.weeklyTime}
                disabled={!reportForm.enabled}
                onChange={(event) => setReportForm((prev) => ({ ...prev, weeklyTime: event.target.value }))}
              />
            </Field>
            <Field label="月报生成日" hint="1–28 日，避免不同月份天数差异。">
              <Select
                value={String(reportForm.monthlyDay)}
                options={Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 日` }))}
                disabled={!reportForm.enabled}
                onChange={(event) => setReportForm((prev) => ({ ...prev, monthlyDay: Number(event.target.value) }))}
              />
            </Field>
            <Field label="月报生成时间" hint="使用本机本地时间。">
              <Input
                type="time"
                value={reportForm.monthlyTime}
                disabled={!reportForm.enabled}
                onChange={(event) => setReportForm((prev) => ({ ...prev, monthlyTime: event.target.value }))}
              />
            </Field>
          </div>
          <div className="ws-card-actions">
            <Button variant="primary" icon="check" loading={savingReport} disabled={!reportForm.enabled && reportBase.enabled === false} onClick={() => void handleSaveReport()}>
              保存报告设置
            </Button>
          </div>
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

    </div>
  );
}
