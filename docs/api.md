# Hive API 速览

所有控制台接口为 JSON + 会话令牌：`Authorization: Bearer hive_sess_...`。
运行时接口用 Agent / Instance 令牌：`Authorization: Bearer hive_agt_... | hive_inst_...`。

## 认证与元信息

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{email,password}` → `{token, person}` |
| GET | `/api/auth/me` | 当前人员 |
| POST | `/api/auth/logout` | 注销会话 |
| GET | `/api/meta` | 产品名、版本、演示账号 |
| GET | `/api/health` | 健康检查 |

## 概览 / 团队 / 人员 / 项目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dashboard` | 当前人的概览数据 |
| GET | `/api/persons` | 人员列表（选择器） |
| GET | `/api/teams` | 我的团队（admin 全部） |
| POST | `/api/teams` | 创建团队（admin） |
| GET | `/api/teams/:id` | `{team, members, projects}` |
| PATCH | `/api/teams/:id` | 更新团队（lead/admin） |
| POST/DELETE | `/api/teams/:id/members[/:personId]` | 成员管理 |
| GET | `/api/projects` | 我可查看的项目（含 counts） |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | `{project, members, team}` |
| PATCH | `/api/projects/:id` | 项目设置（manage） |
| DELETE | `/api/projects/:id` | 删除项目（owner/admin） |
| POST/DELETE | `/api/projects/:id/members[/:personId]` | 项目成员 |
| GET/POST | `/api/projects/:id/agents` | 项目智员 / 关联智员 |
| PATCH/DELETE | `/api/projects/:id/agents/:agentId` | 更新/解除绑定 |

项目可见性：`private | team | public`；项目角色：`owner | maintainer | developer | reporter`。
响应中的项目只返回 `mnemosConfigured`，**永不返回 API Key 明文**。

## 智员 / 令牌 / 实例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agents?scope=mine|all` | 智员列表（含 stats） |
| POST | `/api/agents` | 创建智员 |
| GET | `/api/agents/:id` | `{agent, projects, tokens, instances}` |
| PATCH | `/api/agents/:id` | 更新智员（所有者/admin） |
| POST | `/api/agents/:id/tokens` | 创建 Agent 令牌（secret 仅一次） |
| DELETE | `/api/agents/:id/tokens/:tokenId` | 吊销令牌 |
| GET | `/api/instances` | 我的智员实例（admin 全部） |
| DELETE | `/api/instances/:id` | 吊销实例 |

## 任务（控制台）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks?projectId=&status=&mine=&limit=` | 任务列表（可见项目） |
| POST | `/api/projects/:id/tasks` | 创建任务 `{agentId,title,prompt,priority?}` |
| GET | `/api/tasks/:id` | `{task, messages, events, memory}` |
| POST | `/api/tasks/:id/messages` | 已禁用：任务执行过程只读，返回 409 |
| POST | `/api/assistant/chat` | DSH 系统助手；body `{message,pathname,projectId?}`，返回 `{reply,navigate?,sessionId?,instance}` |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| GET | `/api/activity?projectId=&limit=` | 活动流 |
| GET | `/api/events?token=&projectId=` | SSE（`event: activity`） |

## 运行时（DSH 实例）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/runtime/instances/register` | Agent 令牌注册实例，返回一次性实例 token |
| POST | `/api/runtime/instances/heartbeat` | 心跳 |
| GET | `/api/runtime/me` | 实例、Agent、可访问项目与 memoryAgentId |
| GET | `/api/runtime/conversations` | 已废弃，始终返回空数组（任务一次性 /goal，不可续聊） |
| POST | `/api/runtime/tasks/claim` | 领取任务（无任务 204） |
| POST | `/api/runtime/tasks/:id/progress` | 进展 + 续租 |
| POST | `/api/runtime/tasks/:id/messages` | 已禁用：任务内不支持对话，返回 409 |
| POST | `/api/runtime/tasks/:id/events` | 批量上报 DSH 运行时事件（实时日志） |
| GET | `/api/tasks/:id/runtime-events?after=` | 控制台读取运行时日志 |
| POST | `/api/runtime/tasks/:id/complete` | `{status,summary,decisions?,lessons?}` |

`claim` 返回 `memory`：`{baseUrl, projectId, apiKey, agentId, enabled}`，实例可直接用该配置访问 Mnemos。

## 自动化 / Webhook / 记忆

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/projects/:id/automations` | 自动化列表 / 创建 |
| PATCH/DELETE | `/api/automations/:id` | 更新 / 删除 |
| POST | `/api/automations/:id/run` | 手动运行 → 创建任务 |
| GET | `/api/automations/:id/runs` | 运行历史 |
| GET | `/api/projects/:id/deliveries` | 入站投递记录 |
| POST | `/api/integrations/github/:projectId` | `X-Hub-Signature-256` 验签 |
| POST | `/api/integrations/gitlab/:projectId` | `X-Gitlab-Token` 验签 |
| GET | `/api/projects/:id/memory/search?q=&agentId=&topK=` | Mnemos 记忆检索 |
| GET | `/api/projects/:id/memory/context?agentId=&q=` | 任务简报 prompt |

错误统一为 `{error:{code,message,details?,requestId}}`。
