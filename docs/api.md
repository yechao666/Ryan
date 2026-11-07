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

项目字段：`name,slug,description,ownerTeamId,visibility,type,prompt,repoUrl,mnemosProjectId,mnemosApiKey,memoryAgentId`。项目不配置工作目录；DSH 插件按项目 ID 在服务本机自动生成。

## 提示词卡片（Aiwo 没有智员，用卡片复用工作流/风格/标准）

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
| GET | `/api/tasks/:id/runtime-events?after=seq` | 控制台读取运行时事件 |

## 自动化

| Method | Path | 说明 |
| --- | --- | --- |
| GET/POST | `/api/projects/:id/automations` | 列表 / 创建 |
| PATCH/DELETE | `/api/automations/:id` | 更新 / 删除 |
| POST | `/api/automations/:id/run` | 手动运行 |
| GET | `/api/automations/:id/runs` | 运行历史 |

创建：`{name,triggerType:'cron'|'webhook'|'manual',triggerConfig,promptTemplate,promptCardIds,instanceId,enabled}`。

## 记忆（Mnemos）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:id/memory/search?q=&topK=` | 项目记忆搜索 |
| GET | `/api/projects/:id/memory/context?q=` | 项目记忆上下文 |

## 系统设置 / 安全检查

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 安全/助手配置（apiKey 不回显） |
| PATCH | `/api/settings/security` | `{enabled,endpoint,model,apiKey,timeoutMs,blockMessage}`；endpoint 为空即关闭 |
| POST | `/api/settings/security/test` | 测试安全模型连通性 |
| PATCH | `/api/settings/assistant` | `{enabled,instanceId,model}` |

## 助手

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/assistant/chat` | `{message,pathname,projectId?,taskId?}` → `{reply,navigate?,sessionId?,instance}` |
| POST | `/api/assistant/chat/stream` | 同上请求体，SSE 返回 `meta/status/thinking/tool/text/done/error`；文本逐段下发 |
| GET | `/api/assistant/manifest` | 助手使用的稳定 API 清单与前端路由表；包含任务查询到 `HIVE_NAVIGATE` 的规则 |

助手运行在 DSH headless 服务中，使用当前人员 token 调用上面的开放 API。
