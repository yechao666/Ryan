import { useEffect, useState } from 'react';
import type { TaskType, WorkItem } from '@shared';
import { TASK_TYPES } from '@shared';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Button,
  Callout,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '@ui';
import { Link } from 'react-router-dom';
import { useProject } from './context.ts';
import { PRIORITY_OPTIONS } from './meta.ts';

export interface CreateTaskModalProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回传任务，便于外层打开抽屉。 */
  onCreated: (task: WorkItem) => void;
}

interface FormErrors {
  agentId?: string;
  title?: string;
  prompt?: string;
}

/** 新建任务弹窗：选择项目内智员，填写标题与提示词。 */
export function CreateTaskModal({ open, onClose, onCreated }: CreateTaskModalProps) {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const toast = useToast();
  const agents = useAsync(() => api.projectAgents(projectId), [projectId, open], open);

  const [agentId, setAgentId] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [type, setType] = useState<TaskType>('feature');
  const [priority, setPriority] = useState('2');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  // 每次打开重置表单，并默认选中第一个启用的智员。
  useEffect(() => {
    if (!open) return;
    setAgentId('');
    setTitle('');
    setPrompt('');
    setType('feature');
    setPriority('2');
    setErrors({});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (agentId) return;
    const first = agents.data?.find((item) => item.status === 'active') ?? agents.data?.[0];
    if (first) setAgentId(first.agentId);
  }, [open, agentId, agents.data]);

  const boundAgents = agents.data ?? [];
  const activeAgents = boundAgents.filter((item) => item.status === 'active');

  const handleSubmit = async () => {
    const nextErrors: FormErrors = {};
    if (!agentId) nextErrors.agentId = '请选择执行任务的智员';
    if (!title.trim()) nextErrors.title = '请填写任务标题';
    if (!prompt.trim()) nextErrors.prompt = '请填写给智员的提示词';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const task = await api.createTask(projectId, {
        agentId,
        title: title.trim(),
        prompt: prompt.trim(),
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

  const agentOptions = activeAgents.map((item) => ({
    value: item.agentId,
    label: `${item.agent.name}${item.role ? ` · ${item.role}` : ''}`,
  }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建任务"
      description="任务会进入排队队列，由绑定的智员在实例上认领执行。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            icon="plus"
            loading={submitting}
            disabled={!activeAgents.length}
            onClick={() => void handleSubmit()}
          >
            创建任务
          </Button>
        </>
      }
    >
      {agents.loading && !agents.data ? (
        <div className="vstack gap-12">
          <Skeleton h={36} />
          <Skeleton h={36} />
          <Skeleton h={92} />
        </div>
      ) : agents.error ? (
        <Callout tone="red" icon="alert">
          加载项目智员失败：{agents.error}
        </Callout>
      ) : !activeAgents.length ? (
        <EmptyState
          icon="bot"
          title="还没有可用的智员"
          description="先把智员关联到项目并保持启用，再创建任务。"
          action={
            <Link className="btn btn-sm btn-outline" to={`/projects/${encodeURIComponent(projectId)}/agents`}>
              <Icon name="link" size={13} />
              关联智员
            </Link>
          }
          compact
        />
      ) : (
        <>
          <Field label="执行智员" required error={errors.agentId}>
            <Select
              value={agentId}
              options={agentOptions}
              onChange={(event) => setAgentId(event.target.value)}
            />
          </Field>

          <Field label="任务标题" required error={errors.title} hint="一句话说明要完成的事情。">
            <Input
              value={title}
              placeholder="例如：修复登录页在 Safari 下的布局抖动"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>

          <Field
            label="提示词"
            required
            error={errors.prompt}
            hint="写清背景、验收标准与相关文件，会随任务一起下发给智员。"
          >
            <Textarea
              rows={6}
              value={prompt}
              placeholder="描述任务背景、要改动的模块、验收标准等…"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>

          <Field label="任务类型" hint="用于看板筛选与周报归类，默认「需求」。">
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
        </>
      )}
    </Modal>
  );
}
