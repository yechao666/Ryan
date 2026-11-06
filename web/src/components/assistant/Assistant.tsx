import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ProjectAgent, ProjectSummary } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { Markdown } from '../project/Markdown.tsx';
import {
  Badge,
  Button,
  Callout,
  Icon,
  IconButton,
  Select,
  Textarea,
  useToast,
  type IconName,
  type Tone,
} from '@ui';
import {
  buildAutomationName,
  buildAutomationPrompt,
  parseIntent,
  taskKindLabel,
  taskKindTone,
  type AutomationIntent,
  type CronParse,
  type NavigateIntent,
  type ParsedIntent,
  type TaskIntent,
  type TaskKind,
} from './intent.ts';

/**
 * 全局操作助手：本地意图解析 + 现有 API。
 *
 * 设计要点：
 * - 仅做「解析 → 预览 → 用户确认 → 调 API」的闭环，不伪造执行结果。
 * - 写操作成功后 dispatch hive:assistant-refresh，并跳到对应项目页面触发真实数据拉取。
 * - 读取当前路由作为上下文；不在项目内时列出项目让用户选择。
 */

/* ================================================================== */
/* 类型                                                                */
/* ================================================================== */

interface ProjectContext {
  id: string;
  name: string;
  /** 只保留已生效的绑定智员 */
  agents: ProjectAgent[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  tone?: 'error' | 'success';
  suggestions?: string[];
  /** 让用户选择项目的可点击列表 */
  projectPicker?: ProjectSummary[];
  /** 关联的待确认动作 */
  actionId?: string;
}

interface ActionBase {
  id: string;
  kind: 'automation' | 'task' | 'navigate';
  projectId?: string;
  projectName?: string;
}

interface AutomationAction extends ActionBase {
  kind: 'automation';
  projectId: string;
  projectName: string;
  name: string;
  schedule: CronParse;
  email: string | null;
  promptTemplate: string;
  agents: ProjectAgent[];
  agentId: string;
  topic: string;
}

interface TaskAction extends ActionBase {
  kind: 'task';
  projectId: string;
  projectName: string;
  title: string;
  prompt: string;
  type: TaskKind;
  agents: ProjectAgent[];
  agentId: string;
}

interface NavigateAction extends ActionBase {
  kind: 'navigate';
  to: string;
  label: string;
  description: string;
  note?: string;
  /** 该页面需要项目上下文，但当前不在项目内 */
  needsProject?: boolean;
}

type PendingAction = AutomationAction | TaskAction | NavigateAction;

/* ================================================================== */
/* 常量 / 工具                                                         */
/* ================================================================== */

const WELCOME =
  '我是 Hive 系统助手，运行在 DSH 实例中。可以直接调用 Hive API 创建任务、自动化、查询项目与实例，并带你打开相关页面。';

const UNKNOWN_HELP = [
  '这个请求我还不能执行。目前可以帮你：',
  '• 创建定时自动化：「每天 10 点生成开发简报，发送到 name@example.com」',
  '• 创建任务：「创建任务：修复登录页 bug」或「让 Orion 做接口文档」',
  '• 打开页面：「打开任务 / 记忆 / 设置 / 自动化 / 智员 / 实例」',
  '• 筛选任务：「筛选 BUGFIX / 需求 / 运维」',
].join('\n');

const PROJECT_PAGES: Record<string, string> = {
  agents: '项目智员',
  tasks: '项目任务',
  activity: '项目活动',
  automations: '项目自动化',
  memory: '项目记忆',
  settings: '项目设置',
};

function pageLabel(pathname: string): string {
  const match = pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/);
  if (match) {
    const tab = match[2];
    if (!tab) return '项目概览';
    return PROJECT_PAGES[tab] ?? '项目工作区';
  }
  if (pathname === '/projects') return '项目列表';
  if (pathname === '/teams') return '团队';
  if (pathname.startsWith('/teams/')) return '团队详情';
  if (pathname === '/agents') return '智员';
  if (pathname.startsWith('/agents/')) return '智员详情';
  if (pathname === '/instances') return '实例';
  if (pathname === '/tasks') return '任务';
  if (pathname === '/') return '概览';
  return '控制台';
}

function suggestionsFor(hasProject: boolean): string[] {
  return hasProject
    ? [
        '每天 10 点生成开发简报，发送到 yechao@rising.com.cn',
        '创建任务：修复登录页在 Safari 的滚动问题',
        '打开自动化',
        '打开记忆',
      ]
    : ['打开任务', '打开实例', '创建任务：整理接口文档', '每天 10 点生成开发简报'];
}

function errorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return '需要项目/团队权限，无法执行该操作。请联系项目负责人或组织管理员。';
    if (cause.status === 404) return '目标不存在或已被删除，请刷新页面后重试。';
    return cause.message;
  }
  return cause instanceof Error ? cause.message : '操作失败，请稍后重试。';
}

function matchAgent(agents: ProjectAgent[], name?: string): ProjectAgent | undefined {
  if (!name) return undefined;
  const needle = name.toLowerCase().replace(/\s+/g, '');
  return agents.find((item) => {
    const agentName = item.agent.name.toLowerCase().replace(/\s+/g, '');
    return agentName.includes(needle) || needle.includes(agentName) || item.agentId === name;
  });
}

/** 优先按解析出的名字匹配；解析不到时在原始句子里找已绑定智员（支持带空格的名字）。 */
function findMentionedAgent(
  agents: ProjectAgent[],
  name: string | undefined,
  raw: string,
): ProjectAgent | undefined {
  return matchAgent(agents, name) ?? agents.find((item) => raw.includes(item.agent.name));
}

/* ================================================================== */
/* 动作预览                                                            */
/* ================================================================== */

function ActionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cx-assistant-row">
      <span className="cx-assistant-row__label">{label}</span>
      <div className="cx-assistant-row__value">{children}</div>
    </div>
  );
}

