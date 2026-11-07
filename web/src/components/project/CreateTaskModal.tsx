import { useEffect, useState } from 'react';
import type { TaskType, WorkItem } from '@shared';
import { TASK_TYPES } from '@shared';
import { api } from '@lib/api.ts';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@ui';
import { useProject } from './context.ts';
import { PRIORITY_OPTIONS } from './meta.ts';
import { ProjectInstanceMultiSelect, PromptCardPicker } from './PromptCardPicker.tsx';

export interface CreateTaskModalProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回传任务，便于外层跳转任务详情。 */
  onCreated: (task: WorkItem) => void;
}

interface FormErrors {
  title?: string;
  prompt?: string;
}

/** 新建任务弹窗：填写目标与提示词，可选提示卡与 DSH 服务。 */
export function CreateTaskModal({ open, onClose, onCreated }: CreateTaskModalProps) {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const toast = useToast();

  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [promptCardIds, setPromptCardIds] = useState<string[]>([]);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [type, setType] = useState<TaskType>('feature');
  const [priority, setPriority] = useState('2');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  // 每次打开重置表单。
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setPrompt('');
    setPromptCardIds([]);
    setInstanceIds([]);
    setType('feature');
    setPriority('2');
    setErrors({});
  }, [open]);

  const handleSubmit = async () => {
    const nextErrors: FormErrors = {};
    if (!prompt.trim()) nextErrors.prompt = '请填写任务内容';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const task = await api.createTask(projectId, {
        title: title.trim() || undefined,
        prompt: prompt.trim(),
        promptCardIds,
        instanceIds,
        type,
        priority: Number(priority),
        source: 'human',
      });
      toast.success('任务已创建，已进入排队队列。');
      onCreated(task);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '创建任务失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="新建任务"
      description="任务会进入排队队列；有项目绑定服务时在绑定服务间公平调度，否则进入共享服务池。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon="plus" loading={submitting} onClick={() => void handleSubmit()}>
            创建任务
          </Button>
        </>
      }
    >
      <Field label="任务标题" error={errors.title} hint="可留空；留空时由 AI 根据任务内容自动整理。">
        <Input
          value={title}
          placeholder="例如：修复登录页在 Safari 下的布局抖动"
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>

      <Field
        label="任务内容"
        required
        error={errors.prompt}
        hint="写清背景、验收标准与相关文件，会与项目提示词、提示卡一起下发给 Aiwo。"
      >
        <Textarea
          rows={6}
          value={prompt}
          placeholder="描述任务背景、要改动的模块、验收标准等…"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </Field>

      <PromptCardPicker
        projectId={projectId}
        open={open}
        value={promptCardIds}
        onChange={setPromptCardIds}
      />

      <ProjectInstanceMultiSelect
        projectId={projectId}
        open={open}
        value={instanceIds}
        onChange={setInstanceIds}
      />

      <div className="ws-form-grid">
        <Field label="任务类型" hint="用于任务视图筛选与周报归类，默认「需求」。">
          <Select
            value={type}
            options={TASK_TYPES.map((item) => ({ value: item.value, label: item.label }))}
            onChange={(event) => setType(event.target.value as TaskType)}
          />
        </Field>
        <Field label="优先级">
          <Select
            value={priority}
            options={PRIORITY_OPTIONS}
            onChange={(event) => setPriority(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
