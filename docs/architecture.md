# Aiwo 架构

## 两条 DSH 通道

### 1. 任务执行：Aiwo 实例代理

```text
控制台创建任务（executor=人员@Aiwo）
  → work_items(queued)
  → 实例代理 claim（实例 token）
  → 组装 /goal prompt（项目 + 提示词卡片 + 任务）
  → dsh --profile acp（常驻，JSON-RPC stdio）
  → session/update 事件
  → /api/runtime/tasks/:id/events（批量）
  → /api/runtime/tasks/:id/complete
  → Mnemos 写回
```

- 实例是独立资源，不依赖智员。
- 一个实例同一时刻执行一个任务；任务租约 3 分钟，progress 续租。
- ACP 不可用时自动回退 headless；两种模式都产生同样的 runtime_events。
- 任务结束即终止，不支持对话。
- 实例每 5s 查询任务状态；控制台取消后代理自动中止 ACP/headless 会话。
- 完成时从最终输出的「决策 / 经验」小节提取，随结果写入 Mnemos。

### 2. 助手：DSH headless + 开放 API

```text
右侧助手
  → POST /api/assistant/chat（人员 token）
  → Aiwo 启动 dsh --profile headless
  → prompt 携带 docs/api.md + 当前页面/taskId
  → 助手通过 bash 调 aiwo-api.mjs
  → 操作项目/任务/卡片/实例/自动化
  → reply + HIVE_NAVIGATE
```

- 助手不进入任务队列，不占实例租约。
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

## 实例协议

```text
POST /api/runtime/instances/register
POST /api/runtime/instances/heartbeat     20s
POST /api/runtime/tasks/claim             5s
POST /api/runtime/tasks/:id/progress      90s 续租
POST /api/runtime/tasks/:id/events        ≤100/批，1s 节流
POST /api/runtime/tasks/:id/complete
```

实例 token 只存哈希；管理端创建/轮换时一次性返回明文和安装命令。
本机实例可由控制台「启动本机代理」直接拉起：服务端轮换 token、以环境变量注入，detached 启动 `integrations/aiwo-instance/agent.mjs`；远端仍由管理员复制安装命令执行。

## 记忆

- 项目级 Mnemos 配置：project.mnemosProjectId / API Key / memoryAgentId
- claim 返回 `memory` + `promptCards`
- 实例代理拉取 `/v1/context`，注入 prompt
- 完成后 Aiwo 服务端调用 Mnemos `/v1/memories` 写回
- 记忆身份由项目决定，不再按智员绑定
