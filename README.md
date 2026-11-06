# Hive · 数字员工工作平台

人员管理智员，智员在项目中工作，记忆沉淀在 [Mnemos](../mnemos)。

Hive 不是"给人用的记忆库"，而是给 **数字员工（DSH 智员）** 用的工作平台：

- **人员**：真实的人，登录、组队、管项目、管智员；不需要自己的记忆。
- **团队**：人员可属于多个团队，团队有负责人；项目有归属团队。
- **项目**：可见性 `私有 / 团队 / 组织公开`，类型支持 `手动 / GitHub / GitLab`；可接入仓库 Webhook。
- **智员**：全局身份（`agt_...`）+ 项目内记忆身份（`memory_agent_id`）；一个智员可加入多个项目。
- **实例**：一台 DSH 运行实例（`ins_...`），注册、心跳、接单、上报进展；离线自动识别。
- **任务**：队列 + 只读执行过程；每个任务以 `/goal` 启动、一次性执行，任务内不支持对话，结束后不可续聊。
- **记忆**：智员通过 Mnemos 读写项目共享记忆与项目内私有记忆；任务完成自动写回结论。

## 功能（MVP）

| 模块 | 已实现 |
| --- | --- |
| 身份 | 登录/会话、人员、团队与成员、项目角色（owner/maintainer/developer/reporter） |
| 可见性 | 私有 / 团队 / 组织公开；后端统一鉴权 |
| 项目提示词 | 项目基本面（目标/规范/约束）随任务注入 DSH 运行时提示词 |
| 智员 | 全局注册表、能力/模型、项目绑定、`memory_agent_id`、Agent 令牌（一次性 secret） |
| 实例 | Agent 令牌注册实例、心跳、在线状态、吊销、当前任务 |
| 任务 | 队列、优先级、租约、领取、进展、取消、完成/失败；每个任务以 `/goal` 启动，执行过程只读，结束即终止 |
| 任务输出 | 完成后默认展示 Markdown 结论；执行过程在另一个只读 Tab |
| 任务类型 | 需求 / BUGFIX / 管理 / 运维 / 文档 / 其他；表格视图、类型/状态/关键词筛选、20 条/页分页 |
| 运行时可视 | 任务详情页实时展示 DSH 会话/步骤/工具调用/工具结果/输出/思考（SSE + 历史兜底） |
| 全局助手 | 真实 DSH 实例；三列常驻右栏，可折叠、可拖拽调宽；携带完整 URL/taskId |
| 实时 | SSE 活动流（任务/实例/消息） |
| 自动化 | 手动 / Webhook / Cron；运行历史；GitHub/GitLab 入站验签与去重 |
| 记忆 | 项目记忆搜索、任务简报 prompt、任务完成写回 Mnemos |
| 控制台 | 概览、项目、团队、智员、实例、任务、项目工作区（7 个页签） |

## 架构

```
┌───────────── 浏览器 ─────────────┐
│ React 控制台（Vite, 4401/4400）   │
└──────────────┬───────────────────┘
               │ /api（会话 Bearer + SSE）
┌──────────────▼───────────────────┐        HTTP /v1（Bearer API Key）
│ Hive 控制面（Node 26 + SQLite）   │ ───────────────────────────────┐
│ 人员/团队/项目/智员/实例/任务/自动化 │                                │
└──────────────┬───────────────────┘                          ┌─────▼─────┐
               │ 运行时协议（Agent/Instance Token）              │  Mnemos   │
┌──────────────▼───────────────────┐                          │ 记忆系统   │
│ DSH 实例（每台一个数字员工运行时）  │ ──── 记忆/简报/写回 ────────►│ 4380      │
└──────────────────────────────────┘                          └───────────┘
```

详细设计见 [`docs/architecture.md`](docs/architecture.md)。

## 界面

| 概览 | 项目工作区 · 任务 |
| --- | --- |
| ![概览](docs/screenshots/02-dashboard.png) | ![任务](docs/screenshots/06-project-tasks.png) |

| 任务详情页 · 三列布局 | 项目记忆（Mnemos） |
| --- | --- |
| ![任务详情页](docs/screenshots/46-three-columns-task.png) | ![记忆](docs/screenshots/10-project-memory.png) |

