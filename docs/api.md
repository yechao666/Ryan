# Aiwo API

Base URL: `http://127.0.0.1:4500`。控制台使用会话 Bearer token；服务运行时使用 `aiwo_ins_...` token；助手使用当前人员 token。

## 认证 / 人员 / 团队 / 项目

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{email,password}` → `{token,person}` |
| GET | `/api/auth/me` | 当前人员 |
| GET | `/api/persons` | 人员列表 |
| GET/POST | `/api/teams` | 团队列表 / 创建 |
| GET/PATCH | `/api/teams/:id` | 团队详情 / 更新 |
| POST/DELETE | `/api/teams/:id/members` | 加人 / 移除成员 |
| GET/POST | `/api/projects` | 项目列表 / 创建 |
| GET/PATCH/DELETE | `/api/projects/:id` | 项目详情 / 更新 / 删除 |
| POST/DELETE | `/api/projects/:id/members` | 项目成员 |

项目字段：`name,slug,description,ownerTeamId,visibility,type,prompt,repoUrl`。项目不配置工作目录；DSH 插件按项目 ID 在服务本机自动生成。项目记忆由 Aiwo 内置维护。

## 提示卡（Aiwo 没有智员，用卡片复用工作流/风格/标准）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/prompt-cards` | 当前人员可见卡片；可选 `?projectId=&category=` |
| GET | `/api/projects/:id/prompt-cards` | 项目可引用的组织/团队/项目卡片 |
| POST | `/api/prompt-cards` | `{name,category,description,content,scope,projectId?,teamId?,personId?,enabled}` |
| PATCH/DELETE | `/api/prompt-cards/:id` | 编辑 / 删除 |

scope：`org | team | project | person`；person 级卡片仅指定人员可引用；category：`workflow | style | standard | role | other`。

## DSH 服务资源

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/instances` | 服务列表（状态/当前任务）；项目绑定关系通过项目服务 API 管理 |
| POST | `/api/instances` | 管理员创建；返回一次性 `token` 与安装命令 |
| PATCH | `/api/instances/:id` | 名称/host/端口/Base URL |
| GET | `/api/projects/:id/services` | 项目绑定的 DSH 服务 |
| PATCH | `/api/projects/:id/services` | `{serviceIds:string[]}` 设置项目绑定服务 |
| POST | `/api/instances/:id/token` | 轮换服务 token |
| POST | `/api/instances/:id/start` | 本机服务：服务端自动启动服务代理（轮换 token） |
| POST | `/api/instances/:id/test` | 测试插件心跳/在线状态 |
| DELETE | `/api/instances/:id` | 吊销服务 |

创建示例：

```json
{"name":"远端 DSH 服务","kind":"remote","host":"192.168.1.50","port":4501}
```

服务插件安装：

```bash
node integrations/aiwo-instance/agent.mjs --base http://<aiwo>:4500 --token aiwo_ins_xxx
```

## 任务

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/tasks` | `?projectId=&status=&type=&mine=&limit=`；返回 `executorLabel`、`promptCards` |
| GET | `/api/tasks/:id` | `{task,events,memory}` |
| POST | `/api/projects/:id/tasks` | `{title?,prompt,type,promptCardIds,instanceIds,priority}`；title 留空时由 AI 整理，prompt 是任务内容；instanceIds 为空时按项目绑定公平调度 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |

Aiwo 任务执行者固定为「创建人@Aiwo」；任务不支持对话，只展示执行过程。

## 运行时（服务代理使用）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/runtime/instances/agent-package` | 服务 token 拉取服务代理 tar.gz，用于远端安装 |
| POST | `/api/runtime/instances/register` | 服务 token 注册/更新资源信息 |
| POST | `/api/runtime/instances/heartbeat` | 心跳，返回 pending |
| POST | `/api/runtime/tasks/claim` | 领取任务；返回 `{task,project,executor,promptCards,memory}` |
| GET | `/api/runtime/tasks/:id/status` | 服务侧查询任务状态（用于感知取消） |
| POST | `/api/runtime/tasks/:id/progress` | 进展 + 续租 |
| POST | `/api/runtime/tasks/:id/events` | 批量运行时事件（≤100） |
| POST | `/api/runtime/tasks/:id/complete` | `{status,summary,decisions,lessons,sessionId}` |
| GET | `/api/runtime/tasks/current` | 当前服务正在执行的任务 |
| POST | `/api/runtime/tasks/:id/memory/search` | `{query,topK?}` 当前任务项目记忆检索 |
| GET | `/api/runtime/tasks/:id/memory/context?query=` | 当前任务项目记忆简报 |
| POST | `/api/runtime/tasks/:id/memory/add` | `{content,title?,category?}` 写入候选记忆（fact/decision/lesson/note） |

