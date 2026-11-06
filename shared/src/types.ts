/**
 * Aiwo 共享契约：以 DSH 实例为资源，人员 @Aiwo 直接执行项目任务。
 * 前后端唯一事实来源；HTTP JSON 均为 camelCase。
 */

export type TeamRole = 'lead' | 'member';
export type ProjectRole = 'owner' | 'maintainer' | 'developer' | 'reporter';
export type Visibility = 'private' | 'team' | 'public';
export type ProjectType = 'manual' | 'github' | 'gitlab' | 'local';
export type TaskStatus = 'queued' | 'assigned' | 'running' | 'waiting_input' | 'done' | 'failed' | 'cancelled';
export type TaskSource = 'human' | 'automation' | 'webhook' | 'api' | 'seed';
export type TaskType = 'feature' | 'bugfix' | 'management' | 'ops' | 'docs' | 'other';
export type InstanceStatus = 'online' | 'offline' | 'unconfigured' | 'error' | 'revoked';
export type InstanceKind = 'local' | 'remote';
export type AutomationTrigger = 'manual' | 'webhook' | 'cron';
export type MessageAuthor = 'person' | 'aiwo' | 'system';
export type EventType =
  | 'task.created'
  | 'task.claimed'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.runtime'
  | 'instance.online'
  | 'instance.offline'
  | 'instance.registered'
  | 'project.created';

/** 可管理、可被任务引用的提示词卡片。 */
export type PromptCardCategory = 'workflow' | 'style' | 'standard' | 'role' | 'other';
export type PromptCardScope = 'org' | 'team' | 'project';

export interface Person {
  id: string;
  name: string;
  email: string;
  title: string;
  avatarColor: string;
  isAdmin: boolean;
  createdAt: string;
  lastSeenAt?: string;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  description: string;
  leadPersonId?: string;
  leadName?: string;
  memberCount: number;
  projectCount: number;
  createdAt: string;
}