| 执行过程（历史） | 执行过程（实时） |
| --- | --- |
| ![运行时日志](docs/screenshots/19-runtime-log.png) | ![实时执行](docs/screenshots/20-runtime-live.png) |

| 本地 Git 演示 · 项目记忆（Mnemos） | 统一任务对话（消息 + 工具） |
| --- | --- |
| ![本地项目记忆](docs/screenshots/21-local-memory.png) | ![任务对话](docs/screenshots/23-task-conversation.png) |

| 思考过程（预览 + 展开） |
| --- |
| ![思考过程](docs/screenshots/24-thinking.png) |

| 任务表格（类型 / 筛选 / 分页） | DSH 系统助手（真实 API 操作） |
| --- | --- |
| ![任务表格](docs/screenshots/31-sort-resize.png) | ![DSH 助手](docs/screenshots/39-assistant-write.png) |

| 助手当前任务上下文 |
| --- |
| ![助手任务上下文](docs/screenshots/45-assistant-task-context.png) |

| 任务结论（默认，Markdown） | 执行过程（只读） |
| --- | --- |
| ![任务结论](docs/screenshots/36-result-tab.png) | ![执行过程](docs/screenshots/37-process-tab.png) |

更多：`docs/screenshots/`（登录、项目、智员、实例、团队、自动化、设置、执行过程、项目记忆、任务对话、思考过程、任务表格、DSH 助手、任务结论等 36 张）。

## 快速开始

```bash
cd hive
pnpm install
pnpm seed                 # 演示数据（人员/团队/项目/智员/实例/任务/自动化）
pnpm dev                  # API: http://127.0.0.1:4400
pnpm dev:web              # 控制台: http://127.0.0.1:4401（Vite 代理 /api）
# 或生产模式
pnpm build && pnpm start  # http://127.0.0.1:4400
```

演示账号（密码 `hive-demo`）：

| 邮箱 | 姓名 | 角色 |
| --- | --- | --- |
| `lin.wei@hive.dev` | 林薇 | 组织管理员 |
| `chen.hao@hive.dev` | 陈昊 | 团队负责人（研发一组） |
| `zhou.ye@hive.dev` | 周野 | 算法工程师 |
| `su.yan@hive.dev` | 苏妍 | 数据合规 |

演示运行时令牌（仅用于本地联调，生产请重新签发）：

```text
Agent:    hive_agt_demo_orion_coder_7f3a2c
Instance: hive_inst_demo_orion_01_5d9e3b
```

## 运行时协议（DSH 接单）

```bash
# 1) 用 Agent 令牌注册实例（一次性返回 instance token）
curl -X POST localhost:4400/api/runtime/instances/register \
  -H "authorization: Bearer hive_agt_demo_orion_coder_7f3a2c" \
  -H 'content-type: application/json' \
  -d '{"name":"orion-dsh-01","host":"dev-mac","workspacePath":"/workspace/orion","version":"dsh 0.2.1"}'

# 2) 心跳 / 领取任务 / 上报 / 完成
curl -X POST localhost:4400/api/runtime/instances/heartbeat -H "authorization: Bearer <instance token>"
curl -X POST localhost:4400/api/runtime/tasks/claim        -H "authorization: Bearer <instance token>"
curl -X POST localhost:4400/api/runtime/tasks/<id>/progress -H "authorization: Bearer <instance token>" \
  -H 'content-type: application/json' -d '{"message":"已完成查询路径盘点","payload":{"progress":40}}'
curl -X POST localhost:4400/api/runtime/tasks/<id>/complete -H "authorization: Bearer <instance token>" \
  -H 'content-type: application/json' \
  -d '{"status":"done","summary":"查询拆到只读副本，p95 降低 51%","decisions":["写后读主库兜底"],"lessons":["租户维度要进缓存 key"]}'
```

`claim` 返回任务、项目、Agent、`memory`（Mnemos baseUrl/projectId/apiKey/agentId）与历史消息；实例直接用这些配置读写记忆。

## Mnemos 集成

项目设置里填 `Mnemos 项目 ID` 与 `API Key`（只存服务端，不回显），随后：

