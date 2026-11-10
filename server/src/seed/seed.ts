/** Ryan 演示数据：人员 / 团队 / 项目 / 提示卡 / 智能体 / 任务 / 自动化。 */
import type { DatabaseSync } from 'node:sqlite';
import { DEMO_PASSWORD } from '../../../shared/src/constants.ts';
import { hashPassword } from '../lib/password.ts';
import { nowIso, sha256 } from '../lib/ids.ts';

const NOW = Date.now();
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

/** 演示智能体令牌（仅演示环境；生产请在 UI 重新生成）。 */
export const DEMO_TOKENS = {
  local: 'aiwo_ins_demo_local_7f3a2c',
  remote: 'aiwo_ins_demo_remote_9b1d4e',
} as const;

const PEOPLE = [
  { id: 'per_linwei', email: 'lin.wei@ryan.dev', name: '林薇', title: '平台负责人', color: 'violet', admin: 1 },
  { id: 'per_chenhao', email: 'chen.hao@ryan.dev', name: '陈昊', title: '研发一组负责人', color: 'cyan', admin: 0 },
  { id: 'per_zhouye', email: 'zhou.ye@ryan.dev', name: '周野', title: '算法工程师', color: 'green', admin: 0 },
  { id: 'per_suyan', email: 'su.yan@ryan.dev', name: '苏妍', title: '数据合规', color: 'amber', admin: 0 },
] as const;

const TEAMS = [
  { id: 'tm_platform', name: '平台组', slug: 'platform', desc: '负责 Ryan 平台、智能体与基础设施。', lead: 'per_linwei' },
  { id: 'tm_rnd', name: '研发一组', slug: 'rnd-one', desc: '业务系统与交付。', lead: 'per_chenhao' },
] as const;

const MEMBERS: [string, string, string][] = [
  ['tm_platform', 'per_linwei', 'lead'],
  ['tm_platform', 'per_chenhao', 'member'],
  ['tm_platform', 'per_suyan', 'member'],
  ['tm_rnd', 'per_chenhao', 'lead'],
  ['tm_rnd', 'per_zhouye', 'member'],
];

