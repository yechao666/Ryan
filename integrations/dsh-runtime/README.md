# dsh-hive-runtime

把一台 **DSH 实例**变成 Hive 的**数字员工运行时**：注册实例、心跳、自动领取任务，并用 **DSH headless** 子进程执行、上报进展与结果。

```
Hive 控制台 ──创建任务──► Hive API ◄──claim/心跳/上报── dsh-hive-runtime
                                                        │
                                                        ├─ headless（默认）：dsh --profile headless --json -
                                                        ├─ command：spawn 自定义命令
                                                        ├─ agent（可选）：进程内 agents.create
                                                        └─ echo：联调回显
```

## 功能

- **实例注册**：用 Agent 令牌注册 `ins_...`，实例令牌持久化，重启复用；401 自动重新注册。
- **心跳**：默认 20s，离线由 Hive 侧按 5 分钟窗口判定。
- **自动 claim**：默认 5s 轮询，按优先级领取；一个实例同时只执行 1 个任务。
- **执行**（`executionMode`）：
  - `headless`（默认）：每任务 spawn 一次 `dsh --profile <profile> --json -`，任务经 stdin 传入；解析 NDJSON（session/tool_call/text/final）用于进展与最终答案；子进程带 `DSH_HIVE_RUNTIME_DISABLED=1`，避免递归注册。
  - `command`：执行自定义命令（如容器/远程 worker），任务经环境变量注入，stdout 作为结果。
  - `agent`（可选，实验）：在宿主进程内用 `agents.create` 创建 Session；需要宿主提供 agents/sessions 服务。
  - `echo`：只回显任务，用于联调与冒烟。
- **项目提示词**：claim 返回的项目 `prompt` 会注入任务提示词，描述项目基本面/规范/约束。
- **记忆**：claim 返回的 Mnemos 配置可直接读取；默认额外拉取项目简报注入提示词（可关）。
- **完成写回**：摘要写为任务结果 + Agent 消息；Hive 负责写回项目记忆（失败不回滚任务）。
- **运行时可视化**：headless 的 session/status/thinking/text/tool_call/tool_result/final 事件实时批量上报，控制台任务抽屉以 SSE 展示。
- **任务对话**：任务一次性执行，提示词以 `/goal` 开头；执行过程只读，运行中/完成后都不接收对话消息，`/api/runtime/conversations` 仅保留空响应兼容旧插件。
- **失败处理**：异常/超时 → `failed` + 错误；超时会取消 Agent，避免后台继续跑。

## 安装

```bash
# 1) 首次准备 headless profile（后续任务都由它执行）
dsh headless --help

# 2) 构建并安装插件到本机 profile（无需 GUI 安装）
cd integrations/dsh-runtime
pnpm install --ignore-workspace && pnpm build
dsh plugin --profile desktop add link:/Volumes/wd2025/devel/aiworker/hive/integrations/dsh-runtime

# 3) 配置：写入 profile patch 或 DSH 设置页（两者等价）
#    - id: dsh-hive-runtime
#      config: { baseUrl, agentToken, executionMode: headless, ... }
```

