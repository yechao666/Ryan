import { useEffect, useState } from 'react';
import type { Automation, AutomationTrigger, CreateAutomationInput } from '@shared';
import { AUTOMATION_TRIGGERS } from '@shared';
import { api } from '@lib/api.ts';
import {
  Button,
  Callout,
  Checkbox,
  Field,
  Input,
  Modal,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@ui';
import { useProject } from './context.ts';
import { PROMPT_PLACEHOLDERS, WEBHOOK_EVENTS } from './meta.ts';
import { ProjectInstanceSelect, PromptCardPicker } from './PromptCardPicker.tsx';

export interface AutomationFormProps {
  open: boolean;
  /** 传入自动化即为编辑，null 为新建。 */
  automation: Automation | null;
  onClose: () => void;
  onSaved: () => void;
}

interface FormErrors {
  name?: string;
  events?: string;
  schedule?: string;
  promptTemplate?: string;
}

const TRIGGER_OPTIONS = AUTOMATION_TRIGGERS.map((item) => ({ value: item.value, label: item.label }));

/** 新建 / 编辑自动化弹窗：触发规则 + 提示词卡片 + 可选 DSH 服务。 */
export function AutomationForm({ open, automation, onClose, onSaved }: AutomationFormProps) {
  const { detail } = useProject();
  const projectId = detail.project.id;
  const toast = useToast();

  const [name, setName] = useState('');
  const [promptCardIds, setPromptCardIds] = useState<string[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [triggerType, setTriggerType] = useState<AutomationTrigger>('manual');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const [schedule, setSchedule] = useState('');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (automation) {
      setName(automation.name);
      setPromptCardIds(automation.promptCardIds ?? []);
      setInstanceId(automation.instanceId ?? '');
      setTriggerType(automation.triggerType);
      setEvents(automation.triggerConfig.events ?? []);
      setSecret(automation.triggerConfig.secret ?? '');
      setSchedule(automation.triggerConfig.schedule ?? '');
      setPromptTemplate(automation.promptTemplate);
      setEnabled(automation.enabled);
    } else {
      setName('');
      setPromptCardIds([]);
      setInstanceId('');
      setTriggerType('manual');
      setEvents(['push']);
      setSecret('');
      setSchedule('');
      setPromptTemplate('');
      setEnabled(true);
    }
  }, [open, automation]);

  const toggleEvent = (value: string) => {
    setEvents((prev) => (prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]));
  };

  const handleSubmit = async () => {
    const nextErrors: FormErrors = {};
    if (!name.trim()) nextErrors.name = '请填写自动化名称';
    if (triggerType === 'webhook' && events.length === 0) nextErrors.events = '至少选择一个 Webhook 事件';
    if (triggerType === 'cron' && !schedule.trim()) nextErrors.schedule = '请填写 5 段 cron 表达式';
    if (!promptTemplate.trim()) nextErrors.promptTemplate = '请填写提示词模板';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const payload: CreateAutomationInput = {
      name: name.trim(),
      triggerType,
      triggerConfig:
        triggerType === 'webhook'
          ? { events, secret: secret.trim() || undefined }
          : triggerType === 'cron'
            ? { schedule: schedule.trim() }
            : {},
      promptTemplate: promptTemplate.trim(),
      promptCardIds,
      instanceId: instanceId || undefined,
      enabled,
    };

    setSubmitting(true);
    try {
      if (automation) {
        await api.updateAutomation(automation.id, payload);
        toast.success('自动化已更新');
      } else {
        await api.createAutomation(projectId, payload);
        toast.success('自动化已创建');
      }
      onSaved();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存自动化失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={automation ? '编辑自动化' : '新建自动化'}
      description="把仓库事件、定时任务或人工操作转换成 Aiwo 任务。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon="check" loading={submitting} onClick={() => void handleSubmit()}>
            {automation ? '保存修改' : '创建自动化'}
          </Button>
        </>
      }
    >
      <div className="ws-form-grid">
        <Field label="名称" required error={errors.name}>
          <Input
            value={name}
            placeholder="例如：PR 自动审查"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="触发类型" hint={AUTOMATION_TRIGGERS.find((item) => item.value === triggerType)?.desc}>
          <Select
            value={triggerType}
            options={TRIGGER_OPTIONS}
            onChange={(event) => setTriggerType(event.target.value as AutomationTrigger)}
          />
        </Field>

        <Field label="启用">
          <div style={{ minHeight: 36, display: 'flex', alignItems: 'center' }}>
            <Switch checked={enabled} onChange={setEnabled} label={enabled ? '已启用' : '已停用'} />
          </div>
        </Field>
      </div>

      {triggerType === 'webhook' ? (
        <div className="ws-form-section">
          <Field
            label="Webhook 事件"
            required
            error={errors.events}
            hint="GitHub / GitLab 推送这些事件时触发；未选择事件的投递会被忽略。"
          >
            <div className="ws-checkbox-row">
              {WEBHOOK_EVENTS.map((item) => (
                <Checkbox
                  key={item.value}
                  checked={events.includes(item.value)}
                  onChange={() => toggleEvent(item.value)}
                  label={item.label}
                />
              ))}
            </div>
          </Field>

          <Field label="Secret" hint="用于校验 X-Hub-Signature-256 / X-Gitlab-Token，留空则不校验签名。">
            <Input
              type="password"
              value={secret}
              placeholder="仓库 Webhook 里配置的同一个 secret"
              autoComplete="new-password"
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {triggerType === 'cron' ? (
        <Field label="cron 表达式" required error={errors.schedule} hint="5 段格式：分 时 日 月 周，例如 0 9 * * 1-5。">
          <Input
            value={schedule}
            placeholder="0 9 * * 1-5"
            onChange={(event) => setSchedule(event.target.value)}
          />
        </Field>
      ) : null}

      <Field
        label="提示词模板"
        required
        error={errors.promptTemplate}
        hint="支持占位符，运行时会替换为实际上下文。"
      >
        <Textarea
          rows={7}
          value={promptTemplate}
          placeholder={'例如：检查 {{project}} 的分支 {{branch}} 上的变更，事件 {{event}}，标题 {{title}}，链接 {{url}}。'}
          onChange={(event) => setPromptTemplate(event.target.value)}
        />
      </Field>

      <div className="ws-placeholder-row">
        {PROMPT_PLACEHOLDERS.map((item) => (
          <code key={item} className="ws-placeholder">
            {item}
          </code>
        ))}
      </div>

      <PromptCardPicker
        projectId={projectId}
        open={open}
        value={promptCardIds}
        onChange={setPromptCardIds}
      />

      <ProjectInstanceSelect
        projectId={projectId}
        open={open}
        value={instanceId}
        onChange={setInstanceId}
      />

    </Modal>
  );
}
