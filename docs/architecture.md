# Aiwo 架构

## 两条 DSH 通道

### 1. 任务执行：Aiwo 服务代理

```text
控制台创建任务（executor=人员@Aiwo）
  → work_items(queued)
  → 服务代理 claim（服务 token）
  → 组装 /goal prompt（项目 + 提示词卡片 + 任务）
  → dsh --profile acp（常驻，JSON-RPC stdio）
  → session/update 事件
  → /api/runtime/tasks/:id/events（批量）
  → /api/runtime/tasks/:id/complete
  → Aiwo 内置项目记忆写回
```

- 服务是独立资源，不依赖智员。
- 项目可绑定多个 DSH 服务；任务在绑定服务之间按项目 cursor 轮询，指定多个候选时只在这些服务中分配。项目未绑定服务时使用系统默认服务；无默认服务才进入共享池。
- 一个服务同一时刻执行一个任务；任务租约 3 分钟，progress 续租。
- ACP `session/new` 的 `cwd` 由 Aiwo DSH 插件按项目 ID 自动生成（默认 `~/.aiwo/workspaces/projects/<projectId>`）；同一项目固定同一路径，同一 ACP 进程可承载多个不同 cwd 的独立 session。
- ACP 不可用时自动回退 headless；两种模式都产生同样的 runtime_events。
- 任务结束即终止，不支持对话。
- 服务每 5s 查询任务状态；控制台取消后代理自动中止 ACP/headless 会话。
- 完成时从最终输出的「决策 / 经验」小节提取，随结果写入 Aiwo 内置项目记忆。

### 2. 助手：DSH headless + 开放 API

```text
右侧助手
  → POST /api/assistant/chat（人员 token）
  → Aiwo 启动 dsh --profile headless
  → prompt 携带 docs/api.md + 当前页面/taskId
  → 受限 aiwo_api HTTP 工具（无 bash/文件工具）
  → 操作项目/任务/卡片/服务/自动化
  → reply + HIVE_NAVIGATE
```

- 助手不进入任务队列，不占服务租约。
- 助手 API 契约来自 `GET /api/assistant/manifest`；默认 cwd 是独立的 `~/.aiwo/assistant`，不把 Aiwo 源码仓库作为工作区。
- 助手使用受限 profile：`bash/pwsh/jobs/fs/fs-search/skill/web/subagent/workflow` 等默认工具全部禁用，仅注册 `aiwo_api` HTTP 工具。
- 助手按项目 ID 的自动工作区设置 headless cwd；同一人员在同一项目复用会话，切项目时按 workspace 区分会话。
- 同一人员复用 DSH session，可跨轮对话。
- token 写入 0600 临时文件，不进入提示词。
- 前端收到 `navigate` 后跳转，并触发页面刷新。

## 安全检查

任务/助手输入在进入执行前可调用独立 LLM：

```text
input → security/check.ts
  ├─ endpoint 为空 / disabled → allow
  └─ OpenAI-compatible /v1/chat/completions
       ├─ allowed=true → continue
       └─ allowed=false → 400 + blockMessage
```

记录 `security_checks`（输入 digest、model、latency、原因），不存完整输入。

## 服务协议

```text
POST /api/runtime/instances/register
POST /api/runtime/instances/heartbeat     20s
POST /api/runtime/tasks/claim             5s
POST /api/runtime/tasks/:id/progress      90s 续租
POST /api/runtime/tasks/:id/events        ≤100/批，1s 节流
POST /api/runtime/tasks/:id/complete
```

服务 token 只存哈希；管理端创建/轮换时一次性返回明文和安装命令。
本机服务可由控制台「启动本机代理」直接拉起：服务端轮换 token、以环境变量注入，detached 启动 `integrations/aiwo-instance/agent.mjs`；远端仍由管理员复制安装命令执行。

## 记忆

项目记忆只保存跨任务可复用的知识（决策、约定、领域事实、架构、踩坑、runbook），不保存普通任务结果/日志。任务完成只产生决策/经验候选；做梦将其提升为 durable insight。


- 项目级记忆表 `project_memories`，按 `project_id` 隔离
- claim 注入最近的 durable 记忆/洞见简报（默认最多 500 字，可配置）；DSH 需要更多背景时调用工具检索
- 任务 DSH 通过 `--patch` 注册 `aiwo_memory_search/context/add`，工具只能访问当前任务所属项目
- 完成后 Aiwo 直接写入 `project_memories`，不依赖外部服务
- 记忆身份由项目决定：`aiwo_<slug>`
- 检索采用本地词项/中文二元组 + 时间衰减评分；上下文有 token 预算
- 做梦（memory dream）：调度器按项目周期扫描 `dreamed_at IS NULL` 的新记忆，归纳为 `insight`，只做增量，不重放旧记忆
