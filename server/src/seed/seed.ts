/**
 * Hive 演示数据：人员 / 团队 / 项目 / 智员 / 实例 / 任务 / 自动化。
 * 记忆系统中的项目由 Mnemos 演示 Key 关联，真实可读写（只读 tab 与完成写回）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { DEMO_PASSWORD } from '../../../shared/src/constants.ts';
import { hashPassword } from '../lib/password.ts';
import { newId, nowIso, sha256 } from '../lib/ids.ts';

const NOW = Date.now();
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const daysAgo = (days: number, extraMinutes = 0): string => iso(days * 1440 + extraMinutes);

/** 演示运行时令牌（仅演示环境；生产必须重新签发）。 */
export const DEMO_TOKENS = {
  agentOrionCoder: 'hive_agt_demo_orion_coder_7f3a2c',
  agentAtlasReview: 'hive_agt_demo_atlas_review_9b1d4e',
  agentAuroraSupport: 'hive_agt_demo_aurora_support_2c8f6a',
  instanceOrion: 'hive_inst_demo_orion_01_5d9e3b',
  instanceAtlas: 'hive_inst_demo_atlas_01_8a4c7f',
  instanceLab: 'hive_inst_demo_lab_01_3e7b2d',
} as const;

const PEOPLE = [
  { id: 'per_linwei', email: 'lin.wei@hive.dev', name: '林薇', title: '平台负责人', color: 'violet', admin: 1 },
  { id: 'per_chenhao', email: 'chen.hao@hive.dev', name: '陈昊', title: '研发一组负责人', color: 'cyan', admin: 0 },
  { id: 'per_zhouye', email: 'zhou.ye@hive.dev', name: '周野', title: '算法工程师', color: 'green', admin: 0 },
  { id: 'per_suyan', email: 'su.yan@hive.dev', name: '苏妍', title: '数据合规', color: 'amber', admin: 0 },
] as const;

const TEAMS = [
  { id: 'tm_platform', name: '平台组', slug: 'platform', desc: '负责 Hive 平台、DSH 运行时与基础设施。', lead: 'per_linwei' },
  { id: 'tm_rnd', name: '研发一组', slug: 'rnd-one', desc: '订单、检索与 Agent 工程。', lead: 'per_chenhao' },
  { id: 'tm_data', name: '数据组', slug: 'data', desc: '知识中台、数据合规与评测。', lead: 'per_zhouye' },
] as const;

const MEMBERS = [
  ['tm_platform', 'per_linwei', 'lead'],
  ['tm_platform', 'per_chenhao', 'member'],
  ['tm_platform', 'per_suyan', 'member'],
  ['tm_rnd', 'per_chenhao', 'lead'],
  ['tm_rnd', 'per_linwei', 'member'],
  ['tm_rnd', 'per_zhouye', 'member'],
  ['tm_data', 'per_zhouye', 'lead'],
  ['tm_data', 'per_suyan', 'member'],
] as const;

