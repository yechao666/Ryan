/**
 * Hive 全局助手 · 本地意图解析（MVP，不依赖后端 LLM）。
 *
 * 纯函数：把中文/英文自然语言映射成「可预览、可确认」的操作。
 * - 定时自动化：每天 / 每周一 / 工作日 / 每小时 / 英文 daily、every Monday…
 * - 创建任务：创建任务 / 让 X 做 Y / 修复 bug / fix bug…
 * - 页面操作：打开任务、记忆、设置、自动化、智员、实例；筛选 BUGFIX / 需求 / 运维…
 * - 其它：返回 unknown，由面板给出能力说明与建议，不伪造执行结果。
 */

export type TaskKind = 'feature' | 'bugfix' | 'management' | 'ops' | 'docs' | 'other';

export interface CronParse {
  /** 5 段 cron：分 时 日 月 周 */
  schedule: string;
  /** 中文频次描述，例如「每天 10:00」 */
  human: string;
  /** 粗粒度频次，例如「每天」「每周」「工作日」 */
  frequency: string;
}

export interface AutomationIntent {
  kind: 'automation';
  topic: string;
  schedule: CronParse | null;
  email: string | null;
  /** 用户提到的智员名称（可选），执行前可在面板改选 */
  agentName?: string;
  raw: string;
  missing: Array<'schedule' | 'email'>;
}

export interface TaskIntent {
  kind: 'task';
  title: string;
  prompt: string;
  type: TaskKind;
  agentName?: string;
  raw: string;
}

export type NavPage =
  | 'overview'
  | 'projects'
  | 'project'
  | 'tasks'
  | 'agents'
  | 'activity'
  | 'automations'
  | 'memory'
  | 'settings'
  | 'instances'
  | 'teams';

export interface NavigateIntent {
  kind: 'navigate';
  page: NavPage;
  /** 任务页筛选类型，多个时使用逗号拼进 ?type=bugfix,feature */
  filterTypes: TaskKind[];
  raw: string;
}

export type ParsedIntent =
  | AutomationIntent
  | TaskIntent
  | NavigateIntent
  | { kind: 'unknown'; raw: string; reason?: string };

/* ================================================================== */
/* 名称与匹配                                                          */
/* ================================================================== */

const CN_DOW: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 0,
};

const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];

const EN_DOW: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  feature: '需求',
  bugfix: 'BUGFIX',
  management: '管理',
  ops: '运维',
  docs: '文档',
  other: '其他',
};

const TASK_KIND_TONES: Record<TaskKind, string> = {
  feature: 'violet',
  bugfix: 'red',
  management: 'amber',
  ops: 'cyan',
  docs: 'blue',
  other: 'slate',
};

export function taskKindLabel(type: TaskKind): string {
  return TASK_KIND_LABELS[type] ?? type;
}

export function taskKindTone(type: TaskKind): string {
  return TASK_KIND_TONES[type] ?? 'slate';
}

/* ================================================================== */
/* cron 解析                                                           */
/* ================================================================== */

interface TimeParts {
  hour: number;
  minute: number;
}

function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime(time: TimeParts): string {
  return `${pad(time.hour)}:${pad(time.minute)}`;
}

