import { useState } from 'react';
import type { FormEvent } from 'react';
import { Badge, Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, Field, Icon, IconButton, Input, Modal, PageHead, Select, Skeleton, useToast } from '@ui';
import { api, type ProjectContextItem } from '../../lib/api.ts';
import { MentionTextarea } from '../../components/project/MentionTextarea.tsx';
import { useAsync } from '../../lib/hooks.ts';
import { useProject } from '../ProjectLayout.tsx';

const CATEGORIES = [
  { value: 'repo', label: '仓库与代码' },
  { value: 'requirement', label: '基本要求' },
  { value: 'environment', label: '环境与运行' },
  { value: 'convention', label: '约定与规范' },
  { value: 'other', label: '其他背景' },
] as const;

function categoryLabel(value: string): string {
  return CATEGORIES.find((item) => item.value === value)?.label ?? value;
}

interface FormState {
  title: string;
  content: string;
  category: ProjectContextItem['category'];
}

const EMPTY: FormState = { title: '', content: '', category: 'other' };

/** 项目背景：逐条维护仓库、环境、要求和约定，任务执行时自动注入。 */
export function ProjectContextPage() {
  const { detail } = useProject();
  const project = detail.project;
  const toast = useToast();
  const query = useAsync(() => api.projectContext(project.id), [project.id]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectContextItem | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectContextItem | null>(null);
  const [removing, setRemoving] = useState(false);

  const items = query.data?.items ?? [];

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  };

  const openEdit = (item: ProjectContextItem): void => {
    setEditing(item);
    setForm({ title: item.title, content: item.content, category: item.category });
    setOpen(true);
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!form.title.trim()) {
      toast.error('请填写背景条目标题');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.updateProjectContext(project.id, editing.id, form);
        toast.success('项目背景已更新');
      } else {
        await api.createProjectContext(project.id, form);
        toast.success('项目背景已添加');
      }
      setOpen(false);
      await query.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存项目背景失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.deleteProjectContext(project.id, removeTarget.id);
      toast.success('项目背景已删除');
      setRemoveTarget(null);
      await query.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除项目背景失败');
    } finally {
      setRemoving(false);
    }
  };

  const move = async (item: ProjectContextItem, direction: -1 | 1): Promise<void> => {
    const index = items.findIndex((entry) => entry.id === item.id);
    const target = items[index + direction];
    if (!target) return;
    try {
      await Promise.all([
        api.updateProjectContext(project.id, item.id, { sortOrder: target.sortOrder }),
        api.updateProjectContext(project.id, target.id, { sortOrder: item.sortOrder }),
      ]);
      await query.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '调整顺序失败');
    }
  };

  return (
    <div className="ws-page">
      <PageHead
        title="项目背景"
        desc="逐条维护项目的基本信息：仓库位置、运行方式、基本要求、技术约定等。执行任务时会自动作为项目上下文注入。"
        actions={<Button variant="primary" icon="plus" onClick={openCreate}>新增背景条目</Button>}
      />
      <Callout tone="cyan" icon="info">
        项目背景不会写入每一条任务描述，而是在任务领取执行时与项目提示词、提示卡一起注入，适合放长期有效的背景信息。
      </Callout>

      {query.loading && !query.data ? (
        <div className="vstack gap-8 mt-12"><Skeleton h={100} /><Skeleton h={100} /><Skeleton h={100} /></div>
      ) : query.error && !query.data ? (
        <ErrorState message={query.error} onRetry={() => void query.refresh()} />
      ) : items.length === 0 ? (
        <Card className="card-pad mt-12">
          <EmptyState
            icon="book"
            title="还没有项目背景"
            description="先补充仓库位置、环境启动方式和基本要求，后续任务会自动获得这份上下文。"
            action={<Button variant="primary" icon="plus" onClick={openCreate}>新增背景条目</Button>}
          />
        </Card>
      ) : (
        <div className="stack mt-12" style={{ gap: 10 }}>
          {items.map((item, index) => (
            <Card className="card-pad" key={item.id}>
              <div className="row-between gap-12 wrap">
                <div className="hstack gap-10" style={{ minWidth: 0 }}>
                  <span className="cx-metric-icon tone-cyan"><Icon name="book" size={14} /></span>
                  <div style={{ minWidth: 0 }}>
                    <div className="hstack gap-8">
                      <span className="strong">{item.title}</span>
                      <Badge size="sm" tone="cyan">{categoryLabel(item.category)}</Badge>
                    </div>
                    <div className="tiny dim">在项目任务执行时自动注入</div>
                  </div>
                </div>
                <div className="hstack gap-4">
                  <IconButton icon="chevronUp" label="上移" size="sm" disabled={index === 0} onClick={() => void move(item, -1)} />
                  <IconButton icon="chevronDown" label="下移" size="sm" disabled={index === items.length - 1} onClick={() => void move(item, 1)} />
                  <IconButton icon="pencil" label="编辑" size="sm" onClick={() => openEdit(item)} />
                  <IconButton icon="trash" label="删除" size="sm" onClick={() => setRemoveTarget(item)} />
                </div>
              </div>
              {item.content ? <div className="small mt-10" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{item.content}</div> : null}
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑项目背景' : '新增项目背景'}
        description="标题用于在任务上下文中分组，内容支持多行 Markdown。"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" icon="check" type="submit" form="project-context-form" loading={saving}>{editing ? '保存修改' : '添加'}</Button>
          </>
        }
      >
        <form id="project-context-form" className="stack" style={{ gap: 14 }} onSubmit={save}>
          <div className="grid grid-2">
            <Field label="标题" required>
              <Input value={form.title} autoFocus placeholder="例如：代码仓库" onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))} />
            </Field>
            <Field label="类别">
              <Select value={form.category} options={[...CATEGORIES]} onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value as FormState['category'] }))} />
            </Field>
          </div>
          <Field label="内容" hint="例如仓库地址、分支约定、启动命令、测试要求、禁止修改的文件等。">
            <MentionTextarea rows={8} value={form.content} placeholder={'例如：\n仓库：git@github.com:org/repo.git\n主分支：main\n启动：pnpm install && pnpm dev'} onChange={(value) => setForm((prev) => ({ ...prev, content: value }))} />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void remove()}
        loading={removing}
        title="删除项目背景条目？"
        description={removeTarget ? `「${removeTarget.title}」将从后续任务上下文中移除。` : undefined}
        confirmLabel="删除"
      />
    </div>
  );
}