function insertPerson(db: DatabaseSync, p: (typeof PEOPLE)[number], passwordHash: string): void {
  db.prepare(
    'INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(p.id, p.email, p.name, p.title, p.color, p.admin, passwordHash, iso(60 * 24 * 30));
}

export function seedIfEmpty(db: DatabaseSync): void {
  const row = db.prepare('SELECT COUNT(*) AS c FROM persons').get() as unknown as { c: number };
  if (Number(row.c) === 0) seedDatabase(db);
}

export function seedDatabase(db: DatabaseSync): void {
  const passwordHash = hashPassword(DEMO_PASSWORD);
  for (const person of PEOPLE) insertPerson(db, person, passwordHash);
  for (const team of TEAMS) {
    db.prepare('INSERT INTO teams (id, name, slug, description, lead_person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      team.id, team.name, team.slug, team.desc, team.lead, iso(60 * 24 * 20),
    );
  }
  for (const [teamId, personId, role] of MEMBERS) {
    db.prepare('INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, ?, ?)').run(
      teamId, personId, role, iso(60 * 24 * 10),
    );
  }

  db.prepare(
    `INSERT INTO projects (id, slug, name, description, owner_team_id, owner_person_id, visibility, type, prompt, repo_url,
                        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    'prj_calc',
    'calculator-demo',
    '本地 Git 演示 · 计算器',
    'Ryan 的本地 Git 演示项目：开发、测试、审查与合并。',
    'tm_platform',
    'per_linwei',
    'team',
    'local',
    '这是一个本地 Git 演示项目。开发在 feature/* 分支进行，合并前运行 python3 -m unittest -v；禁止直接修改 main；本地仓库没有 remote，不执行 push。',
    '/Volumes/wd2025/devel/aiworker/aiwo/.run/local-git-demo',
    iso(60 * 24 * 7),
    iso(12),
  );
  db.prepare('INSERT INTO project_members (project_id, person_id, role, added_at) VALUES (?, ?, ?, ?)').run(
    'prj_calc', 'per_linwei', 'owner', iso(60 * 24 * 7),
  );
  db.prepare('INSERT INTO project_members (project_id, person_id, role, added_at) VALUES (?, ?, ?, ?)').run(
    'prj_calc', 'per_chenhao', 'developer', iso(60 * 24 * 6),
  );

  const cards = [
    {
      id: 'pcard_dev_flow', name: '功能开发工作流', category: 'workflow', scope: 'org',
      desc: '从理解需求到提交、测试、交付的标准流程。',
      content: '1. 先阅读项目提示词和相关文件；2. 在 feature/* 分支实现；3. 自测并运行项目测试；4. 提交前 git diff 自查；5. 输出变更摘要、测试结果和风险。',
    },
    {
      id: 'pcard_quality', name: '交付质量标准', category: 'standard', scope: 'org',
      desc: '所有任务默认遵守的质量门槛。',
      content: '不修改与任务无关的文件；不删除用户数据；测试必须实际运行并贴出结果；不确定的结论标注“需要人工确认”。',
    },
    {
      id: 'pcard_style', name: '中文交付风格', category: 'style', scope: 'org',
      desc: '面向中文团队的结果表达方式。',
      content: '结论先行；使用简洁中文；列出关键决策、验证结果与未完成项；代码与命令使用行内代码。',
    },
    {
      id: 'pcard_review', name: '代码审查清单', category: 'standard', scope: 'project', projectId: 'prj_calc',
      desc: '计算器项目的审查合并检查项。',
      content: '检查功能正确性、边界条件、测试覆盖；合并前必须运行 python3 -m unittest -v，并确认工作区干净。',
    },
  ];
  for (const card of cards) {
    db.prepare(
      `INSERT INTO prompt_cards (id, name, category, description, content, scope, project_id, team_id, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 'per_linwei', ?, ?)`,
    ).run(card.id, card.name, card.category, card.desc, card.content, card.scope, card.projectId ?? null, iso(60 * 48), iso(60));
  }

  const localToken = DEMO_TOKENS.local;
  const remoteToken = DEMO_TOKENS.remote;
  db.prepare(
    `INSERT INTO dsh_instances
       (id, name, kind, host, port, base_url, workspace_path, version, plugin_version, token_hash, token_prefix,
        status, registered_at, last_seen_at, revoked_at, created_by, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, 'unconfigured', ?, NULL, NULL, ?, ?, ?, '{}')`,
  ).run(
    'ins_local', '本机 DSH', 'local', '127.0.0.1', 4501, '/Volumes/wd2025/devel/aiworker/aiwo/.run/workspace',
    '0.1.0', sha256(localToken), localToken.slice(0, 18), iso(60 * 24 * 3), 'per_linwei', iso(60 * 24 * 3), iso(60 * 24 * 3),
  );
  db.prepare(
    `INSERT INTO dsh_instances
       (id, name, kind, host, port, base_url, workspace_path, version, plugin_version, token_hash, token_prefix,
        status, registered_at, last_seen_at, revoked_at, created_by, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, NULL, ?, '', NULL, ?, ?, 'unconfigured', ?, NULL, NULL, ?, ?, ?, '{}')`,
  ).run(
    'ins_remote', '远端智能体 · 待接入', 'remote', '192.168.1.50', 4501, '/srv/aiwo-workspace',
    sha256(remoteToken), remoteToken.slice(0, 18), iso(60 * 24 * 2), 'per_linwei', iso(60 * 24 * 2), iso(60 * 24 * 2),
  );

  db.prepare(
    `INSERT INTO work_items
       (id, project_id, source, type, title, prompt, prompt_card_ids, status, priority, lease_until, instance_id,
        created_by, executor_person_id, created_at, started_at, finished_at, result, error, metadata, dedupe_key)
     VALUES (?, ?, 'seed', ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
  ).run(
    'tsk_demo_queue', 'prj_calc', 'feature', '为计算器补充乘法边界测试',
    '/goal 为计算器的 multiply 补充边界测试：负数、零、小数，运行测试后输出结果。',
    JSON.stringify(['pcard_dev_flow', 'pcard_quality']), 10, 'per_chenhao', 'per_chenhao', iso(45), '{}',
  );
  db.prepare(
    `INSERT INTO work_items
       (id, project_id, source, type, title, prompt, prompt_card_ids, status, priority, lease_until, instance_id,
        created_by, executor_person_id, created_at, started_at, finished_at, result, error, metadata, dedupe_key)
     VALUES (?, ?, 'seed', ?, ?, ?, ?, 'done', ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(
    'tsk_demo_done', 'prj_calc', 'docs', '整理计算器使用说明',
    '/goal 阅读 README，整理一份中文使用说明，输出结论与关键点。',
    JSON.stringify(['pcard_style']), 5, 'ins_local', 'per_linwei', 'per_linwei', iso(180), iso(175), iso(160),
    '已整理使用说明：支持四则运算、科学函数、历史记录与键盘操作。', '{}',
  );

  db.prepare(
    `INSERT INTO automations
       (id, project_id, instance_id, name, trigger_type, trigger_config, prompt_template, prompt_card_ids, enabled,
        created_by, created_at, updated_at, last_run_at, last_run_status)
     VALUES (?, ?, ?, ?, 'cron', ?, ?, ?, 1, ?, ?, ?, NULL, NULL)`,
  ).run(
    'aut_demo_daily', 'prj_calc', 'ins_local', '每日开发简报', JSON.stringify({ schedule: '0 10 * * *' }),
    '/goal 汇总项目最近 7 天的任务进展、风险和下一步计划，发送到团队邮箱。',
    JSON.stringify(['pcard_style']), 'per_linwei', iso(60 * 20), iso(60 * 20),
  );

  db.prepare(
    `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('security', ?, 'per_linwei', ?)`,
  ).run(JSON.stringify({ endpoint: '', enabled: false, model: '', apiKey: '', timeoutMs: 8000, blockMessage: '该输入未通过安全检查，请调整后重试。' }), iso(60));
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('assistant', ?, 'per_linwei', ?)`,
  ).run(JSON.stringify({ enabled: true }), iso(60));

  console.log('[aiwo] demo data seeded');
}