const PROJECTS = [
  {
    id: 'prj_aurora',
    slug: 'aurora-support',
    name: 'Aurora 智能客服',
    desc: '面向华北制药等客户的客服智员，处理工单、退款与知识检索。',
    prompt:
      `Aurora 是企业客服数字员工项目：面向华北制药等客户处理工单、退款与知识检索。
工作原则：先核对退款政策与支付网关日志；涉及补发/退款必须人工确认；所有结论写入项目记忆，保留工单号与客户信息脱敏。`,
    team: 'tm_platform',
    owner: 'per_linwei',
    visibility: 'team',
    type: 'manual',
    repo: null,
    mnemos: 'prj_aurora_support',
    key: 'mnemos_live_demo_aurora_console',
    created: daysAgo(120),
  },
  {
    id: 'prj_atlas',
    slug: 'atlas-copilot',
    name: 'Atlas 研发助手',
    desc: '代码评审、影响面分析与 CI 失败归因。',
    prompt:
      `Atlas 是研发助手项目：负责代码评审、影响面分析与 CI 失败归因。
评审原则：优先检查缓存失效、并发回源、安全边界与回滚方案；每个 PR 至少给出风险清单和测试建议。`,
    team: 'tm_rnd',
    owner: 'per_chenhao',
    visibility: 'team',
    type: 'github',
    repo: 'https://github.com/acme/atlas-copilot',
    mnemos: 'prj_atlas_copilot',
    key: 'mnemos_live_demo_atlas_ci',
    created: daysAgo(96),
  },
  {
    id: 'prj_orion',
    slug: 'orion-python',
    name: 'Orion 订单服务',
    desc: 'Python / FastAPI 订单核心服务，关注幂等、一致性与性能。',
    prompt:
      `Orion 是 Python / FastAPI 订单核心服务，强调幂等、一致性与性能。
开发规范：幂等键必须绑定业务单号；查询可走只读副本，写后读主库兜底；迁移必须先 staging 验证并给出回滚方案；测试覆盖重复提交与唯一约束冲突。`,
    team: 'tm_rnd',
    owner: 'per_chenhao',
    visibility: 'public',
    type: 'gitlab',
    repo: 'https://gitlab.acme.com/order/orion',
    mnemos: 'prj_orion_python',
    key: 'mnemos_live_demo_orion_python',
    created: daysAgo(150),
  },
  {
    id: 'prj_helios',
    slug: 'helios-knowledge',
    name: 'Helios 知识中台',
    desc: '企业知识抽取、检索与评测；当前仅负责人可见。',
    prompt:
      `Helios 是企业知识中台：知识抽取、检索与评测。当前仅项目负责人可见。
工作原则：不把客户原文直接写入共享记忆；评测结论必须带指标与样本说明。`,
    team: 'tm_data',
    owner: 'per_zhouye',
    visibility: 'private',
    type: 'manual',
    repo: null,
    mnemos: null,
    key: null,
    created: daysAgo(64),
  },
  {
    id: 'prj_lab',
    slug: 'hive-lab',
    name: 'Hive 内部实验',
    desc: '数字员工协议、任务队列与实例管理的实验项目。',
    prompt:
      `Hive 内部实验项目：验证数字员工协议、任务队列、DSH 实例与本地 Git 协作流程。
规范：任务在工作区内完成；涉及 git 时使用 feature/* 分支，由审查智员合并到 main；合并前必须跑测试；不修改项目外文件。`,
    team: null,
    owner: 'per_linwei',
    visibility: 'private',
    type: 'manual',
    repo: null,
    mnemos: null,
    key: null,
    created: daysAgo(30),
  },
] as const;

const AGENTS = [
  {
    id: 'agt_orion_coder',
    owner: 'per_chenhao',
    name: 'Orion 开发智员',
    role: 'developer',
    model: 'deepseek-coder',
    desc: 'FastAPI / SQLAlchemy 实现、缺陷修复与测试补齐。',
    caps: ['python', 'fastapi', 'sqlalchemy', 'tests'],
    created: daysAgo(150),
  },
  {
    id: 'agt_orion_oncall',
    owner: 'per_zhouye',
    name: 'Orion 值班智员',
    role: 'on-call',
    model: 'deepseek-chat',
    desc: '告警归因、日志排查与值班交接。',
    caps: ['observability', 'logs', 'incident'],
    created: daysAgo(140),
  },
  {
    id: 'agt_atlas_review',
    owner: 'per_zhouye',
    name: 'Atlas 评审智员',
    role: 'reviewer',
    model: 'deepseek-chat',
    desc: '代码评审、影响面分析与变更风险提示。',
    caps: ['review', 'typescript', 'security'],
    created: daysAgo(96),
  },
  {
    id: 'agt_aurora_support',
    owner: 'per_suyan',
    name: 'Aurora 客服智员',
    role: 'support',
    model: 'deepseek-chat',
    desc: '工单处理、退款政策与客户沟通。',
    caps: ['support', 'refund', 'crm'],
    created: daysAgo(120),
  },
  {
    id: 'agt_platform_ops',
    owner: 'per_linwei',
    name: '平台运维智员',
    role: 'ops',
    model: 'deepseek-chat',
    desc: '备份检查、容量巡检与发布守卫。',
    caps: ['ops', 'backup', 'release'],
    created: daysAgo(45),
  },
] as const;

