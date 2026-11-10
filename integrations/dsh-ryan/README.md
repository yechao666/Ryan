# dsh-ryan

把当前 **DSH 实例**接入 Ryan：用 Ryan 账号自己创建的 API Key 注册为 智能体，
自动心跳、领取任务并用 DSH headless/ACP 执行。

## 安装

```bash
cd integrations/dsh-ryan
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile desktop add link:$PWD
```

安装后重启 DSH，在「设置 → 插件 → dsh-ryan」填写配置。

## 配置页

| 字段 | 说明 |
| --- | --- |
| `baseUrl` | Ryan 地址，例如 `http://127.0.0.1:4500` |
| `apiKey` | Ryan 账号页创建的 API Key（`ryan_ak_...`）；secret，只显示已配置 |
| `instanceName` | Ryan 服务列表展示名称，默认主机名 |
| `host` | 服务主机名，默认主机名 |
| `kind` | `local` / `remote`，默认 `remote`；DSH 与 Ryan 同机时可用 `local` |
| `workspaceRoot` | 项目工作区根目录，默认 `~/.ryan/workspaces` |
| `enabled` | 总开关 |

API Key 在 Ryan：**侧栏账户 → 个人账号 → API 密钥 → 创建密钥**。
密钥只显示一次；插件使用它注册服务，服务 token 由 Ryan 自动签发并每轮启动轮换。

## 工作方式

```text
Ryan 地址 + 用户 API Key
  → POST /api/runtime/instances/register-key
  → 获得一次性服务 token + instanceId
  → 启动随包 agent
  → 心跳 / claim / 执行 / events / complete
```

插件只托管 agent 进程；任务执行、工作区、事件上报均复用 `agent/` 内的服务代理。
同一 Ryan 账号可以给多台 DSH 各自创建独立密钥。

## 安全

- `apiKey` 标记为 secret，不写日志、不回显。
- 插件只在状态文件 `~/.dsh/state/dsh-ryan.json` 记录 `instanceId`，不持久化服务 token。
- 服务 token 每次启动重新签发；吊销 API Key 后插件无法再注册。
- 工作区路径由配置决定；任务代码只在 `workspaceRoot` 下执行。

## 排障

| 现象 | 处理 |
| --- | --- |
| 未启用或未配置 API Key | 在配置页填写 Ryan API Key |
| 接入 Ryan 失败 401 | Key 已吊销或复制错误，重新创建 |
| 服务在线但无任务 | 检查项目是否绑定服务、任务是否 queued |
| agent 无法启动 | 确认 `node`、`dsh` 可执行，查看 DSH 控制台日志 |