- 项目「记忆」页可搜索项目记忆、生成任务简报 prompt
- 任务「完成」会把结论/决策/经验写成项目共享记忆（`visibility=project`，metadata 带 `hiveTaskId`）
- Agent 的 `memory_agent_id` 决定记忆归属：同一智员在不同项目使用不同 project 内身份

演示项目已关联 Mnemos 的 `prj_orion_python` / `prj_atlas_copilot` / `prj_aurora_support`。

## 自动化与仓库 Webhook

- 自动化触发：`manual`（控制台运行）、`webhook`（GitHub/GitLab 事件）、`cron`（5 段表达式）
- Webhook 地址：`/api/integrations/github/<projectId>`、`/api/integrations/gitlab/<projectId>`
- GitHub：`X-Hub-Signature-256` HMAC；GitLab：`X-Gitlab-Token`；按 `delivery id` 去重
- 事件 → 模板渲染（`{{project}} {{event}} {{title}} {{url}} {{actor}} {{branch}}`）→ 任务入队

## 安全边界（MVP）

- 会话令牌、Agent 令牌、实例令牌均只存哈希；secret 只在创建时返回一次
- 项目可见性 + 项目角色在服务端统一校验（不是前端隐藏）
- Webhook 验签、原始 body HMAC、delivery 去重、请求体 1MB 上限
- Mnemos API Key 只存服务端；任何 API 不返回明文
- 已知限制：SQLite 单机、无 OIDC/SSO、无多副本、Cron 调度为进程内 30s 轮询、任务并发按实例 1 个执行

## DSH 数字员工运行时（dsh-hive-runtime）

把一台 DSH 实例接入平台：注册、心跳、自动 claim，并用 `dsh --profile headless` 执行任务、上报结果。

```bash
dsh headless --help                      # 首次准备 headless profile
cd integrations/dsh-runtime
pnpm install --ignore-workspace && pnpm build
dsh plugin --profile desktop add link:$PWD   # 通过 DSH 命令安装
# 配置写 profile patch 或设置页：baseUrl / agentToken / workspacePath / executionMode=headless
```

- 项目提示词会随 claim 注入 headless 提示词（dev/review 两个 worker 已验证）
- `executionMode=headless`（默认）：每任务 spawn `dsh --profile headless --json -`，NDJSON 进展 + final 结果
- `command`：交给自定义命令/容器
- `agent`（可选）：进程内 `agents.create`
- `echo`：链路联调
- 测试：`pnpm test:runtime`（8 项）；真实联调 `node integrations/dsh-runtime/scripts/smoke-live.mjs`

详见 [`integrations/dsh-runtime/README.md`](integrations/dsh-runtime/README.md)。

## 验证

```bash
pnpm verify          # 类型检查 + 30 个服务端测试 + 控制台构建
node scripts/smoke.mjs   # 32 项端到端冒烟（需 4400 + Mnemos 4380）
python3 scripts/shot-pw.py  # 17 张截图（Playwright + 本机 Chrome）
```

- 单测：身份/权限、运行时/队列、cron、模板、Webhook 签名，共 30 项
- 冒烟：登录与可见性 403、项目/智员/实例、任务创建/消息/领取/进展/完成、Mnemos 检索/写回、自动化、GitLab 验签/去重、SSE
- 演示数据：4 位人员、3 个团队、5 个项目、5 个智员、3 个实例、5 个任务、3 个自动化

## 目录

```
hive/
  shared/          # 前后端共享类型/常量
  server/          # Node 26 + node:sqlite + 原生 http
    src/http/      # 路由/鉴权/权限/响应
    src/runtime/   # 实例协议、队列、调度、模板、签名
    src/memory/    # Mnemos 客户端
    src/seed/      # 演示数据
  web/             # React 19 + Vite 控制台
  docs/            # 设计/接口
```

## Roadmap

- 人员/团队/项目/智员/实例/任务（MVP）✅
- DSH 插件接入运行时协议（注册/接单/headless 执行/实时事件/一次性 /goal）✅
- 审批门禁、配额、审计导出 ⏳
- Postgres + 多副本 + 队列外置 ⏳
