# Hive 架构与领域模型

## 1. 分层

| 平面 | 职责 | 核心表 |
| --- | --- | --- |
| 身份与权限 | 人员、团队、项目、可见性、项目角色 | `persons` `teams` `team_members` `projects` `project_members` |
| 智员与成员关系 | 全局智员、项目内记忆身份、访问令牌 | `agents` `project_agents` `agent_tokens` |
| 工作编排 | 任务队列、人机消息、事件、自动化、入站投递 | `work_items` `task_messages` `task_events` `automations` `automation_runs` `inbound_deliveries` |
| 执行与记忆 | DSH 实例注册/心跳/接单/上报；Mnemos 读写 | `dsh_instances` `activity_events` + Mnemos `/v1` |

## 2. 身份与权限

### 可见性

- `private`：项目归属人 + 显式项目成员
- `team`：归属团队成员 + 显式项目成员
- `public`：组织内所有登录人员

### 项目角色

`owner > maintainer > developer > reporter`

| 操作 | owner | maintainer | developer | reporter | 团队 lead |
| --- | --- | --- | --- | --- | --- |
| 查看 | ✅ | ✅ | ✅ | ✅ | ✅（团队可见时） |
| 建任务 / 关联智员 / 建自动化 | ✅ | ✅ | ✅ | ❌ | ✅ |
| 改项目设置 / 成员 / 解除绑定 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 删除项目 | ✅ | ❌ | ❌ | ❌ | ❌ |

组织管理员拥有全部权限；权限在 `server/src/lib/access.ts` 统一实现，路由用 `requireProject`。

## 3. 智员身份

```
agents.id (agt_...)                 全局身份，归属某个人员
project_agents.memory_agent_id      项目内记忆身份（Mnemos agent_id）
```

- 同一智员加入多个项目时，每个项目有独立 `memory_agent_id`，避免跨项目记忆串味。
- 私有记忆：Mnemos `visibility=agent` + 该项目 `memory_agent_id`；项目共享：`visibility=project`。
- Agent 令牌（`hive_agt_...`）用于注册实例；实例令牌（`hive_inst_...`）用于心跳/接单/上报。两者都只存 SHA-256。

## 4. 任务状态机

```
queued ──claim──► running ──complete──► done
  │                  │
  │                  ├──progress──► running（续租）
  │                  ├──message───► waiting_input（人工介入时）
  │                  └──fail──────► failed
  └──cancel────────► cancelled
```

- 队列排序：`priority DESC, created_at ASC`；实例同时只执行 1 个任务。
- 租约 3 分钟，实例心跳/进展续租；过期任务回队列（MVP：claim 时回收）。
- 实例在线判定：最近心跳 5 分钟内（`ONLINE_WINDOW_MS`）。
- 任务完成写回 Mnemos：`visibility=project`，metadata `{hiveTaskId, projectId, agentId}`。

## 5. 实时活动

- 所有写操作通过 `recordActivity()` 同时写 `activity_events` 与进程内 `EventBus`。
- 控制台订阅 `GET /api/events?token=&projectId=`（SSE），只推送有权限的项目。
- 事件模型 `LiveEvent { id, type, projectId, taskId, agentId, actor, summary, at }`。

## 6. 自动化与 Webhook

```
GitHub/GitLab ──POST──► /api/integrations/<provider>/<projectId>
                          │ 验签（HMAC / token）+ delivery 去重
                          ▼
                    匹配 enabled webhook automation（event filter）
                          │ 模板渲染
                          ▼
                     work_item(source=webhook) ──► 实例 claim
```

- Cron：进程内每 30s 轮询，5 段表达式（`* , - /`），同一分钟只触发一次。
- 自动化 secret 仅项目 manage 角色可见；非 manage 返回 `***`。

## 7. 与 Mnemos 的边界

- Hive 不复制 Mnemos 记忆数据；通过 HTTP `/v1` 读写，项目配置保存在 `projects.mnemos_*`。
- 记忆检索/简报失败不影响任务执行：返回 `configured/error` 降级，不抛 500。
- 任务完成写回失败只记录日志，不回滚任务（避免记忆系统故障阻塞工作流）。

## 8. 已知边界

- SQLite 单写、单进程；多副本需要把任务队列与 SSE 总线外置。
- 无 OIDC/SSO、无审批流、无配额；这些是下一阶段。
- SSE token 走 query（EventSource 限制），仅本机使用；生产建议同源 cookie 或短期票据。