function ActionPreview({
  action,
  executing,
  onCancel,
  onConfirm,
  onAgentChange,
}: {
  action: PendingAction;
  executing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onAgentChange: (agentId: string) => void;
}) {
  const title =
    action.kind === 'automation' ? '将创建定时自动化' : action.kind === 'task' ? '将创建任务' : '将打开页面';
  const icon: IconName = action.kind === 'automation' ? 'clock' : action.kind === 'task' ? 'list' : 'arrowRight';
  const tone: Tone = action.kind === 'automation' ? 'violet' : action.kind === 'task' ? 'cyan' : 'slate';
  const confirmLabel = action.kind === 'navigate' ? '打开页面' : action.kind === 'automation' ? '确认创建自动化' : '确认创建任务';

  return (
    <div className={`cx-assistant-action tone-${tone}`}>
      <div className="cx-assistant-action__head">
        <span className="cx-assistant-action__icon">
          <Icon name={icon} size={14} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="cx-assistant-action__title">{title}</div>
          <div className="tiny dim">确认后才会执行</div>
        </div>
      </div>

      <div className="cx-assistant-action__body">
        {action.kind === 'navigate' ? (
          <>
            <ActionRow label="目标">
              <span className="strong">{action.label}</span>
            </ActionRow>
            <ActionRow label="路径">
              <span className="mono tiny">{action.to}</span>
            </ActionRow>
            {action.description ? <div className="cx-assistant-muted">{action.description}</div> : null}
            {action.note ? (
              <Callout tone="amber" icon="alert">
                {action.note}
              </Callout>
            ) : null}
          </>
        ) : (
          <>
            <ActionRow label="项目">
              <span className="strong truncate">{action.projectName}</span>
            </ActionRow>
            {action.kind === 'automation' ? (
              <>
                <ActionRow label="频次">
                  <span className="hstack gap-6 wrap">
                    <span>{action.schedule.human}</span>
                    <code className="chip mono">{action.schedule.schedule}</code>
                  </span>
                </ActionRow>
                {action.email ? (
                  <ActionRow label="收件邮箱">
                    <span className="truncate">{action.email}</span>
                  </ActionRow>
                ) : null}
                <ActionRow label="名称">
                  <span className="truncate">{action.name}</span>
                </ActionRow>
                <ActionRow label="提示词">
                  <p className="cx-assistant-prompt clamp-2">{action.promptTemplate}</p>
                </ActionRow>
              </>
            ) : (
              <>
                <ActionRow label="标题">
                  <span className="strong">{action.title}</span>
                </ActionRow>
                <ActionRow label="类型">
                  <Badge size="sm" tone={taskKindTone(action.type) as Tone}>
                    {taskKindLabel(action.type)}
                  </Badge>
                </ActionRow>
                <ActionRow label="提示词">
                  <p className="cx-assistant-prompt clamp-2">{action.prompt}</p>
                </ActionRow>
              </>
            )}
            <ActionRow label="执行智员">
              <Select
                value={action.agentId}
                options={action.agents.map((item) => ({
                  value: item.agentId,
                  label: `${item.agent.name}${item.role ? ` · ${item.role}` : ''}`,
                }))}
                onChange={(event) => onAgentChange(event.target.value)}
              />
            </ActionRow>
          </>
        )}
      </div>

      <div className="cx-assistant-action__foot">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" variant="primary" icon={action.kind === 'navigate' ? 'arrowRight' : 'check'} loading={executing} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/* ================================================================== */
/* 主组件                                                              */
/* ================================================================== */

export function Assistant() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const routeMatch = pathname.match(/^\/projects\/([^/]+)/);
  const routeProjectId = routeMatch ? decodeURIComponent(routeMatch[1] ?? '') : undefined;
  const taskId = new URLSearchParams(search).get('task') ?? undefined;
  const fullPath = `${pathname}${search}`;
  const [override, setOverride] = useState<{ id: string; name: string } | null>(null);
  const projectId = routeProjectId ?? override?.id;
  const meta = pageLabel(pathname);

  const [open, setOpen] = useState(() => localStorage.getItem('hive.assistant.open') !== '0');
  const [mode, setMode] = useState<'float' | 'docked' | 'expanded'>('docked');
  const [floatWidth, setFloatWidth] = useState(() => {
    const saved = Number(localStorage.getItem('hive.assistant.width.float'));
    return Number.isFinite(saved) && saved >= 360 ? saved : 680;
  });
  const [dockWidth, setDockWidth] = useState(() => {
    const saved = Number(localStorage.getItem('hive.assistant.width.docked'));
    return Number.isFinite(saved) && saved >= 360 ? saved : 430;
  });
  const [drawer, setDrawer] = useState<{ open: boolean; width: number }>({ open: false, width: 0 });
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 'welcome', role: 'assistant', text: WELCOME }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectContext | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);

  useEffect(() => {
    localStorage.setItem('hive.assistant.mode', mode);
  }, [mode]);
  useEffect(() => {
    localStorage.setItem('hive.assistant.open', open ? '1' : '0');
  }, [open]);
  useEffect(() => {
    localStorage.setItem('hive.assistant.width.float', String(floatWidth));
  }, [floatWidth]);
  useEffect(() => {
    localStorage.setItem('hive.assistant.width.docked', String(dockWidth));
  }, [dockWidth]);
  useEffect(() => {
    const onDrawer = (event: Event) => {
      const detail = (event as CustomEvent<{ open: boolean; width: number }>).detail;
      if (!detail) return;
      setDrawer({ open: Boolean(detail.open), width: Number(detail.width) || 0 });
    };
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('hive:drawer', onDrawer);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('hive:drawer', onDrawer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const idRef = useRef(0);
  const projectCache = useRef(new Map<string, ProjectContext>());
  const projectsRef = useRef<ProjectSummary[] | null>(null);
  const pendingIntentRef = useRef<ParsedIntent | null>(null);
  const clarificationRef = useRef<AutomationIntent | null>(null);
  const bounceTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const nextId = useCallback((prefix: string) => {
    idRef.current += 1;
    return `${prefix}-${idRef.current}`;
  }, []);

  const projectName = projectInfo?.name ?? (projectId ? override?.id === projectId ? override.name : '当前项目' : undefined);

  const pushMessage = useCallback((message: Omit<ChatMessage, 'id'>): string => {
    const id = nextId('msg');
    setMessages((prev) => [...prev, { ...message, id }]);
    return id;
  }, [nextId]);

  /* ---------------- 项目上下文 ---------------- */

  const loadProjectContext = useCallback(async (id: string): Promise<ProjectContext> => {
    const cached = projectCache.current.get(id);
    if (cached) return cached;
    const [detail, agents] = await Promise.all([api.project(id), api.projectAgents(id)]);
    const context: ProjectContext = {
      id,
      name: detail.project.name,
      agents: agents.filter((item) => item.status === 'active'),
    };
    projectCache.current.set(id, context);
    return context;
  }, []);

  useEffect(() => {
    if (routeProjectId) setOverride(null);
  }, [routeProjectId]);

  useEffect(() => {
    if (!open || !projectId) {
      setProjectInfo(null);
      return;
    }
    let active = true;
    setProjectInfo(null);
    loadProjectContext(projectId)
      .then((context) => {
        if (active) setProjectInfo(context);
      })
      .catch(() => {
        if (active) setProjectInfo(null);
      });
    return () => {
      active = false;
    };
  }, [open, projectId, loadProjectContext]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, pendingAction, busy, open]);

  useEffect(() => {
    return () => {
      if (bounceTimer.current) window.clearTimeout(bounceTimer.current);
    };
  }, []);

  /* ---------------- 页面动作构建 ---------------- */

  function buildNavigateAction(
    intent: NavigateIntent,
    pid: string | undefined,
    pname: string | undefined,
  ): NavigateAction {
    const base = pid ? `/projects/${encodeURIComponent(pid)}` : null;
    // 任务页的 ?type= 一次只接受一种类型，取用户提到的第一个；其它类型会在预览中提示。
    const primaryType = intent.filterTypes[0];
    const query = primaryType ? `?type=${primaryType}` : '';
    const typeLabels = intent.filterTypes.map((type) => taskKindLabel(type));
    const filterNote = primaryType ? `筛选类型：${taskKindLabel(primaryType)}` : '';
    const typeNote =
      intent.filterTypes.length > 1
        ? `任务页一次支持一种类型，本次使用「${taskKindLabel(primaryType!)}」，其余类型可在页面切换。`
        : undefined;
    const id = nextId('act');

    const build = (
      to: string,
      label: string,
      description: string,
      note?: string,
      needsProject?: boolean,
    ): NavigateAction => ({
      id,
      kind: 'navigate',
      to,
      label,
      description,
      note,
      needsProject,
      projectId: pid,
      projectName: pname,
    });

    switch (intent.page) {
      case 'tasks': {
        const to = base ? `${base}/tasks${query}` : `/tasks${query}`;
        return build(
          to,
          base ? '项目任务' : '任务',
          base ? `在当前项目打开任务，${filterNote || '查看全部任务'}。` : `打开全局任务列表${filterNote ? `，${filterNote}` : ''}。`,
          typeNote,
        );
      }
      case 'agents':
        return build(base ? `${base}/agents` : '/agents', base ? '项目智员' : '智员', base ? '打开当前项目的智员页签。' : '打开智员列表。');
      case 'instances':
        return build('/instances', '实例', '打开实例列表，查看在线状态与心跳。');
      case 'teams':
        return build('/teams', '团队', '打开团队列表。');
      case 'projects':
        return build('/projects', '项目列表', '打开项目列表。');
      case 'project':
      case 'overview':
        return base
          ? build(base, '项目概览', '打开当前项目概览。')
          : build('/', '概览', '打开控制台概览。');
      case 'activity':
        return base
          ? build(`${base}/activity`, '项目活动', '打开当前项目的活动时间线。')
          : build('/projects', '项目列表', '活动页需要在项目内查看。', '请先选择一个项目，再打开活动页。', true);
      case 'automations':
        return base
          ? build(`${base}/automations`, '项目自动化', '打开当前项目的自动化列表。')
          : build('/projects', '项目列表', '自动化需要在项目内创建。', '请先选择一个项目，再打开自动化页。', true);
      case 'memory':
        return base
          ? build(`${base}/memory`, '项目记忆', '打开当前项目的记忆搜索。')
          : build('/projects', '项目列表', '记忆页需要项目上下文。', '请先选择一个项目，再打开记忆页。', true);
      case 'settings':
        return base
          ? build(`${base}/settings`, '项目设置', '打开当前项目的设置。')
          : build('/projects', '项目列表', '项目设置需要项目上下文。', '请先选择一个项目，再打开设置页。', true);
      default:
        return build('/projects', '项目列表', '打开项目列表。');
    }
  }

  /* ---------------- 项目选择 ---------------- */

  async function askProject(intent: ParsedIntent): Promise<void> {
    pendingIntentRef.current = intent;
    let list = projectsRef.current;
    if (!list) {
      try {
        list = await api.projects();
        projectsRef.current = list;
        setProjects(list);
      } catch (cause) {
        pushMessage({
          role: 'assistant',
          tone: 'error',
          text: `加载项目列表失败：${errorText(cause)}`,
          suggestions: ['打开项目列表'],
        });
        return;
      }
    }
    if (!list.length) {
      pushMessage({
        role: 'assistant',
        text: '你还没有可见的项目，无法创建任务或自动化。请先让管理员把你加入项目，或创建一个新项目。',
        suggestions: ['打开项目列表'],
      });
      return;
    }
    pushMessage({
      role: 'assistant',
      text: intent.kind === 'automation' ? '创建定时自动化需要先选择项目：' : '创建任务需要先选择项目：',
      projectPicker: list.slice(0, 12),
      suggestions: ['打开项目列表'],
    });
  }

  async function chooseProject(project: ProjectSummary): Promise<void> {
    if (busy) return;
    setOverride({ id: project.id, name: project.name });
    pushMessage({ role: 'user', text: `选择项目：${project.name}` });
    const intent = pendingIntentRef.current;
    pendingIntentRef.current = null;
    if (!intent) return;
    setBusy(true);
    try {
      await routeIntent(intent, project.id, project.name);
    } catch (cause) {
      pushMessage({ role: 'assistant', tone: 'error', text: `处理失败：${errorText(cause)}` });
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 写操作准备 ---------------- */

  async function prepareTask(intent: TaskIntent, pid: string, pname?: string): Promise<void> {
    const context = await loadProjectContext(pid);
    const projectLabel = context.name || pname || '当前项目';
    if (!context.agents.length) {
      pushMessage({
        role: 'assistant',
        text: `项目「${projectLabel}」还没有已绑定且生效的智员，暂时不能创建任务。请先在项目「智员」页关联智员。`,
        suggestions: ['打开项目智员'],
      });
      return;
    }
    const matched = findMentionedAgent(context.agents, intent.agentName, intent.raw);
    const agent = matched ?? context.agents.find((item) => item.role === 'developer') ?? context.agents[0]!;
    const action: TaskAction = {
      id: nextId('act'),
      kind: 'task',
      projectId: pid,
      projectName: projectLabel,
      title: intent.title,
      prompt: intent.prompt,
      type: intent.type,
      agents: context.agents,
      agentId: agent.agentId,
    };
    const note =
      intent.agentName && !matched
        ? `未在项目智员中找到「${intent.agentName}」，已先选择「${agent.agent.name}」，可在卡片里改选。`
        : '';
    pushMessage({
      role: 'assistant',
      text: `将创建任务「${action.title}」。${note ? ` ${note}` : ''}`,
      actionId: action.id,
    });
    setPendingAction(action);
  }

  async function prepareAutomation(intent: AutomationIntent, pid: string, pname?: string): Promise<void> {
    if (!intent.schedule) return;
    const context = await loadProjectContext(pid);
    const projectLabel = context.name || pname || '当前项目';
    if (!context.agents.length) {
      pushMessage({
        role: 'assistant',
        text: `项目「${projectLabel}」还没有已绑定且生效的智员，暂时不能创建自动化。请先在项目「智员」页关联智员。`,
        suggestions: ['打开项目智员'],
      });
      return;
    }
    const matched = findMentionedAgent(context.agents, intent.agentName, intent.raw);
    const agent = matched ?? context.agents.find((item) => item.role === 'developer') ?? context.agents[0]!;
    const action: AutomationAction = {
      id: nextId('act'),
      kind: 'automation',
      projectId: pid,
      projectName: projectLabel,
      name: buildAutomationName(intent),
      schedule: intent.schedule,
      email: intent.email,
      promptTemplate: buildAutomationPrompt(intent, projectLabel),
      agents: context.agents,
      agentId: agent.agentId,
      topic: intent.topic,
    };
    pushMessage({
      role: 'assistant',
      text: `将创建定时自动化「${action.name}」，由「${agent.agent.name}」执行。`,
      actionId: action.id,
    });
    setPendingAction(action);
  }

  /* ---------------- 意图路由 ---------------- */

  async function routeIntent(intent: ParsedIntent, pid = projectId, pname = projectName): Promise<void> {
    if (intent.kind === 'navigate') {
      const action = buildNavigateAction(intent, pid, pname);
      pushMessage({
        role: 'assistant',
        text: action.needsProject ? '这个页面需要项目上下文，先帮你打开项目列表。' : `将打开${action.label}。`,
        actionId: action.id,
      });
      setPendingAction(action);
      return;
    }

    if (intent.kind === 'task') {
      if (!intent.title) {
        pushMessage({
          role: 'assistant',
          text: '请告诉我要创建什么任务，例如「创建任务：修复登录页 bug」或「让 Orion 做接口文档」。',
          suggestions: ['创建任务：修复登录页 bug', '让 Orion 做接口文档'],
        });
        return;
      }
      if (!pid) {
        await askProject(intent);
        return;
      }
      await prepareTask(intent, pid, pname);
      return;
    }

    if (intent.kind === 'automation') {
      if (!pid) {
        await askProject(intent);
        return;
      }
      if (!intent.schedule) {
        clarificationRef.current = intent;
        pushMessage({
          role: 'assistant',
          text: '请补充定时频次，例如「每天 10 点」「每周一 9 点」或「工作日 9:30」。',
          suggestions: ['每天 10 点', '每周一 9 点', '工作日 9:30'],
        });
        return;
      }
      if (intent.missing.includes('email')) {
        clarificationRef.current = intent;
        pushMessage({
          role: 'assistant',
          text: '请补充收件邮箱，例如 yechao@rising.com.cn。',
          suggestions: ['yechao@rising.com.cn'],
        });
        return;
      }
      await prepareAutomation(intent, pid, pname);
      return;
    }

    pushMessage({
      role: 'assistant',
      text: UNKNOWN_HELP,
      suggestions: suggestionsFor(Boolean(pid)),
    });
  }

  /* ---------------- 发送 ---------------- */

  async function submitText(rawText?: string): Promise<void> {
    const content = (rawText ?? input).trim();
    if (!content || busy || executing) return;
    setInput('');
    setPendingAction(null);
    pushMessage({ role: 'user', text: content });
    setBusy(true);
    try {
      // 优先交给 DSH 实例：它可以读取 docs/api.md 并直接调用 Hive 开放 API。
      try {
        const result = await api.assistantChat({
          message: content,
          pathname: fullPath,
          projectId: projectId ?? undefined,
          taskId,
        });
        pushMessage({ role: 'assistant', text: result.reply || '已完成。' });
        if (result.navigate) navigate(result.navigate);
        window.dispatchEvent(new CustomEvent('hive:assistant-refresh'));
        return;
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 503) throw cause;
        pushMessage({
          role: 'assistant',
          tone: 'error',
          text: 'DSH 助手实例暂不可用，已退回本地意图解析。',
        });
      }

      let intent = parseIntent(content);
      const clarification = clarificationRef.current;
      if (clarification) {
        clarificationRef.current = null;
        const merged = parseIntent(`${clarification.raw} ${content}`);
        if (merged.kind === 'automation' && merged.missing.length < clarification.missing.length) {
          intent = merged;
        }
      }
      await routeIntent(intent);
    } catch (cause) {
      pushMessage({
        role: 'assistant',
        tone: 'error',
        text: `处理请求时出错：${errorText(cause)}`,
        suggestions: suggestionsFor(Boolean(projectId)),
      });
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 执行 ---------------- */

  function notifyRefresh(pid: string, kind: 'task' | 'automation', id: string): void {
    window.dispatchEvent(
      new CustomEvent('hive:assistant-refresh', {
        detail: { projectId: pid, kind, id },
      }),
    );
  }

  function goProjectPage(pid: string, suffix: string, query = ''): void {
    const base = `/projects/${encodeURIComponent(pid)}`;
    const targetPath = `${base}${suffix}`;
    const targetUrl = `${targetPath}${query}`;
    if (window.location.pathname === targetPath) {
      // 当前已在该页时，先回概览再跳回，触发子页面重新挂载并拉取最新数据。
      navigate(base, { replace: true });
      if (bounceTimer.current) window.clearTimeout(bounceTimer.current);
      bounceTimer.current = window.setTimeout(() => {
        bounceTimer.current = null;
        navigate(targetUrl, { replace: true });
      }, 90);
      return;
    }
    navigate(targetUrl);
  }

  async function executeAction(action: PendingAction): Promise<void> {
    if (busy || executing) return;
    setBusy(true);
    setExecuting(true);
    try {
      if (action.kind === 'navigate') {
        navigate(action.to);
        setPendingAction(null);
        pushMessage({
          role: 'assistant',
          text: `已打开${action.label}。`,
          suggestions: suggestionsFor(Boolean(action.projectId)),
        });
        return;
      }

      if (action.kind === 'task') {
        const agent = action.agents.find((item) => item.agentId === action.agentId);
        // 任务类型字段后端合并前先按字符串传递；metadata 里同时保留，便于后续筛选。
        const payload = {
          agentId: action.agentId,
          title: action.title,
          prompt: action.prompt,
          source: 'human' as const,
          metadata: { type: action.type, assistant: 'hive-assistant' },
          type: action.type,
        };
        const task = await api.createTask(action.projectId, payload);
        toast.success(`任务已创建：${task.title}`);
        setPendingAction(null);
        notifyRefresh(action.projectId, 'task', task.id);
        pushMessage({
          role: 'assistant',
          tone: 'success',
          text: `已创建任务「${task.title}」。\n执行智员：${agent?.agent.name ?? '项目智员'}\n项目：${action.projectName}`,
          suggestions: ['打开任务', '创建任务：修复登录页 bug', '打开自动化'],
        });
        goProjectPage(action.projectId, `/tasks/${encodeURIComponent(task.id)}`);
        return;
      }

      const agent = action.agents.find((item) => item.agentId === action.agentId);
      const created = await api.createAutomation(action.projectId, {
        name: action.name,
        agentId: action.agentId,
        triggerType: 'cron',
        triggerConfig: { schedule: action.schedule.schedule },
        promptTemplate: action.promptTemplate,
        enabled: true,
      });
      toast.success(`定时自动化已创建：${created.name}`);
      setPendingAction(null);
      notifyRefresh(action.projectId, 'automation', created.id);
      pushMessage({
        role: 'assistant',
        tone: 'success',
        text: `已创建定时自动化「${created.name}」。\n频次：${action.schedule.human}（cron: ${action.schedule.schedule}）\n执行智员：${agent?.agent.name ?? '项目智员'}${
          action.email ? `\n收件邮箱：${action.email}` : ''
        }`,
        suggestions: ['打开自动化', '每天 9 点生成开发简报，发送到 yechao@rising.com.cn'],
      });
      goProjectPage(action.projectId, '/automations');
    } catch (cause) {
      const message = errorText(cause);
      toast.error(message);
      pushMessage({
        role: 'assistant',
        tone: 'error',
        text: `操作失败：${message}\n待确认的操作已保留，可重试或取消。`,
        suggestions: ['打开项目'],
      });
    } finally {
      setBusy(false);
      setExecuting(false);
    }
  }

  function cancelAction(): void {
    setPendingAction(null);
    pushMessage({ role: 'assistant', text: '已取消，没有执行任何写操作。' });
  }

  function changeAgent(agentId: string): void {
    setPendingAction((prev) => {
      if (!prev || prev.kind === 'navigate') return prev;
      return { ...prev, agentId };
    });
  }

  /* ---------------- 渲染 ---------------- */

  const lastAssistantSuggestions = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === 'assistant' && message.suggestions?.length) return message.suggestions;
    }
    return null;
  }, [messages]);

  const width = mode === 'docked' ? dockWidth : floatWidth;
  const setWidth = mode === 'docked' ? setDockWidth : setFloatWidth;
  const drawerWidthPx = drawer.open ? (viewport * drawer.width) / 100 : 0;
  const available = viewport - drawerWidthPx - (drawer.open ? 32 : 0);
  const drawerHidden = drawer.open && (viewport <= 900 || available < 280);
  const effectiveMode = drawer.open && mode === 'expanded' ? 'docked' : mode;
  const panelWidth = drawer.open ? Math.max(300, Math.min(width, Math.max(300, available))) : width;
  const startResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (mode === 'expanded') return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = width;
    const max = 720;
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(max, Math.max(360, startWidth + (startX - moveEvent.clientX)));
      setWidth(next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const chips = lastAssistantSuggestions ?? suggestionsFor(Boolean(projectId));
  const contextProjectName = projectInfo?.name ?? (override && override.id === projectId ? override.name : undefined);
  const pagePath = fullPath.length > 58 ? `${fullPath.slice(0, 56)}…` : fullPath;

  return (
    <div
      className={`cx-assistant mode-${effectiveMode} ${open ? 'is-open' : ''} ${drawer.open ? 'has-drawer' : ''} ${drawer.open && available < 360 ? 'drawer-tight' : ''}`}
      style={open ? { width: Math.min(720, Math.max(360, width)) } : undefined}
    >
      {drawerHidden ? null : open ? (
        <section
          id="cx-assistant-panel"
          className={`cx-assistant-panel mode-${effectiveMode}`}
          style={effectiveMode === 'expanded' ? undefined : { width: panelWidth, maxWidth: 'calc(100vw - 24px)' }}
          role="dialog"
          aria-label="Hive 操作助手"
        >
          {effectiveMode !== 'expanded' ? (
            <span
              className="cx-assistant-resize"
              title="拖动调整宽度"
              aria-label="拖动调整宽度"
              onPointerDown={startResize}
            />
          ) : null}
          <header className="cx-assistant-head">
            <div className="cx-assistant-brand">
              <span className="cx-assistant-brand__mark">H</span>
              <div style={{ minWidth: 0 }}>
                <div className="cx-assistant-brand__title">
                  Hive 助手
                  <Badge size="sm" tone="cyan">
                    DSH 实例
                  </Badge>
                </div>
                <div className="cx-assistant-brand__sub">DSH 实例 · 可调用全部 Hive API</div>
              </div>
            </div>
            <div className="cx-assistant-head-actions">
              <IconButton
                icon="float"
                label="浮动窗口"
                size="sm"
                className={mode === 'float' ? 'cx-assistant-mode is-active' : 'cx-assistant-mode'}
                onClick={() => setMode('float')}
              />
              <IconButton
                icon="panelLeft"
                label="右侧停靠"
                size="sm"
                className={mode === 'docked' ? 'cx-assistant-mode is-active' : 'cx-assistant-mode'}
                onClick={() => setMode('docked')}
              />
              <IconButton
                icon="maximize"
                label="全屏"
                size="sm"
                className={mode === 'expanded' ? 'cx-assistant-mode is-active' : 'cx-assistant-mode'}
                onClick={() => setMode('expanded')}
              />
              <IconButton icon="x" label="关闭助手" size="sm" onClick={() => setOpen(false)} />
            </div>
          </header>

          <div className="cx-assistant-context">
            <div className="cx-assistant-context__main">
              <span className="cx-assistant-context__page">
                <Icon name="panelLeft" size={12} />
                {meta}
              </span>
              {projectId ? (
                <Badge size="sm" tone="cyan" className="cx-assistant-context__project">
                  {contextProjectName ?? projects?.find((item) => item.id === projectId)?.name ?? projectId.slice(0, 14)}
                </Badge>
              ) : (
                <span className="cx-assistant-context__empty">未选择项目</span>
              )}
              {taskId ? (
                <Badge size="sm" tone="amber" className="cx-assistant-context__task">
                  任务 {taskId.slice(0, 10)}
                </Badge>
              ) : null}
            </div>
            <div className="cx-assistant-context__path mono" title={pathname}>
              {pagePath}
            </div>
          </div>

          <div className="cx-assistant-messages" ref={scrollRef}>
            {messages.map((message) => (
              <div key={message.id} className={`cx-assistant-msg cx-assistant-msg--${message.role}`}>
                {message.role === 'assistant' ? <span className="cx-assistant-avatar">H</span> : null}
                <div className="cx-assistant-bubble">
                  {message.text ? (
                    <div className={`cx-assistant-text${message.tone ? ` cx-assistant-text--${message.tone}` : ''}`}>
                      <Markdown text={message.text} />
                    </div>
                  ) : null}

                  {message.projectPicker ? (
                    <div className="cx-assistant-projects">
                      {message.projectPicker.map((project) => (
                        <button
                          key={project.id}
                          type="button"
                          className="cx-assistant-project"
                          disabled={busy}
                          onClick={() => void chooseProject(project)}
                        >
                          <Icon name="folder" size={13} />
                          <span className="cx-assistant-project__name truncate">{project.name}</span>
                          <span className="tiny dim mono truncate">{project.slug}</span>
                        </button>
                      ))}
                      {message.projectPicker.length < (projects?.length ?? message.projectPicker.length) ? (
                        <div className="tiny dim">仅列出前 12 个项目，可打开项目列表查看全部。</div>
                      ) : null}
                    </div>
                  ) : null}

                  {pendingAction && message.actionId === pendingAction.id ? (
                    <ActionPreview
                      action={pendingAction}
                      executing={executing}
                      onCancel={cancelAction}
                      onConfirm={() => void executeAction(pendingAction)}
                      onAgentChange={changeAgent}
                    />
                  ) : null}
                </div>
              </div>
            ))}

            {busy && !executing ? (
              <div className="cx-assistant-msg cx-assistant-msg--assistant">
                <span className="cx-assistant-avatar">H</span>
                <div className="cx-assistant-bubble cx-assistant-typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : null}
          </div>

          <div className="cx-assistant-suggestions">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                className="cx-assistant-chip"
                disabled={busy || executing}
                onClick={() => void submitText(chip)}
              >
                {chip}
              </button>
            ))}
          </div>

          <form
            className="cx-assistant-input"
            onSubmit={(event) => {
              event.preventDefault();
              void submitText();
            }}
          >
            <Textarea
              rows={2}
              value={input}
              autoFocus
              placeholder={projectId ? '例如：每天 10 点生成开发简报，发送到 yechao@rising.com.cn' : '例如：打开任务 / 每天 10 点生成开发简报'}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitText();
                }
              }}
            />
            <Button
              type="submit"
              variant="primary"
              icon="send"
              loading={busy}
              disabled={!input.trim() || busy || executing}
            >
              发送
            </Button>
          </form>

          <footer className="cx-assistant-foot">
            <span>Enter 发送 · Shift+Enter 换行</span>
            <span className="dim">DSH 实例 · Hive API</span>
          </footer>
        </section>
      ) : null}

      {!drawerHidden && !(open && effectiveMode !== 'float') ? (
      <button
        type="button"
        className={`cx-assistant-fab ${open ? 'is-open' : ''}`}
        aria-expanded={open}
        aria-controls="cx-assistant-panel"
        title={open ? '收起 Hive 助手' : '打开 Hive 助手'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="cx-assistant-fab__icon">
          <Icon name={open ? 'x' : 'sparkles'} size={18} />
        </span>
        <span className="cx-assistant-fab__label">{open ? '收起' : '助手'}</span>
      </button>
      ) : null}
    </div>
  );
}
