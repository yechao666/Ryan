/**
 * Hive 共享契约：数字员工工作平台（人员管理智员，智员在项目中工作）。
 * 前后端唯一事实来源；HTTP JSON 均为 camelCase。
 */

export type TeamRole = 'lead' | 'member';
export type ProjectRole = 'owner' | 'maintainer' | 'developer' | 'reporter';
export type Visibility = 'private' | 'team' | 'public';
export type ProjectType = 'manual' | 'github' | 'gitlab' | 'local';
export type AgentStatus = 'active' | 'paused' | 'retired';
export type TaskStatus = 'queued' | 'assigned' | 'running' | 'waiting_input' | 'done' | 'failed' | 'cancelled';
export type TaskSource = 'human' | 'automation' | 'webhook' | 'api' | 'seed';
export type TaskType = 'feature' | 'bugfix' | 'management' | 'ops' | 'docs' | 'other';
export type InstanceStatus = 'online' | 'offline' | 'revoked';
export type AutomationTrigger = 'manual' | 'webhook' | 'cron';
export type MessageAuthor = 'person' | 'agent' | 'system';
export type EventType =
  | 'task.created'
  | 'task.claimed'
  | 'task.progress'
  | 'task.message'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.runtime'
  | 'instance.online'
  | 'instance.offline'
  | 'project.created'
  | 'agent.bound';

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
  /** 项目提示词：项目基本面，随任务注入 DSH 运行时提示词。 */
  prompt: string;
  repoUrl?: string;
  status: 'active' | 'archived';
  mnemosProjectId?: string;
  /** 只返回是否已配置密钥，不返回明文 */
  mnemosConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCounts {
  agents: number;
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

export interface Agent {
  id: string;
  ownerPersonId: string;
  ownerName: string;
  name: string;
  role: string;
  model: string;
  description: string;
  capabilities: string[];
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  stats: {
    projects: number;
    runningTasks: number;
    queuedTasks: number;
    onlineInstances: number;
  };
}

export interface ProjectAgent {
  id: string;
  projectId: string;
  agentId: string;
  memoryAgentId: string;
  role: string;
  status: 'active' | 'paused';
  addedBy?: string;
  addedAt: string;
  agent: {
    name: string;
    role: string;
    model: string;
    ownerName: string;
    capabilities: string[];
  };
  onlineInstances: number;
}

export interface AgentToken {
  id: string;
  agentId: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface AgentTokenWithSecret extends AgentToken {
  secret: string;
}

export interface Instance {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  host: string;
  workspacePath: string;
  version: string;
  status: InstanceStatus;
  lastSeenAt?: string;
  registeredAt: string;
  revokedAt?: string;
  currentTask?: {
    id: string;
    title: string;
    projectName: string;
  };
}

export interface WorkItem {
  id: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  source: TaskSource;
  type: TaskType;
  title: string;
  prompt: string;
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

export interface TaskMessage {
  id: string;
  taskId: string;
  authorType: MessageAuthor;
  authorId?: string;
  authorName: string;
  content: string;
  createdAt: string;
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
  messages: TaskMessage[];
  events: TaskEvent[];
  memory: {
    projectId?: string;
    agentMemoryId?: string;
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
  agentId?: string;
  createdAt: string;
}

export interface Automation {
  id: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  name: string;
  triggerType: AutomationTrigger;
  triggerConfig: {
    events?: string[];
    branch?: string;
    schedule?: string;
    secret?: string;
  };
  promptTemplate: string;
  enabled: boolean;
  createdBy?: string;
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
  agents: Agent[];
  instances: Instance[];
  tasks: {
    queued: number;
    running: number;
    waitingInput: number;
    doneToday: number;
    failedToday: number;
  };
  activity: ActivityEvent[];
}

/** 运行时（DSH 实例）协议 */
export interface InstanceRegisterInput {
  name: string;
  host: string;
  workspacePath: string;
  version: string;
}

export interface InstanceRegisterResult {
  instance: Instance;
  /** 一次性返回，之后只存哈希 */
  token: string;
}

export interface ClaimedTask {
  task: WorkItem;
  project: {
    id: string;
    name: string;
    slug: string;
    prompt: string;
    repoUrl?: string;
    type: ProjectType;
  };
  agent: {
    id: string;
    name: string;
    memoryAgentId: string;
    capabilities: string[];
  };
  memory: {
    baseUrl: string;
    projectId: string;
    apiKey: string;
    agentId: string;
    enabled: boolean;
  };
  messages: TaskMessage[];
}

export interface CompleteTaskInput {
  status: 'done' | 'failed';
  summary: string;
  decisions?: string[];
  lessons?: string[];
  error?: string;
  /** headless 会话 id；用于任务完成后继续对话。 */
  sessionId?: string;
}

export interface TaskConversation {
  task: WorkItem;
  sessionId: string;
  messages: TaskMessage[];
}

/** DSH 运行时原始事件（headless NDJSON 投影）。 */
export interface RuntimeEvent {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateTaskInput {
  agentId: string;
  title: string;
  prompt: string;
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
}

export interface CreateAgentInput {
  name: string;
  role?: string;
  model?: string;
  description?: string;
  capabilities?: string[];
}

export interface BindAgentInput {
  agentId: string;
  memoryAgentId?: string;
  role?: string;
}

export interface CreateAutomationInput {
  name: string;
  agentId: string;
  triggerType: AutomationTrigger;
  triggerConfig?: Automation['triggerConfig'];
  promptTemplate: string;
  enabled?: boolean;
}

export interface LiveEvent {
  id: string;
  type: EventType;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  agentId?: string;
  actor: string;
  summary: string;
  at: string;
  /** task.runtime 事件携带的原始运行时数据。 */
  runtime?: RuntimeEvent;
}
