import type {
  ActivityEvent,
  AssistantSettings,
  AuthResponse,
  Automation,
  AutomationRun,
  CreateAutomationInput,
  CreateProjectInput,
  CreateTaskInput,
  DashboardSummary,
  DshInstance,
  DshInstanceInput,
  InboundDelivery,
  LiveEvent,
  MemoryContextResult,
  MemorySearchResult,
  Paginated,
  Person,
  ProjectMember,
  ProjectSummary,
  PromptCard,
  PromptCardInput,
  RuntimeEvent,
  SecuritySettings,
  SystemSettings,
  TaskDetail,
  Team,
  TeamMember,
  WorkItem,
  ProjectRole,
  TeamRole,
  Visibility,
} from '@shared';

const TOKEN_KEY = 'aiwo.token';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'HTTP_ERROR',
      body?.error?.message ?? `请求失败（${response.status}）`,
      body?.error?.details,
    );
  }
  return payload as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export interface ProjectDetail {
  project: ProjectSummary;
  members: ProjectMember[];
  team?: Team;
}

export interface TeamDetail {
  team: Team;
  members: TeamMember[];
  projects: ProjectSummary[];
}

export interface CreateTaskResult {
  task: WorkItem;
}

/** 新增 DSH 实例的响应：token 与安装命令只返回一次。 */
export interface InstanceCreateResult {
  instance: DshInstance;
  token: string;
  command: string;
}

export interface InstanceTokenResult {
  token: string;
  command: string;
}

export interface InstanceTestResult {
  ok: boolean;
  status: string;
  latencyMs: number | null;
  pluginVersion?: string;
  message: string;
}

export interface SecurityTestResult {
  ok: boolean;
  skipped?: boolean;
  message?: string;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export const api = {
  // ---- auth / meta ----
  login(email: string, password: string): Promise<AuthResponse> {
    return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  },
  me(): Promise<{ person: Person }> {
    return request('/api/auth/me');
  },
  logout(): Promise<{ ok: boolean }> {
    return request('/api/auth/logout', { method: 'POST' });
  },
  meta(): Promise<{
    name: string;
    version: string;
    demo: boolean;
    demoAccounts: { email: string; name: string; title: string; role: string; password: string }[];
    demoPassword?: string;
  }> {
    return request('/api/meta');
  },

  // ---- dashboard ----
  dashboard(): Promise<DashboardSummary> {
    return request('/api/dashboard');
  },

  // ---- persons / teams ----
  persons(): Promise<Person[]> {
    return request('/api/persons');
  },
  teams(): Promise<Team[]> {
    return request('/api/teams');
  },
  team(id: string): Promise<TeamDetail> {
    return request(`/api/teams/${id}`);
  },
  createTeam(input: { name: string; slug?: string; description?: string; leadPersonId?: string }): Promise<Team> {
    return request('/api/teams', { method: 'POST', body: JSON.stringify(input) });
  },
  updateTeam(id: string, input: { name?: string; description?: string; leadPersonId?: string }): Promise<Team> {
    return request(`/api/teams/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  addTeamMember(id: string, personId: string, role: TeamRole): Promise<TeamMember> {
    return request(`/api/teams/${id}/members`, { method: 'POST', body: JSON.stringify({ personId, role }) });
  },
  removeTeamMember(id: string, personId: string): Promise<{ ok: boolean }> {
    return request(`/api/teams/${id}/members/${personId}`, { method: 'DELETE' });
  },

  // ---- projects ----
  projects(): Promise<ProjectSummary[]> {
    return request('/api/projects');
  },
  project(id: string): Promise<ProjectDetail> {
    return request(`/api/projects/${id}`);
  },
  createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    return request('/api/projects', { method: 'POST', body: JSON.stringify(input) });
  },
  updateProject(
    id: string,
    input: Partial<CreateProjectInput> & { status?: string; mnemosApiKey?: string },
  ): Promise<ProjectSummary> {
    return request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  addProjectMember(projectId: string, personId: string, role: ProjectRole): Promise<ProjectMember> {
    return request(`/api/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify({ personId, role }),
    });
  },
  removeProjectMember(projectId: string, personId: string): Promise<{ ok: boolean }> {
    return request(`/api/projects/${projectId}/members/${personId}`, { method: 'DELETE' });
  },