const BINDINGS = [
  ['pba_orion_coder', 'prj_orion', 'agt_orion_coder', 'prj_orion_python__agent-coder', 'developer', 'active', 'per_chenhao'],
  ['pba_orion_oncall', 'prj_orion', 'agt_orion_oncall', 'prj_orion_python__agent-oncall', 'developer', 'active', 'per_zhouye'],
  ['pba_atlas_review', 'prj_atlas', 'agt_atlas_review', 'prj_atlas_copilot__agent-code-review', 'maintainer', 'active', 'per_zhouye'],
  ['pba_aurora_support', 'prj_aurora', 'agt_aurora_support', 'prj_aurora_support__agent-support-t2', 'developer', 'active', 'per_suyan'],
  ['pba_lab_ops', 'prj_lab', 'agt_platform_ops', 'prj_lab__platform-ops', 'maintainer', 'active', 'per_linwei'],
] as const;

export function seedIfEmpty(db: DatabaseSync, _env: { mnemosBaseUrl: string }): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM persons').get() as unknown as { c: number }).c;
  if (count > 0) return;
  seedDatabase(db);
}

export function seedDatabase(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    const password = hashPassword(DEMO_PASSWORD);
    const createdAt = daysAgo(180);

    const personStmt = db.prepare(
      `INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of PEOPLE) personStmt.run(p.id, p.email, p.name, p.title, p.color, p.admin, password, createdAt, iso(5));

    const teamStmt = db.prepare('INSERT INTO teams (id, name, slug, description, lead_person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const t of TEAMS) teamStmt.run(t.id, t.name, t.slug, t.desc, t.lead, daysAgo(170));

    const memberStmt = db.prepare('INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, ?, ?)');
    for (const [team, person, role] of MEMBERS) memberStmt.run(team, person, role, daysAgo(160));

    const projectStmt = db.prepare(
      `INSERT INTO projects
         (id, slug, name, description, owner_team_id, owner_person_id, visibility, type, prompt, repo_url, status,
          mnemos_project_id, mnemos_api_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    );
    for (const p of PROJECTS) {
      projectStmt.run(p.id, p.slug, p.name, p.desc, p.team, p.owner, p.visibility, p.type, p.prompt, p.repo, p.mnemos, p.key, p.created, iso(30));
    }

    const pmStmt = db.prepare('INSERT INTO project_members (project_id, person_id, role, added_at) VALUES (?, ?, ?, ?)');
    pmStmt.run('prj_aurora', 'per_suyan', 'developer', daysAgo(110));
    pmStmt.run('prj_atlas', 'per_zhouye', 'maintainer', daysAgo(90));
    pmStmt.run('prj_orion', 'per_zhouye', 'developer', daysAgo(140));
    pmStmt.run('prj_helios', 'per_suyan', 'developer', daysAgo(60));
    pmStmt.run('prj_orion', 'per_linwei', 'reporter', daysAgo(140));

    const agentStmt = db.prepare(
      `INSERT INTO agents (id, owner_person_id, name, role, model, description, capabilities, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    );
    for (const a of AGENTS) agentStmt.run(a.id, a.owner, a.name, a.role, a.model, a.desc, JSON.stringify(a.caps), a.created, iso(60));

    const bindingStmt = db.prepare(
      `INSERT INTO project_agents (id, project_id, agent_id, memory_agent_id, role, status, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, project, agent, memory, role, status, addedBy] of BINDINGS) {
      bindingStmt.run(id, project, agent, memory, role, status, addedBy, daysAgo(80));
    }

    const tokenStmt = db.prepare(
      `INSERT INTO agent_tokens (id, agent_id, label, prefix, token_hash, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [agent, secret, label] of [
      ['agt_orion_coder', DEMO_TOKENS.agentOrionCoder, 'orion-dsh 运行时'],
      ['agt_atlas_review', DEMO_TOKENS.agentAtlasReview, 'atlas-dsh 运行时'],
      ['agt_aurora_support', DEMO_TOKENS.agentAuroraSupport, 'aurora-dsh 运行时'],
    ] as const) {
      tokenStmt.run(newId('tok'), agent, label, secret.slice(0, 14), sha256(secret), daysAgo(20), iso(10));
    }

    const instanceStmt = db.prepare(
      `INSERT INTO dsh_instances (id, agent_id, token_hash, name, host, workspace_path, version, status, registered_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    instanceStmt.run('ins_orion_01', 'agt_orion_coder', sha256(DEMO_TOKENS.instanceOrion), 'orion-dsh-01', 'dev-mac', '/workspace/orion', 'dsh 0.2.1', 'online', daysAgo(25), iso(0));
    instanceStmt.run('ins_atlas_01', 'agt_atlas_review', sha256(DEMO_TOKENS.instanceAtlas), 'atlas-dsh-01', 'ci-runner-3', '/workspace/atlas', 'dsh 0.2.1', 'offline', daysAgo(18), iso(180));
    instanceStmt.run('ins_lab_01', 'agt_platform_ops', sha256(DEMO_TOKENS.instanceLab), 'lab-dsh-01', 'mac-studio', '/workspace/hive-lab', 'dsh 0.2.1', 'online', daysAgo(10), iso(0));

    const taskStmt = db.prepare(
      `INSERT INTO work_items
         (id, project_id, agent_id, source, type, title, prompt, status, priority, lease_until, instance_id,
          created_by, created_at, started_at, finished_at, result, error, metadata, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    taskStmt.run(
      'tsk_orion_queued', 'prj_orion', 'agt_orion_coder', 'human', 'feature',
      '为订单查询接口补幂等集成测试',
      '请为 GET /orders/{id} 与 POST /orders 补充集成测试，覆盖重复提交、缓存击穿与数据库唯一约束冲突。完成后把结论写入项目记忆。',
      'queued', 2, null, null, 'per_chenhao', iso(38), null, null, null, null,
      JSON.stringify({ branch: 'feat/idempotent-query', labels: ['tests', 'idempotency'] }), null,
    );
    taskStmt.run(
      'tsk_orion_running', 'prj_orion', 'agt_orion_coder', 'human', 'ops',
      '拆分订单查询服务（读写分离）',
      '把订单查询从写库拆到只读副本，保持最终一致；先在 staging 验证延迟与一致性，输出迁移步骤与回滚方案。',
      'running', 1, new Date(NOW + 25 * 60_000).toISOString(), 'ins_orion_01', 'per_chenhao', iso(95), iso(90), null, null, null,
      JSON.stringify({ branch: 'feat/query-replica', labels: ['architecture'] }), null,
    );
    taskStmt.run(
      'tsk_aurora_waiting', 'prj_aurora', 'agt_aurora_support', 'automation', 'bugfix',
      '华北制药 3 月退款批量异常',
      '客户反馈 3 月退款批量失败，请先核对退款政策与支付网关日志，给出处理建议；涉及人工审批的步骤先停下来询问。',
      'waiting_input', 1, null, null, 'per_suyan', iso(150), iso(145), null, null, null,
      JSON.stringify({ ticket: 'CS-20918', customer: '华北制药' }), null,
    );
    taskStmt.run(
      'tsk_atlas_done', 'prj_atlas', 'agt_atlas_review', 'webhook', 'management',
      '评审 PR #482：检索服务缓存改造',
      '评审 https://github.com/acme/atlas-copilot/pull/482 的缓存改造，关注失效策略、并发回源与回滚风险。',
      'done', 0, null, 'ins_atlas_01', null, iso(420), iso(410), iso(380),
      '发现 2 个高风险点：缓存 key 未包含租户维度、回源并发未限流；建议先补租户前缀与 singleflight。已写入项目记忆。',
      null, JSON.stringify({ pr: 482, repo: 'atlas-copilot' }), null,
    );
    taskStmt.run(
      'tsk_lab_failed', 'prj_lab', 'agt_platform_ops', 'human', 'feature',
      '生成内部知识库原型',
      '用 FastAPI + SQLite 生成一个可运行的知识库原型，包含上传、分块与检索。',
      'failed', 0, null, null, 'per_linwei', iso(600), iso(590), iso(560), null,
      '实例在 npm install 阶段超时，未产出可运行版本。',
      JSON.stringify({ attempt: 2 }), null,
    );

    const msgStmt = db.prepare(
      'INSERT INTO task_messages (id, task_id, author_type, author_id, author_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    msgStmt.run(newId('msg'), 'tsk_orion_running', 'person', 'per_chenhao', '陈昊', '先只读副本，写库保持不变；注意订单状态更新的可见性。', iso(90));
    msgStmt.run(newId('msg'), 'tsk_orion_running', 'agent', 'agt_orion_coder', 'Orion 开发智员', '收到。已完成查询路径盘点：GET /orders/{id} 与 /orders/search 命中 3 处事务读，计划改为副本读 + 写后读主库兜底。', iso(62));
    msgStmt.run(newId('msg'), 'tsk_orion_running', 'agent', 'agt_orion_coder', 'Orion 开发智员', 'staging 压测：p95 从 84ms 降到 41ms；发现 1 个一致性问题，正在补写后读兜底。', iso(18));
    msgStmt.run(newId('msg'), 'tsk_aurora_waiting', 'agent', 'agt_aurora_support', 'Aurora 客服智员', '已核对：3 月 12 日批次因支付网关超时触发重试，重复退款被幂等键拦截。需要人工确认是否补发 2 笔。', iso(140));
    msgStmt.run(newId('msg'), 'tsk_aurora_waiting', 'person', 'per_suyan', '苏妍', '先不要补发，等财务确认；把政策条款和工单号记录下来。', iso(120));
    msgStmt.run(newId('msg'), 'tsk_atlas_done', 'agent', 'agt_atlas_review', 'Atlas 评审智员', '评审完成：2 个高风险、3 个建议；已生成修复清单。', iso(381));

    const eventStmt = db.prepare(
      'INSERT INTO task_events (id, task_id, project_id, instance_id, type, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    eventStmt.run(newId('evt'), 'tsk_orion_running', 'prj_orion', 'ins_orion_01', 'claimed', '实例 orion-dsh-01 接单', '{}', iso(90));
    eventStmt.run(newId('evt'), 'tsk_orion_running', 'prj_orion', 'ins_orion_01', 'progress', '盘点查询路径：3 处事务读', JSON.stringify({ progress: 30 }), iso(62));
    eventStmt.run(newId('evt'), 'tsk_orion_running', 'prj_orion', 'ins_orion_01', 'progress', 'staging 压测 p95 41ms；补写后读兜底', JSON.stringify({ progress: 75 }), iso(18));
    eventStmt.run(newId('evt'), 'tsk_atlas_done', 'prj_atlas', 'ins_atlas_01', 'completed', '评审完成，写入项目记忆', '{}', iso(380));
    eventStmt.run(newId('evt'), 'tsk_aurora_waiting', 'prj_aurora', null, 'progress', '等待人工确认补发', '{}', iso(140));
    eventStmt.run(newId('evt'), 'tsk_lab_failed', 'prj_lab', null, 'failed', 'npm install 超时', '{}', iso(560));

    const automationStmt = db.prepare(
      `INSERT INTO automations
         (id, project_id, agent_id, name, trigger_type, trigger_config, prompt_template, enabled,
          created_by, created_at, updated_at, last_run_at, last_run_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    automationStmt.run(
      'aut_orion_mr', 'prj_orion', 'agt_orion_coder', 'MR 打开 → 影响面 + 测试建议', 'webhook',
      JSON.stringify({ events: ['merge_request', 'push'], branch: 'main', secret: 'demo-gitlab-secret' }),
      '项目 {{project}} 收到 GitLab {{event}}：{{title}}\n变更：{{url}}\n请分析影响面、列出需要补的测试，并在完成后把结论写入项目记忆。',
      1, 'per_chenhao', daysAgo(60), daysAgo(60), iso(320), 'success',
    );
    automationStmt.run(
      'aut_atlas_pr', 'prj_atlas', 'agt_atlas_review', 'PR 打开 → 代码评审', 'webhook',
      JSON.stringify({ events: ['pull_request'], secret: 'demo-github-secret' }),
      'Atlas 收到 GitHub PR：{{title}}（{{url}}）。请评审变更并输出风险清单。',
      1, 'per_zhouye', daysAgo(50), daysAgo(50), iso(400), 'success',
    );
    automationStmt.run(
      'aut_aurora_daily', 'prj_aurora', 'agt_aurora_support', '每日 9 点工单摘要', 'cron',
      JSON.stringify({ schedule: '0 9 * * *' }),
      '汇总过去 24 小时的客服工单：新增、未解决、需要人工升级的条目。',
      1, 'per_suyan', daysAgo(40), daysAgo(40), iso(60), 'success',
    );

    const deliveryStmt = db.prepare(
      `INSERT INTO inbound_deliveries (id, project_id, provider, delivery_id, event, status, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    deliveryStmt.run('dlv_demo_gitlab_1001', 'prj_orion', 'gitlab', 'demo-delivery-1001', 'merge_request', 'accepted', 'tsk_orion_queued', iso(38));
    deliveryStmt.run('dlv_demo_github_2001', 'prj_atlas', 'github', 'demo-delivery-2001', 'pull_request', 'accepted', 'tsk_atlas_done', iso(410));

    const activityStmt = db.prepare(
      `INSERT INTO activity_events (id, project_id, project_name, type, actor, summary, task_id, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const activities: [string, string, string, string, string, string | null, string | null, string][] = [
      ['prj_orion', 'Orion 订单服务', 'task.progress', 'Orion 开发智员', '完成 staging 压测：p95 41ms，正在补写后读兜底', 'tsk_orion_running', 'agt_orion_coder', iso(18)],
      ['prj_aurora', 'Aurora 智能客服', 'task.message', 'Aurora 客服智员', '等待人工确认补发 2 笔退款', 'tsk_aurora_waiting', 'agt_aurora_support', iso(120)],
      ['prj_atlas', 'Atlas 研发助手', 'task.completed', 'Atlas 评审智员', '完成 PR #482 评审：2 个高风险', 'tsk_atlas_done', 'agt_atlas_review', iso(380)],
      ['prj_orion', 'Orion 订单服务', 'task.created', '陈昊', '创建任务：为订单查询接口补幂等集成测试', 'tsk_orion_queued', 'agt_orion_coder', iso(38)],
      ['prj_lab', 'Hive 内部实验', 'task.failed', '平台运维智员', '任务失败：npm install 超时', 'tsk_lab_failed', 'agt_platform_ops', iso(560)],
    ];
    for (const [project, name, type, actor, summary, taskId, agentId, at] of activities) {
      activityStmt.run(newId('act'), project, name, type, actor, summary, taskId, agentId, at);
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_at', ?)").run(nowIso());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