| GET | `/api/tasks/:id/runtime-events?after=seq` | 控制台读取运行时事件 |

## 自动化

| Method | Path | 说明 |
| --- | --- | --- |
| GET/POST | `/api/projects/:id/automations` | 列表 / 创建 |
| PATCH/DELETE | `/api/automations/:id` | 更新 / 删除 |
| POST | `/api/automations/:id/run` | 手动运行 |
| GET | `/api/automations/:id/runs` | 运行历史 |

创建：`{name,triggerType:'cron'|'webhook'|'manual',triggerConfig,promptTemplate,promptCardIds,instanceId,enabled}`。

## 记忆（Aiwo 内置）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:id/memory/search?q=&topK=` | 项目记忆检索 |
| GET | `/api/projects/:id/memory/context?q=` | 项目记忆上下文简报 |
| GET | `/api/projects/:id/memory/brief` | 最近记忆/洞见的记忆简报 |
| PATCH | `/api/projects/:id/memory/brief` | `{maxChars}` 设置简报最大字数（100–5000，默认 500） |

| GET | `/api/projects/:id/memories?limit=` | 列出项目记忆 |
| POST | `/api/projects/:id/memories` | `{content,title?,category?}` 手动写入持久记忆 |
| DELETE | `/api/projects/:id/memories/:memoryId` | 删除单条项目记忆 |
| DELETE | `/api/projects/:id/memories` | `{ids:string[]}` 批量删除项目记忆 |
| GET | `/api/projects/:id/memory/dream` | 做梦设置、待整理数量与最近运行 |
| PATCH | `/api/projects/:id/memory/dream` | `{enabled,intervalMinutes}` 设置增量做梦周期 |
| POST | `/api/projects/:id/memory/dream/run` | 立即执行一次增量做梦 |


记忆按项目隔离。普通任务结果留在任务历史；只有决策/经验候选经做梦提升为持久洞见。不需要外部 Mnemos 服务或 API Key。

## 账号与统一认证

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/auth/providers` | 登录页可用的统一认证源 |
| GET | `/api/auth/sso/:slug/start?returnTo=` | 发起 OIDC 登录 |
| GET | `/api/auth/sso/:slug/callback` | OIDC 回调，成功后重定向 `/login#token=...` |
| GET | `/api/account` | 当前人员资料、密码状态、已绑定身份 |
| PATCH | `/api/account` | `{name?,title?}` 更新账号资料 |
| POST | `/api/account/password` | `{currentPassword?,newPassword}` 设置/修改本地密码 |
| POST | `/api/account/sso/:providerId/start` | 绑定统一认证，返回授权 URL |
| DELETE | `/api/account/identities/:id` | 解绑统一认证 |
| GET | `/api/settings/auth-providers` | 管理员查看认证源（Secret 不回显） |
| POST | `/api/settings/auth-providers` | 添加 OIDC 认证源 |
| PATCH | `/api/settings/auth-providers/:id` | 修改/启停认证源 |
| DELETE | `/api/settings/auth-providers/:id` | 删除认证源 |
| GET | `/api/settings/accounts` | 管理员查看人员账号 |
| POST | `/api/settings/accounts` | 管理员创建本地账号 |
| PATCH | `/api/settings/accounts/:id` | 管理员维护资料/管理员权限/重置密码 |

统一认证使用 OIDC authorization code + PKCE；redirect URI 为：

```text
<AIWO_PUBLIC_URL>/api/auth/sso/<slug>/callback
```

## 系统设置 / 安全检查

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 安全/助手配置（apiKey 不回显） |
| PATCH | `/api/settings/security` | `{enabled,endpoint,model,apiKey,timeoutMs,blockMessage}`；endpoint 为空即关闭 |
| POST | `/api/settings/security/test` | 测试安全模型连通性 |
| PATCH | `/api/settings/assistant` | `{enabled,instanceId,model}` |
| PATCH | `/api/settings/default-service` | `{serviceId:string|null}` 设置/取消默认 DSH 服务 |

## 助手

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/assistant/chat` | `{message,pathname,projectId?,taskId?,conversationId?}` → `{reply,navigate?,sessionId?,instance}` |
| POST | `/api/assistant/chat/stream` | 同上请求体（含 conversationId），SSE 返回 `meta/status/thinking/tool/text/done/error`；文本逐段下发 |
| GET | `/api/assistant/manifest` | 助手使用的稳定 API 清单与前端路由表；包含任务查询到 `HIVE_NAVIGATE` 的规则 |
| POST | `/api/assistant/suggestions` | `{pathname,projectId?,taskId?,context?}` → 本机 DSH 生成的 3 条下一步任务推荐 |


助手运行在 DSH headless 服务中，使用当前人员 token 调用上面的开放 API。