function makeTime(hourText: string | undefined, minuteText?: string, cnMeridiem?: string, enMeridiem?: string): TimeParts | null {
  if (!hourText) return null;
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const cn = cnMeridiem ?? '';
  const en = (enMeridiem ?? '').toLowerCase();
  if (/下午|晚上|傍晚/.test(cn) && hour < 12) hour += 12;
  if (/中午/.test(cn) && hour < 12) hour += 12;
  if (/凌晨/.test(cn) && hour === 12) hour = 0;
  if (en === 'pm' && hour < 12) hour += 12;
  if (en === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function buildCron(time: TimeParts, dow: string): CronParse {
  const timeText = formatTime(time);
  if (dow === '1-5') {
    return {
      schedule: `${time.minute} ${time.hour} * * 1-5`,
      human: `工作日 ${timeText}`,
      frequency: '工作日',
    };
  }
  if (dow.includes('-')) {
    const [start, end] = dow.split('-');
    return {
      schedule: `${time.minute} ${time.hour} * * ${dow}`,
      human: `每周${DOW_CN[Number(start)] ?? start}至周${DOW_CN[Number(end)] ?? end} ${timeText}`,
      frequency: '每周',
    };
  }
  if (dow === '*') {
    return {
      schedule: `${time.minute} ${time.hour} * * *`,
      human: `每天 ${timeText}`,
      frequency: '每天',
    };
  }
  const day = Number(dow);
  return {
    schedule: `${time.minute} ${time.hour} * * ${day}`,
    human: `每周${DOW_CN[day] ?? dow} ${timeText}`,
    frequency: '每周',
  };
}

/** 解析自然语言频次为 5 段 cron；无法识别返回 null。 */
export function parseCron(raw: string): CronParse | null {
  const text = normalize(raw);
  const lower = text.toLowerCase();

  if (/(?:每(?:个)?小时|每小时|hourly|every\s+hour)/i.test(text)) {
    return { schedule: '0 * * * *', human: '每小时', frequency: '每小时' };
  }

  // 用户直接给出 5 段 cron
  const direct = text.match(/(?:^|\s)(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s|$)/);
  if (direct && /^[\d*/,-]+$/.test(direct[1] ?? '')) {
    return {
      schedule: `${direct[1]} ${direct[2]} ${direct[3]} ${direct[4]} ${direct[5]}`,
      human: '自定义 cron',
      frequency: '自定义',
    };
  }

  // 每周一至周五 9点
  const range = text.match(
    /每(?:周|星期)\s*([一二三四五六日天1-7])\s*(?:到|至|-|—|~)\s*(?:周|星期)?\s*([一二三四五六日天1-7])\s*(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*(?:[:：点时]\s*(\d{1,2}))?/,
  );
  if (range) {
    const start = CN_DOW[range[1] ?? ''];
    const end = CN_DOW[range[2] ?? ''];
    const time = makeTime(range[4], range[5], range[3]);
    if (start !== undefined && end !== undefined && time) return buildCron(time, `${start}-${end}`);
  }

  // 每周一 9点
  const weekly = text.match(
    /每(?:周|星期)\s*([一二三四五六日天1-7])\s*(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*(?:[:：点时]\s*(\d{1,2}))?/,
  );
  if (weekly) {
    const dow = CN_DOW[weekly[1] ?? ''];
    const time = makeTime(weekly[3], weekly[4], weekly[2]);
    if (dow !== undefined && time) return buildCron(time, String(dow));
  }

  // 工作日 9点 / 周一到周五 9点
  const weekdays = text.match(
    /(?:工作日|每个工作日|周一到周五|周一至周五|星期一到星期五|星期一到周五)\s*(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*(?:[:：点时]\s*(\d{1,2}))?/,
  );
  if (weekdays) {
    const time = makeTime(weekdays[2], weekdays[3], weekdays[1]);
    if (time) return buildCron(time, '1-5');
  }

  // 每天 10点 / 每天 10:00 / 每晚 8点
  const daily = text.match(
    /(?:每天|每日|每晚|每早)\s*(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*(?:[:：点时]\s*(\d{1,2}))?/,
  );
  if (daily) {
    let meridiem = daily[1];
    if (!meridiem && /每晚/.test(text)) meridiem = '晚上';
    if (!meridiem && /每早/.test(text)) meridiem = '早上';
    const time = makeTime(daily[2], daily[3], meridiem);
    if (time) return buildCron(time, '*');
  }

  // English: every Monday at 9am
  const enWeekly = lower.match(
    /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thu|thur|fri|sat|sun)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (enWeekly) {
    const dow = EN_DOW[enWeekly[1] ?? ''];
    const time = makeTime(enWeekly[2], enWeekly[3], undefined, enWeekly[4]);
    if (dow !== undefined && time) return buildCron(time, String(dow));
  }

  // English: weekdays at 9
  const enWeekdays = lower.match(
    /(?:every\s+)?weekdays?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (enWeekdays) {
    const time = makeTime(enWeekdays[1], enWeekdays[2], undefined, enWeekdays[3]);
    if (time) return buildCron(time, '1-5');
  }

  // English: daily at 9:30pm
  const enDaily = lower.match(
    /(?:every\s*day|daily)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (enDaily) {
    const time = makeTime(enDaily[1], enDaily[2], undefined, enDaily[3]);
    if (time) return buildCron(time, '*');
  }

  return null;
}

/* ================================================================== */
/* 文本抽取                                                            */
/* ================================================================== */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function extractEmail(text: string): string | null {
  const match = text.match(EMAIL_RE);
  return match ? match[0] : null;
}

const POLITE_PREFIXES = /^(请|麻烦|帮我|帮忙|给我|请帮我|帮我给)\s*/;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function trimPunctuation(text: string): string {
  return text.replace(/^[：:，,。.!！\s]+/, '').replace(/[。.!！\s]+$/, '').trim();
}

const AGENT_ACTION_VERBS =
  '做|完成|处理|修复|修|写|开发|实现|检查|排查|优化|测试|整理|生成|分析|跟进|补|改|巡检|部署|监控';

/** 从「让 X 做 Y / 给 X 创建任务」里抽取智员名称。 */
export function extractAgentName(text: string): string | undefined {
  const patterns: RegExp[] = [
    new RegExp(`让\\s*(.{1,40}?)(?:去|来|帮我|帮忙)?\\s*(?:${AGENT_ACTION_VERBS})`, 's'),
    /(?:给|为)\s*([^\s，,。；;:：]{1,24})\s*(?:创建|新建|安排|派发|建)\s*(?:一个|个)?\s*任务/,
    /由\s*([^\s，,。；;:：]{1,24})\s*(?:来|负责)/,
    /assign(?:\s+to)?\s+([A-Za-z][\w.-]{1,30})/i,
    /have\s+([A-Za-z][\w.-]{1,30})\s+(?:do|fix|implement|write)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]?.trim();
    if (name && !['我', '我们', '你', '他', '她', '团队', '助手'].includes(name)) return name;
  }
  return undefined;
}

/** 从任务描述里抽一个自然语言标题。 */
export function extractTaskTitle(raw: string): string {
  let rest = normalize(raw).replace(POLITE_PREFIXES, '');
  rest = rest
    .replace(/^(创建|新建|建个|添加|安排|派发|开个)\s*(?:一个|个)?\s*任务\s*[:：,，]?\s*/, '')
    .replace(/^(创建|新建|添加|安排)\s*任务\s*[:：,，]?\s*/, '')
    .replace(/^(?:please\s+)?(?:create|new|add)\s+(?:a\s+)?task\s*[:,-]?\s*/i, '');

  const letMatch = rest.match(
    new RegExp(`^让\\s*(.{1,40}?)\\s*(?:去|来|帮我|帮忙)?\\s*(${AGENT_ACTION_VERBS})(.*)$`, 's'),
  );
  if (letMatch) {
    const verb = letMatch[2] ?? '';
    const tail = trimPunctuation(letMatch[3] ?? '');
    const base = ['做', '完成', '处理', '跟进'].includes(verb) ? tail : `${verb}${tail}`;
    return base ? truncate(base, 160) : '';
  }

  const forMatch = rest.match(
    /^(?:给|为)\s*([^\s，,。；;:：]{1,24})\s*(?:创建|新建|安排|派发|建)?\s*(?:一个|个)?\s*任务\s*[:：,，]?\s*(.*)$/s,
  );
  if (forMatch) {
    const title = trimPunctuation(forMatch[2] ?? '');
    if (title) return truncate(title, 160);
  }

  const cleaned = trimPunctuation(rest);
  if (!cleaned || cleaned === '任务') return '';
  return truncate(cleaned, 160);
}

function detectTaskKind(text: string): TaskKind {
  if (/(bugfix|bug|缺陷|故障|报错|崩溃|错误|修复|fix)/i.test(text)) return 'bugfix';
  if (/(运维|ops|巡检|部署|发布|监控|备份)/i.test(text)) return 'ops';
  if (/(管理|management|排期|复盘)/i.test(text)) return 'management';
  if (/(需求|feature|功能|开发|实现|新增|添加)/i.test(text)) return 'feature';
  if (/(文档|docs?|说明|readme)/i.test(text)) return 'docs';
  return 'feature';
}

function detectFilterTypes(text: string): TaskKind[] {
  const types: TaskKind[] = [];
  if (/(bugfix|bug|缺陷|故障|报错|fix)/i.test(text)) types.push('bugfix');
  if (/(需求|feature|功能)/i.test(text)) types.push('feature');
  if (/(运维|ops|巡检|部署|发布)/i.test(text)) types.push('ops');
  if (/(管理|management|排期)/i.test(text)) types.push('management');
  if (/(文档|docs?|说明)/i.test(text)) types.push('docs');
  if (/(其他|other)/i.test(text)) types.push('other');
  return Array.from(new Set(types));
}

function detectTopic(text: string): string {
  if (/开发简报/.test(text)) return '开发简报';
  if (/项目简报/.test(text)) return '项目简报';
  if (/周报/.test(text)) return '周报';
  if (/日报/.test(text)) return '日报';
  if (/(简报|报告|brief|report)/i.test(text)) return '项目简报';
  return '定时任务';
}

/* ================================================================== */
/* 页面识别                                                            */
/* ================================================================== */

const PAGE_PATTERNS: { page: NavPage; re: RegExp }[] = [
  { page: 'memory', re: /(记忆|memory|知识库)/i },
  { page: 'settings', re: /(设置|settings?|配置|config)/i },
  { page: 'automations', re: /(自动化|automation|cron)/i },
  { page: 'activity', re: /(活动|动态|activity|事件)/i },
  { page: 'instances', re: /(实例|instance|服务器|runtime)/i },
  { page: 'agents', re: /(智员|agent|数字员工|机器人|bot)/i },
  { page: 'tasks', re: /(任务|task|待办)/i },
  { page: 'teams', re: /(团队|team)/i },
  { page: 'projects', re: /(项目列表|所有项目|projects\b|project list)/i },
  { page: 'project', re: /(项目工作区|当前项目|这个项目)/i },
  { page: 'overview', re: /(概览|首页|仪表盘|dashboard|overview|主页|home)/i },
  { page: 'projects', re: /(项目|projects?)/i },
];

const BARE_PAGES: Record<string, NavPage> = {
  任务: 'tasks',
  tasks: 'tasks',
  task: 'tasks',
  记忆: 'memory',
  memory: 'memory',
  设置: 'settings',
  settings: 'settings',
  自动化: 'automations',
  automation: 'automations',
  automations: 'automations',
  智员: 'agents',
  agent: 'agents',
  agents: 'agents',
  实例: 'instances',
  instance: 'instances',
  instances: 'instances',
  项目: 'projects',
  projects: 'projects',
  团队: 'teams',
  teams: 'teams',
  概览: 'overview',
  首页: 'overview',
  dashboard: 'overview',
  overview: 'overview',
  活动: 'activity',
  activity: 'activity',
};

const PROJECT_REQUIRED_PAGES: NavPage[] = ['automations', 'memory', 'settings', 'activity'];

export function pageRequiresProject(page: NavPage): boolean {
  return PROJECT_REQUIRED_PAGES.includes(page);
}

function detectPage(text: string): NavPage | null {
  for (const item of PAGE_PATTERNS) {
    if (item.re.test(text)) return item.page;
  }
  return null;
}

function isBarePage(text: string): boolean {
  const compact = text.toLowerCase().replace(/[？?。.!！\s]/g, '');
  return Boolean(BARE_PAGES[compact]);
}

function detectNavigation(text: string): NavigateIntent | null {
  const filterTypes = detectFilterTypes(text);
  const hasFilterWord = /(筛选|过滤|只看|filter|show\s+only)/i.test(text);
  const hasTaskWord = /(任务|task|列表|list)/i.test(text);
  const hasNavVerb = /(打开|进入|跳到|跳转|切换到|回到|返回|导航到|去|看看|查看|看一下|open|go\s+to|show\s+me|navigate\s+to)/i.test(text);
  const hasCreateVerb =
    /(创建|新建|添加|安排|生成|写|做|发|修复|实现|开发|create|make|write|generate|send|\bfix\b)/i.test(text);

  if (hasFilterWord) {
    return { kind: 'navigate', page: 'tasks', filterTypes, raw: text };
  }
  if (filterTypes.length > 0 && hasTaskWord && !hasCreateVerb) {
    return { kind: 'navigate', page: 'tasks', filterTypes, raw: text };
  }

  const page = detectPage(text);
  const bare = isBarePage(text);
  if (!page) return null;
  if (!hasNavVerb && !bare) return null;
  if (hasNavVerb && hasCreateVerb) return null;
  return { kind: 'navigate', page, filterTypes: [], raw: text };
}

/* ================================================================== */
/* 自动化 / 任务                                                       */
/* ================================================================== */

function detectAutomation(text: string, raw: string): AutomationIntent | null {
  const schedule = parseCron(text);
  const hasAutomationWord = /(自动化|定时任务|定时提醒|定时|cron|schedule|automation)/i.test(text);
  const hasBrief = /(简报|日报|周报|报告|brief|report)/i.test(text);
  const hasSend = /(发送|发到|发给|邮件|email|send|mail)/i.test(text);
  const explicitTask =
    /(创建\s*(?:一个|个)?\s*任务|新建\s*(?:一个|个)?\s*任务|建个任务|添加任务|安排任务|派发任务|让\s*[^\s，,。；;:：]{1,24})/i.test(
      text,
    );

  if (!schedule && !hasAutomationWord && !hasBrief && !hasSend) return null;
  // 明确说“创建任务”，又没有自动化/简报/发送线索时，交给任务意图处理（即使提到时间）。
  if (explicitTask && !hasAutomationWord && !hasBrief && !hasSend) return null;

  const email = extractEmail(text);
  const missing: Array<'schedule' | 'email'> = [];
  if (!schedule) missing.push('schedule');
  if ((hasBrief || hasSend) && !email) missing.push('email');

  return {
    kind: 'automation',
    topic: detectTopic(text),
    schedule,
    email,
    agentName: extractAgentName(text),
    raw,
    missing,
  };
}

function detectTask(text: string, raw: string): TaskIntent | null {
  const taskSignal = new RegExp(
    `(创建\\s*(?:一个|个)?\\s*任务|新建\\s*(?:一个|个)?\\s*任务|建个任务|添加任务|安排任务|派发任务|让\\s*.{1,40}?\\s*(?:去|来|帮我)?\\s*(?:${AGENT_ACTION_VERBS})|修复|bug|缺陷|故障|报错|需求|开发|实现|新增|添加功能|巡检|部署|create\\s+(?:a\\s+)?task|new\\s+(?:a\\s+)?task|assign|fix\\s+|implement|add\\s+feature)`,
    'i',
  );
  if (!taskSignal.test(text)) return null;
  return {
    kind: 'task',
    title: extractTaskTitle(text),
    prompt: raw,
    type: detectTaskKind(text),
    agentName: extractAgentName(text),
    raw,
  };
}

/* ================================================================== */
/* 入口                                                                */
/* ================================================================== */

export function parseIntent(raw: string): ParsedIntent {
  const text = normalize(raw);
  if (!text) return { kind: 'unknown', raw };

  const nav = detectNavigation(text);
  if (nav) return nav;

  const automation = detectAutomation(text, raw.trim());
  if (automation) return automation;

  const task = detectTask(text, raw.trim());
  if (task) return task;

  return { kind: 'unknown', raw: raw.trim() };
}

/* ================================================================== */
/* 自动化 prompt / 名称                                                */
/* ================================================================== */

/** 组装 cron 自动化的提示词，完整包含频次、简报内容与收件邮箱。 */
export function buildAutomationPrompt(intent: AutomationIntent, projectName: string): string {
  const schedule = intent.schedule;
  if (!schedule) return intent.raw;

  const isBrief = /(简报|日报|周报|报告|brief|report)/i.test(intent.raw) || intent.topic !== '定时任务';
  const parts: string[] = [];
  if (isBrief) {
    parts.push(`生成项目开发简报${intent.email ? `，并发送到 ${intent.email}` : ''}。`);
    parts.push('简报内容：汇总项目最近 7 天的任务进展、已完成工作、风险与下一步计划；如需补充上下文，请读取项目记忆。');
  } else {
    parts.push(`按以下要求执行定时任务：${intent.raw}`);
  }
  parts.push(`项目：${projectName}`);
  parts.push(`频次：${schedule.human}（cron: ${schedule.schedule}）`);
  if (intent.email) parts.push(`收件邮箱：${intent.email}`);
  return parts.join('\n');
}

export function buildAutomationName(intent: AutomationIntent): string {
  const frequency = intent.schedule?.human ?? '定时';
  return `${intent.topic} · ${frequency}`.slice(0, 200);
}
