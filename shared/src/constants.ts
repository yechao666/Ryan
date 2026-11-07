import type {
  AutomationTrigger,
  InstanceKind,
  InstanceStatus,
  PromptCardCategory,
  PromptCardScope,
  ProjectRole,
  ProjectType,
  TaskStatus,
  TaskType,
  TeamRole,
  Visibility,
  DemoAccount,
} from './types.ts';

export const APP_NAME = 'Aiwo';
export const APP_TAGLINE = '人员 @Aiwo 的 DSH 编排平台';
export const APP_VERSION = '0.1.0';
export const DEFAULT_SERVER_PORT = 4500;
export const DEMO_PASSWORD = 'aiwo-demo';
export const PAGE_SIZE = 20;

export const TEAM_ROLES: { value: TeamRole; label: string }[] = [
  { value: 'lead', label: '团队负责人' },
  { value: 'member', label: '成员' },
];

export const PROJECT_ROLES: { value: ProjectRole; label: string; desc: string }[] = [
  { value: 'owner', label: '项目负责人', desc: '全部权限，可删除项目' },
  { value: 'maintainer', label: '维护者', desc: '管理实例、提示词卡片与成员' },
  { value: 'developer', label: '开发者', desc: '创建任务、引用提示词卡片' },
  { value: 'reporter', label: '观察者', desc: '只读' },
];

export const VISIBILITIES: { value: Visibility; label: string; desc: string; tone: string }[] = [
  { value: 'private', label: '私有', desc: '仅项目归属人可见', tone: 'amber' },
  { value: 'team', label: '团队', desc: '归属团队成员可见', tone: 'cyan' },
  { value: 'public', label: '组织公开', desc: '组织内所有人员可见', tone: 'green' },
];

export const PROJECT_TYPES: { value: ProjectType; label: string; tone: string }[] = [
  { value: 'manual', label: '手动项目', tone: 'slate' },
  { value: 'github', label: 'GitHub 仓库', tone: 'violet' },
  { value: 'gitlab', label: 'GitLab 仓库', tone: 'amber' },
  { value: 'local', label: '本地 Git 仓库', tone: 'cyan' },
];

export const TASK_STATUSES: { value: TaskStatus; label: string; tone: string }[] = [
  { value: 'queued', label: '排队中', tone: 'slate' },
  { value: 'assigned', label: '已接单', tone: 'blue' },
  { value: 'running', label: '执行中', tone: 'violet' },
  { value: 'waiting_input', label: '等待输入', tone: 'amber' },
  { value: 'done', label: '已完成', tone: 'green' },
  { value: 'failed', label: '失败', tone: 'red' },
  { value: 'cancelled', label: '已取消', tone: 'slate' },
];

/** 任务类型（控制台任务表格 / 筛选器使用）。 */
export const TASK_TYPES: { value: TaskType; label: string; tone: string }[] = [
  { value: 'feature', label: '需求', tone: 'violet' },
  { value: 'bugfix', label: 'BUGFIX', tone: 'red' },
  { value: 'management', label: '管理', tone: 'amber' },
  { value: 'ops', label: '运维', tone: 'blue' },
  { value: 'docs', label: '文档', tone: 'green' },
  { value: 'other', label: '其他', tone: 'slate' },
];

/** 任务类型 value → 中文 label。 */
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  feature: '需求',
  bugfix: 'BUGFIX',
  management: '管理',
  ops: '运维',
  docs: '文档',
  other: '其他',
};

export const PROMPT_CARD_CATEGORIES: { value: PromptCardCategory; label: string; tone: string; desc: string }[] = [
  { value: 'workflow', label: '工作流', tone: 'violet', desc: '步骤、顺序、交付物与验收方式' },
  { value: 'style', label: '工作风格', tone: 'cyan', desc: '沟通方式、输出格式与偏好' },
  { value: 'standard', label: '工作标准', tone: 'amber', desc: '质量门槛、规范与禁止事项' },
  { value: 'role', label: '角色说明', tone: 'green', desc: '任务执行时采用的身份与职责' },
  { value: 'other', label: '其他', tone: 'slate', desc: '其他可复用上下文' },
];

export const PROMPT_CARD_SCOPES: { value: PromptCardScope; label: string; desc: string }[] = [
  { value: 'org', label: '公共', desc: '全员所有项目可引用' },
  { value: 'team', label: '团队', desc: '归属团队的项目可引用' },
  { value: 'project', label: '项目', desc: '仅指定项目可引用' },
  { value: 'person', label: '个人', desc: '仅本人可引用' },
];

export const INSTANCE_KINDS: { value: InstanceKind; label: string; tone: string; desc: string }[] = [
  { value: 'local', label: '本机 DSH', tone: 'cyan', desc: '由 Aiwo 在本机拉起服务代理' },
  { value: 'remote', label: '远端 DSH', tone: 'violet', desc: '远端需安装 Aiwo 通讯插件' },
];

export const INSTANCE_STATUSES: { value: InstanceStatus; label: string; tone: string }[] = [
  { value: 'online', label: '在线', tone: 'green' },
  { value: 'offline', label: '离线', tone: 'slate' },
  { value: 'unconfigured', label: '待安装插件', tone: 'amber' },
  { value: 'error', label: '异常', tone: 'red' },
  { value: 'revoked', label: '已吊销', tone: 'slate' },
];

export const DEFAULT_SECURITY_SETTINGS = {
  enabled: false,
  endpoint: '',
  model: '',
  timeoutMs: 8000,
  blockMessage: '该输入未通过安全检查，请调整后重试。',
};

export const AUTOMATION_TRIGGERS: { value: AutomationTrigger; label: string; desc: string }[] = [
  { value: 'manual', label: '手动触发', desc: '在控制台点击运行' },
  { value: 'webhook', label: '仓库 Webhook', desc: 'GitHub / GitLab 事件触发' },
  { value: 'cron', label: '定时任务', desc: '按 5 段 cron 表达式运行' },
];

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: 'lin.wei@aiwo.dev', name: '林薇', title: '平台负责人', role: '组织管理员', password: DEMO_PASSWORD },
  { email: 'chen.hao@aiwo.dev', name: '陈昊', title: '研发一组负责人', role: '团队负责人', password: DEMO_PASSWORD },
  { email: 'zhou.ye@aiwo.dev', name: '周野', title: '算法工程师', role: '成员', password: DEMO_PASSWORD },
  { email: 'su.yan@aiwo.dev', name: '苏妍', title: '数据合规', role: '成员', password: DEMO_PASSWORD },
];

/** 任务状态分组（看板） */
export const TASK_BOARD_GROUPS: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: 'queued', label: '排队 / 待接单', statuses: ['queued', 'assigned'] },
  { key: 'running', label: '执行中', statuses: ['running', 'waiting_input'] },
  { key: 'done', label: '已完成', statuses: ['done'] },
  { key: 'failed', label: '失败 / 取消', statuses: ['failed', 'cancelled'] },
];

export const ACTIVITY_LABELS: Record<string, string> = {
  'task.created': '创建任务',
  'task.claimed': '实例接单',
  'task.progress': '执行进展',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.cancelled': '任务取消',
  'task.runtime': '运行时',
  'instance.online': '实例上线',
  'instance.offline': '实例离线',
  'instance.registered': '实例注册',
  'project.created': '创建项目',
};
