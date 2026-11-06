import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Agent } from '@shared';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHead,
  Segmented,
  Textarea,
  useToast,
} from '@ui';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { apiErrorMessage, CardGridSkeleton, errorText, useResource } from '../components/projects/helpers.tsx';
import { AgentCard } from '../components/agents/index.tsx';

type AgentScope = 'mine' | 'all';

interface AgentFormState {
  name: string;
  role: string;
  model: string;
  description: string;
  capabilities: string;
}

const EMPTY_FORM: AgentFormState = {
  name: '',
  role: '',
  model: 'deepseek-chat',
  description: '',
  capabilities: '',
};

/** 智员列表：我的 / 全部（管理员），创建智员。 */
export function AgentsPage() {
  const { person } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const isAdmin = Boolean(person?.isAdmin);
  const [params, setParams] = useSearchParams();
  const createOpen = params.get('new') === '1';

  const [scope, setScope] = useState<AgentScope>('mine');
  const { data: agents, loading, error, status, reload } = useResource<Agent[]>(
    () => api.agents(scope),
    [scope],
  );

  const [form, setForm] = useState<AgentFormState>(EMPTY_FORM);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const openCreate = () => {
    setSubmitError(null);
    setParams({ new: '1' });
  };
  const closeCreate = () => {
    setSubmitError(null);
    setParams({}, { replace: true });
  };

  const update = <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setSubmitError('请填写智员名称。');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const capabilities = form.capabilities
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean);
      const created = await api.createAgent({
        name: form.name.trim(),
        role: form.role.trim() || undefined,
        model: form.model.trim() || 'deepseek-chat',
        description: form.description.trim() || undefined,
        capabilities: capabilities.length ? capabilities : undefined,
      });
      toast.success(`智员「${created.name}」已创建`);
      setForm(EMPTY_FORM);
      setParams({}, { replace: true });
      await reload();
    } catch (cause) {
      const message = apiErrorMessage(cause, '创建智员失败');
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const list = agents ?? [];
  const activeCount = list.filter((agent) => agent.status === 'active').length;

  return (
    <div className="page">
      <PageHead
        eyebrow="智员 · Agents"
        title="智员"
        desc="智员拥有全局身份；加入项目后获得项目内的记忆身份，用来承接任务与读写记忆。"
        actions={
          <>
            <IconButton icon="refresh" label="刷新智员" onClick={() => void reload()} />
            <Button variant="primary" icon="plus" onClick={openCreate}>
              创建智员
            </Button>
          </>
        }
      />

      <div className="cx-filter-bar">
        <div className="cx-filter-left">
          {isAdmin ? (
            <Segmented<AgentScope>
              value={scope}
              onChange={setScope}
              options={[
                { value: 'mine', label: '我的智员' },
                { value: 'all', label: '全部智员' },
              ]}
            />
          ) : null}
          <span className="tiny dim">
            共 {list.length} 位 · {activeCount} 位在职
          </span>
        </div>
        {isAdmin ? <span className="tiny dim">管理员可查看组织内全部智员</span> : null}
      </div>

      {loading && !agents ? (
        <CardGridSkeleton count={6} />
      ) : error && !agents ? (
        <ErrorState message={errorText(status, error, '智员')} onRetry={() => void reload()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon="bot"
            title={scope === 'mine' ? '你还没有智员' : '还没有智员'}
            description={
              scope === 'mine'
                ? '创建智员，将它加入项目并绑定项目记忆身份，然后就能派发任务。'
                : '组织内还没有任何智员，创建第一位数字员工吧。'
            }
            action={
              <Button variant="primary" icon="plus" onClick={openCreate}>
                创建智员
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid-cards">
          {list.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onOpen={() => navigate(`/agents/${agent.id}`)} />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="创建智员"
        description="智员归属你本人；创建后可在项目工作区将其绑定到项目。"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate}>
              取消
            </Button>
            <Button variant="primary" type="submit" form="create-agent-form" loading={submitting} icon="plus">
              创建智员
            </Button>
          </>
        }
      >
        <form id="create-agent-form" className="stack" style={{ gap: 14 }} onSubmit={handleCreate}>
          <div className="grid grid-2">
            <Field label="智员名称" htmlFor="agent-name" required>
              <Input
                id="agent-name"
                value={form.name}
                placeholder="例如：Orion 代码助手"
                autoFocus
                onChange={(event) => update('name', event.target.value)}
              />
            </Field>
            <Field label="岗位" htmlFor="agent-role" hint="用于区分不同类型的工作。">
              <Input
                id="agent-role"
                value={form.role}
                placeholder="例如：后端工程师"
                onChange={(event) => update('role', event.target.value)}
              />
            </Field>
          </div>

          <Field label="模型" htmlFor="agent-model" hint="默认使用 deepseek-chat；运行时可按模型调度。">
            <Input
              id="agent-model"
              value={form.model}
              placeholder="deepseek-chat"
              onChange={(event) => update('model', event.target.value)}
            />
          </Field>

          <Field label="描述" htmlFor="agent-description">
            <Textarea
              id="agent-description"
              rows={3}
              value={form.description}
              placeholder="这位智员擅长什么？适合承接哪些任务？"
              onChange={(event) => update('description', event.target.value)}
            />
          </Field>

          <Field label="能力标签" htmlFor="agent-capabilities" hint="用逗号分隔，例如：typescript, code-review, sql">
            <Input
              id="agent-capabilities"
              value={form.capabilities}
              placeholder="typescript, code-review, sql"
              onChange={(event) => update('capabilities', event.target.value)}
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