export interface TeamMember {
  teamId: string;
  personId: string;
  name: string;
  email: string;
  role: TeamRole;
  avatarColor: string;
  joinedAt: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerTeamId?: string;
  ownerTeamName?: string;
  ownerPersonId: string;
  ownerPersonName: string;
  visibility: Visibility;
  type: ProjectType;
  prompt: string;
  repoUrl?: string;
  status: 'active' | 'archived';
  mnemosProjectId?: string;
  mnemosConfigured: boolean;
  /** Mnemos 项目级记忆身份；为空时使用 aiwo_<slug>。 */
  memoryAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCounts {
  promptCards: number;
  tasks: number;
  activeTasks: number;
  instances: number;
  members: number;
}

export interface ProjectSummary extends Project {
  counts: ProjectCounts;
  lastActivityAt?: string;
}

export interface ProjectMember {
  projectId: string;
  personId: string;
  name: string;
  email: string;
  role: ProjectRole;
  avatarColor: string;
  addedAt: string;
}

/** 提示词卡片：只作为任务/自动化的可引用上下文，不等于执行角色。 */
export interface PromptCard {
  id: string;
  name: string;
  category: PromptCardCategory;
  description: string;
  content: string;
  scope: PromptCardScope;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamName?: string;
  enabled: boolean;
  createdBy?: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptCardInput {
  name: string;
  category?: PromptCardCategory;
  description?: string;
  content: string;
  scope?: PromptCardScope;
  projectId?: string;
  teamId?: string;
  enabled?: boolean;
}

/** 可独立管理的 DSH 实例资源。 */
export interface DshInstance {
  id: string;
  name: string;
  kind: InstanceKind;
  host: string;
  port?: number;
  baseUrl?: string;
  workspacePath: string;
  version: string;
  pluginVersion?: string;
  status: InstanceStatus;
  lastSeenAt?: string;
  registeredAt: string;
  revokedAt?: string;
  createdBy?: string;
  createdAt: string;
  projectIds: string[];
  projectNames: string[];
  currentTask?: {
    id: string;
    title: string;
    projectName: string;
  };
  /** 是否已生成过实例 token（不返回明文） */
  hasToken: boolean;
}

export type Instance = DshInstance;

export interface DshInstanceInput {
  name: string;
  kind?: InstanceKind;
  host?: string;
  port?: number;
  baseUrl?: string;
  workspacePath?: string;
  projectIds?: string[];
}

export interface InstanceRegisterInput {
  name: string;
  kind?: InstanceKind;
  host: string;
  port?: number;
  workspacePath: string;
  version: string;
  pluginVersion?: string;
}

export interface InstanceRegisterResult {
  instance: DshInstance;
  token: string;
}

export interface InstanceTokenResult {
  token: string;
  command: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  projectName: string;
  executorPersonId?: string;
  /** 展示名，固定为「姓名@Aiwo」。 */
  executorLabel: string;
  source: TaskSource;
  type: TaskType;
  title: string;
  prompt: string;
  promptCardIds: string[];
  promptCards: { id: string; name: string; category: PromptCardCategory }[];
  status: TaskStatus;
  priority: number;
  leaseUntil?: string;
  instanceId?: string;
  instanceName?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  metadata: Record<string, unknown>;
  messageCount: number;
  lastMessageAt?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  projectId: string;
  instanceId?: string;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDetail {
  task: WorkItem;
  events: TaskEvent[];
  memory: {
    projectId?: string;
    memoryAgentId?: string;
    configured: boolean;
  };
}

export interface ActivityEvent {
  id: string;
  projectId?: string;
  projectName?: string;
  type: EventType;
  actor: string;
  summary: string;
  taskId?: string;
  createdAt: string;
}

export interface Automation {
  id: string;
  projectId: string;
  projectName: string;
  instanceId?: string;
  instanceName?: string;
  name: string;
  triggerType: AutomationTrigger;
  triggerConfig: {
    events?: string[];
    branch?: string;
    schedule?: string;
    secret?: string;
  };
  promptTemplate: string;
  promptCardIds: string[];
  enabled: boolean;
  createdBy?: string;
  createdByName?: string;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  taskId?: string;
  status: string;
  trigger: string;
  createdAt: string;
}

export interface MemoryHit {
  id: string;
  content: string;
  score: number;
  category: string;
  visibility: string;
  agentId?: string;
  taskId?: string;
  createdAt: string;
  signals?: Record<string, number>;
}

export interface MemorySearchResult {
  hits: MemoryHit[];
  tookMs: number;
  configured: boolean;
  error?: string;
}

export interface MemoryContextResult {
  prompt: string;
  tokenEstimate: number;
  citations: string[];
  configured: boolean;
  error?: string;
}

export interface InboundDelivery {
  id: string;
  projectId: string;
  provider: 'github' | 'gitlab';
  deliveryId: string;
  event: string;
  status: 'accepted' | 'ignored' | 'duplicate' | 'rejected' | 'failed';
  taskId?: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  person: Person;
}

export interface DemoAccount {
  email: string;
  name: string;
  title: string;
  role: string;
  password: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DashboardSummary {
  person: Person;
  teams: Team[];
  projects: ProjectSummary[];
  instances: DshInstance[];
  tasks: {
    queued: number;
    running: number;
    waitingInput: number;
    doneToday: number;
    failedToday: number;
  };
  activity: ActivityEvent[];
}

/** 安全检查配置：endpoint 为空即关闭。 */
export interface SecuritySettings {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKeyConfigured: boolean;
  timeoutMs: number;
  blockMessage: string;
}

export interface AssistantSettings {
  enabled: boolean;
  instanceId?: string;
  model?: string;
}

export interface SystemSettings {
  security: SecuritySettings;
  assistant: AssistantSettings;
  updatedAt?: string;
  updatedBy?: string;
}

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  model?: string;
  latencyMs?: number;
  blockedMessage?: string;
}

/** 运行时（DSH 实例）协议 */
export interface ClaimedTask {
  task: WorkItem;
  project: {
    id: string;
    name: string;
    slug: string;
    prompt: string;
    repoUrl?: string;
    type: ProjectType;
    memoryAgentId?: string;
  };
  executor: {
    personId?: string;
    name: string;
    label: string;
  };
  promptCards: { id: string; name: string; category: PromptCardCategory; content: string }[];
  memory: {
    baseUrl: string;
    projectId: string;
    apiKey: string;
    agentId: string;
    enabled: boolean;
  };
}

export interface CompleteTaskInput {
  status: 'done' | 'failed';
  summary: string;
  decisions?: string[];
  lessons?: string[];
  error?: string;
  sessionId?: string;
}

/** DSH 运行时原始事件（ACP/headless 投影）。 */
export interface RuntimeEvent {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateTaskInput {
  title: string;
  prompt: string;
  promptCardIds?: string[];
  instanceId?: string;
  priority?: number;
  source?: TaskSource;
  type?: TaskType;
  metadata?: Record<string, unknown>;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string;
  ownerTeamId?: string;
  visibility?: Visibility;
  type?: ProjectType;
  prompt?: string;
  repoUrl?: string;
  mnemosProjectId?: string;
  mnemosApiKey?: string;
  memoryAgentId?: string;
}

export interface CreateAutomationInput {
  name: string;
  triggerType: AutomationTrigger;
  triggerConfig?: Automation['triggerConfig'];
  promptTemplate: string;
  promptCardIds?: string[];
  instanceId?: string;
  enabled?: boolean;
}

export interface LiveEvent {
  id: string;
  type: EventType;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  actor: string;
  summary: string;
  at: string;
  runtime?: RuntimeEvent;
}