  // ---- instances ----
  instances(): Promise<DshInstance[]> {
    return request('/api/instances');
  },
  createInstance(input: DshInstanceInput): Promise<InstanceCreateResult> {
    return request('/api/instances', { method: 'POST', body: JSON.stringify(input) });
  },
  updateInstance(
    id: string,
    input: Partial<DshInstanceInput> & { status?: string },
  ): Promise<DshInstance> {
    return request(`/api/instances/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  rotateInstanceToken(id: string): Promise<InstanceTokenResult> {
    return request(`/api/instances/${id}/token`, { method: 'POST' });
  },
  testInstance(id: string): Promise<InstanceTestResult> {
    return request(`/api/instances/${id}/test`, { method: 'POST' });
  },
  revokeInstance(id: string): Promise<{ ok: boolean }> {
    return request(`/api/instances/${id}`, { method: 'DELETE' });
  },

  // ---- prompt cards ----
  promptCards(params: { projectId?: string; category?: string } = {}): Promise<PromptCard[]> {
    return request(`/api/prompt-cards${qs({ projectId: params.projectId, category: params.category })}`);
  },
  projectPromptCards(projectId: string): Promise<PromptCard[]> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/prompt-cards`);
  },
  createPromptCard(input: PromptCardInput): Promise<PromptCard> {
    return request('/api/prompt-cards', { method: 'POST', body: JSON.stringify(input) });
  },
  updatePromptCard(id: string, input: Partial<PromptCardInput>): Promise<PromptCard> {
    return request(`/api/prompt-cards/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  deletePromptCard(id: string): Promise<{ ok: boolean }> {
    return request(`/api/prompt-cards/${id}`, { method: 'DELETE' });
  },

  // ---- settings ----
  settings(): Promise<SystemSettings> {
    return request('/api/settings');
  },
  updateSecuritySettings(
    input: Partial<SecuritySettings> & { apiKey?: string },
  ): Promise<{ security: SecuritySettings }> {
    return request('/api/settings/security', { method: 'PATCH', body: JSON.stringify(input) });
  },
  updateAssistantSettings(
    input: Omit<Partial<AssistantSettings>, 'instanceId'> & { instanceId?: string | null },
  ): Promise<{ assistant: AssistantSettings }> {
    return request('/api/settings/assistant', { method: 'PATCH', body: JSON.stringify(input) });
  },
  testSecurity(): Promise<SecurityTestResult> {
    return request('/api/settings/security/test', { method: 'POST' });
  },

  // ---- tasks ----
  tasks(params: { projectId?: string; status?: string; type?: string; mine?: boolean; limit?: number } = {}): Promise<WorkItem[]> {
    return request(
      `/api/tasks${qs({
        projectId: params.projectId,
        status: params.status,
        type: params.type,
        mine: params.mine ? '1' : undefined,
        limit: params.limit,
      })}`,
    );
  },
  createTask(projectId: string, input: CreateTaskInput): Promise<WorkItem> {
    return request(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(input) });
  },
  task(id: string): Promise<TaskDetail> {
    return request(`/api/tasks/${id}`);
  },
  cancelTask(id: string): Promise<WorkItem> {
    return request(`/api/tasks/${id}/cancel`, { method: 'POST' });
  },

  // ---- assistant ----
  assistantChat(input: {
    message: string;
    pathname: string;
    projectId?: string;
    taskId?: string;
  }): Promise<{
    reply: string;
    navigate?: string;
    sessionId?: string;
    instance?: string;
  }> {
    return request('/api/assistant/chat', { method: 'POST', body: JSON.stringify(input) });
  },

  // ---- automations ----
  automations(projectId: string): Promise<Automation[]> {
    return request(`/api/projects/${projectId}/automations`);
  },
  createAutomation(projectId: string, input: CreateAutomationInput): Promise<Automation> {
    return request(`/api/projects/${projectId}/automations`, { method: 'POST', body: JSON.stringify(input) });
  },
  updateAutomation(id: string, input: Partial<CreateAutomationInput>): Promise<Automation> {
    return request(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  deleteAutomation(id: string): Promise<{ ok: boolean }> {
    return request(`/api/automations/${id}`, { method: 'DELETE' });
  },
  runAutomation(id: string): Promise<{ task: WorkItem }> {
    return request(`/api/automations/${id}/run`, { method: 'POST' });
  },
  automationRuns(id: string): Promise<AutomationRun[]> {
    return request(`/api/automations/${id}/runs`);
  },
  deliveries(projectId: string): Promise<InboundDelivery[]> {
    return request(`/api/projects/${projectId}/deliveries`);
  },

  // ---- runtime events ----
  runtimeEvents(taskId: string, after = 0): Promise<RuntimeEvent[]> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/runtime-events?after=${after}`);
  },

  // ---- activity / memory ----
  activity(projectId?: string, limit = 30): Promise<ActivityEvent[]> {
    return request(`/api/activity${qs({ projectId, limit })}`);
  },
  memorySearch(projectId: string, q: string, agentId?: string, topK = 8): Promise<MemorySearchResult> {
    return request(`/api/projects/${projectId}/memory/search${qs({ q, agentId, topK })}`);
  },
  memoryContext(projectId: string, agentId?: string, q?: string): Promise<MemoryContextResult> {
    return request(`/api/projects/${projectId}/memory/context${qs({ agentId, q })}`);
  },

  // ---- SSE ----
  subscribeEvents(onEvent: (event: LiveEvent) => void, projectId?: string): () => void {
    const token = getToken();
    if (!token) return () => {};
    const source = new EventSource(`/api/events${qs({ token, projectId })}`);
    const handler = (event: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(event.data) as LiveEvent);
      } catch {
        /* ignore malformed */
      }
    };
    source.addEventListener('activity', handler as EventListener);
    return () => source.close();
  },
};

export type { Person, ProjectSummary, WorkItem, Visibility, Paginated };