> `link:` 加载的是 `lib/`；改 `src/**` 后必须重新 `pnpm build` 并重启 DSH。
> 生产可发布 npm/git 包，把 `lib` 一起提交或提供 `prepare` 构建。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:4400` | Hive 地址 |
| `agentToken` | 空 | Hive「智员 → 访问令牌」创建，`hive_agt_...`；secret 不落日志 |
| `instanceName` | 主机名 | 控制台展示的实例名 |
| `host` | 主机名 | 实例主机 |
| `workspacePath` | 进程 cwd | 任务工作区；agent 模式作为 Session 的 cwd |
| `autoClaim` | `true` | 是否自动领任务；关闭后只注册/心跳 |
| `pollIntervalMs` | `5000` | claim 轮询（最小 500ms） |
| `heartbeatIntervalMs` | `20000` | 心跳（最小 1s，生产建议 20s） |
| `executionMode` | `headless` | `headless` / `command` / `agent` / `echo` |
| `dshBin` | `dsh` | DSH 可执行文件；本机可写绝对路径 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | headless profile 与凭据所在 |
| `headlessProfile` | `headless` | 执行任务使用的 profile |
| `useDshCredentials` | `true` | 从 `$DSH_HOME/.credentials.yaml` 读取 `DEEPSEEK_API_KEY` 注入子进程 |
| `credentialsFile` | 空 | 自定义凭据文件 |
| `commandTemplate` | 空 | command 模式命令；任务在 `$HIVE_TASK_PROMPT` 等环境变量 |
| `maxTaskMinutes` | `30` | 单任务超时 |
| `includeMemoryContext` | `true` | 执行前拉 Mnemos `/v1/context` 注入简报 |
| `provider` / `model` | 空 | 覆盖默认模型；空则用 `agentDefaultModel` |
| `stateFile` | `$DSH_HOME/state/dsh-hive-runtime.json` | 实例 id/token 持久化（0600） |
| `announceToAgent` | `true` | 系统提示说明本实例有自动任务运行时 |
| `enabled` | `true` | 总开关 |

**Agent 令牌**在 Hive 控制台：智员详情 → 访问令牌 → 创建；同一智员可在多个项目工作，记忆身份由项目绑定的 `memory_agent_id` 决定。

## headless 凭据

headless bundle 使用**启动环境凭据**：本插件会优先读取进程环境 `DEEPSEEK_API_KEY`，否则从
`$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 取值，仅注入子进程 env，不写日志。
也可以设置 `useDshCredentials=false`，并在启动 DSH 的 shell 里 export。

## command 模式

适合把任务交给隔离进程（独立 profile / 容器 / 测试脚本）：

```text
commandTemplate = dsh --profile headless "$HIVE_TASK_PROMPT"
```

注入环境变量：`HIVE_TASK_ID`、`HIVE_TASK_TITLE`、`HIVE_TASK_PROMPT`、`HIVE_PROJECT_ID`、`HIVE_PROJECT_NAME`、`HIVE_INSTANCE_NAME`。
stdout 作为结果；非 0 退出码 → failed。

## 验证

```bash
pnpm test                          # 6 个测试：生命周期 / 401 重注册 / autoClaim / agent 执行器 / prompt / summary
node scripts/smoke-live.mjs        # 真实 Hive：创建令牌 → 建任务 → claim/echo/complete → 校验（需 4400）
```

- 单元测试用 mock Hive 与 fake DSH/headless 子进程，不依赖真实 LLM。
- `smoke-live` 只操作 `prj_lab`（未接 Mnemos），结束后吊销实例与令牌；请用 `pnpm seed` 重置演示任务。
- **本机真实链路已验证**：`mac-dsh-01` 注册 → 领取 `[本机 headless] 数字员工上线验证` → `dsh --profile headless` 执行 → 任务 done 并写回摘要；实例由 DSH 桌面宿主内的插件自动领取（安装后无需重启即可热加载）。
- `agent` 模式仍是可选项，首次使用建议先走 `headless`。

## 安全

- `agentToken` 存 DSH 设置（secret），不写日志、不回显。
- 实例 token 在 `stateFile`（0600）；删除该文件会让插件重新注册。
- 运行时会在配置的 `workspacePath` 内执行代码；请只给受信工作区与 Agent 令牌。
- 任务内容来自 Hive/webhook/人工消息，属于不可信输入；建议在 DSH profile 侧配置沙箱与审批策略。

## 排障

| 现象 | 处理 |
| --- | --- |
| 注册 401 | Agent 令牌无效/吊销；重新创建并更新 `agentToken` |
| claim 无任务 | 确认智员已绑定项目、项目 active、任务 status=queued；`autoClaim=true` |
| agent 模式报缺少服务 | 当前宿主没有 `agents/sessions`；改用 `command` 模式 |
| 任务一直 running | 检查心跳/日志；租约 3 分钟后 Hive 会回收 |
| 控制台显示离线 | 心跳超过 5 分钟；确认 DSH 进程存活、网络可达 |
