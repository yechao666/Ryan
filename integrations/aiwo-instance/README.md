# aiwo-instance — Aiwo DSH 服务代理

把一台安装了 **DSH** 的机器接入 **Aiwo**：代理 outbound 连接 Aiwo 运行时，领取任务后用
DSH 的 **ACP** 模式执行；ACP 不可用时自动回退 **headless**。适合本地与远端（远端无需暴露端口）。

```
Aiwo 控制台 ──创建任务──► Aiwo API ◄── register / heartbeat / claim / events / complete ── aiwo-instance
                                                                                            │
                                                                        常驻 `dsh --profile acp`（ACP v1 stdio）
                                                                        └─ 不可用时回退 `dsh --profile headless --json -`
```

## 目录

| 文件 | 说明 |
| --- | --- |
| `agent.mjs` | 入口：参数解析、注册、心跳、claim、执行、上报、优雅停止 |
| `lib/acp.mjs` | ACP 执行器（`@agentclientprotocol/sdk` + `dsh --profile acp` 常驻子进程） |
| `lib/headless.mjs` | headless 回退执行器（`dsh --profile headless --json -`） |
| `lib/prompt.mjs` | 提示词组装（`/goal` 开头 + 项目提示词 + 引用卡片 + 执行者） |
| `lib/events.mjs` | 运行时事件批量上报（100 条/批，1s 节流） |
| `lib/http.mjs` | Aiwo 运行时 API 客户端（服务 token 鉴权） |
| `lib/credentials.mjs` | 从 `$DSH_HOME/.credentials.yaml` 注入 headless 所需 `DEEPSEEK_API_KEY` |
| `test/smoke.mjs` | mock Aiwo + fake ACP/headless 冒烟测试（不依赖真实 DSH） |
| `scripts/install-local.sh` | 本地安装依赖并启动 |

## 前置

- Node.js ≥ 20（开发环境 Node 26）
- DSH CLI 在 `PATH`（或 `--dsh-bin` 指定绝对路径），并已配置模型凭据
- ACP profile 可用：

  ```bash
  dsh --profile acp --help     # 应输出 "Serve automation clients over Agent Client Protocol stdio."
  ```

  `acp` 是 DSH 自带 profile；首次启动时 `$DSH_HOME` 需要可写（DSH 会创建 profile 目录）。
  若 `DSH_HOME` 不可写或 profile 不存在，代理会记录原因并回退 headless。
- 一个 Aiwo **服务 token**（`aiwo_ins_...`）：Aiwo 控制台 → 服务 → 创建/重置 token；
  页面会给出可直接复制的启动命令。

## 从 Aiwo 下载代理包（远端推荐）

服务 token 可以直接拉取代理包，不需要先克隆 Aiwo 仓库：

```bash
TOKEN=aiwo_ins_xxx
BASE=http://<aiwo-host>:4500
curl -fsSL -H "authorization: Bearer $TOKEN" "$BASE/api/runtime/instances/agent-package" | tar xz
cd aiwo-instance && npm install
AIWO_BASE_URL=$BASE AIWO_INSTANCE_TOKEN=$TOKEN \
  node agent.mjs --workspace /srv/aiwo-workspace --name my-dsh-01
```

## 快速开始（本地）

```bash
cd integrations/aiwo-instance
npm install                     # 或 pnpm install / npm ci

node agent.mjs \
  --base http://127.0.0.1:4500 \
  --token aiwo_ins_xxxxxxxx \
  --workspace /path/to/task-workspace \
  --name my-dsh-01
```

或使用安装脚本（安装依赖后直接启动；额外参数原样传给 agent）：

```bash
bash scripts/install-local.sh --base http://127.0.0.1:4500 --token aiwo_ins_xxx --workspace /srv/aiwo-workspace
```

启动后：

1. 立即 `POST /api/runtime/instances/register` 上报 `name/host/version/pluginVersion`；服务登记不要求项目或工作目录；
2. 每 20s 心跳；
3. 每 5s 轮询 claim，一个服务同时只执行一个任务；
4. 任务结束上报 `complete`，控制台「任务 → 运行日志」实时查看事件。

### 联调 / 一次性执行

```bash
# 只执行一个任务后退出（便于验收）
node agent.mjs --base http://127.0.0.1:4500 --token aiwo_ins_xxx --workspace /tmp/ws --once

# 跳过 ACP，直接验证 headless 回退
node agent.mjs ... --force-headless --once
```

### 检查连接

```bash
TOKEN=aiwo_ins_xxx
curl -s -X POST http://127.0.0.1:4500/api/runtime/instances/heartbeat \
  -H "authorization: Bearer $TOKEN" | head -c 400
# 期望：{"ok":true,"instance":{...,"status":"online"},"pending":N}
```

Aiwo 控制台服务页应显示 `online`，`pluginVersion` 为 `0.1.0`。

## 环境变量

命令行参数优先于环境变量；`--help` 可查看完整列表。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AIWO_BASE_URL` | `http://127.0.0.1:4500` | Aiwo 地址（`--base`） |
| `AIWO_INSTANCE_TOKEN` / `AIWO_TOKEN` | 空（必填） | 服务 token（`--token`） |
| `AIWO_WORKSPACE` | 当前目录 | 无项目 ID 时的回退工作区（`--workspace`） |
| `AIWO_WORKSPACE_ROOT` | `~/.aiwo/workspaces` | 按项目 ID 自动生成 `projects/<projectId>` 的根目录（`--workspace-root`） |
| `AIWO_DSH_BIN` | `dsh` | DSH 可执行文件（`--dsh-bin`） |
| `AIWO_DSH_PROFILE` | `acp` | ACP profile（`--profile`） |
| `AIWO_HEADLESS_PROFILE` | `headless` | 回退 profile（`--headless-profile`） |
| `DSH_HOME` | `~/.dsh` | DSH home（`--dsh-home`） |
| `AIWO_INSTANCE_NAME` | 主机名 | 服务展示名（`--name`） |
| `AIWO_INSTANCE_HOST` | 主机名 | 主机（`--host`） |
| `AIWO_INSTANCE_KIND` | 沿用服务端 | `local` / `remote`（`--kind`） |
| `AIWO_INSTANCE_PORT` | 空 | 服务端口（`--port`） |
| `AIWO_HEARTBEAT_MS` | `20000` | 心跳间隔，≥200（`--heartbeat`） |
| `AIWO_POLL_MS` | `5000` | claim 轮询，≥100（`--poll`） |
| `AIWO_LEASE_RENEW_MS` | `90000` | 任务运行中续租间隔；`0` 关闭（`--lease-renew`） |
| `AIWO_TASK_TIMEOUT_MS` | `1800000` | 单任务超时；`0` 关闭（`--task-timeout`） |
| `AIWO_ACP_INIT_TIMEOUT_MS` | `30000` | ACP initialize 超时（`--acp-init-timeout`） |
| `AIWO_ACP_PERMISSION` | `allow` | ACP 权限请求：`allow` 自动允许 / `reject` 拒绝（`--permission`） |
| `AIWO_FORCE_HEADLESS` | `0` | `1` 跳过 ACP（`--force-headless` / `--no-acp`） |
| `AIWO_ONCE` | `0` | `1` 执行一个任务后退出（`--once`） |
| `AIWO_VERBOSE` | `0` | `1` 调试日志（`--verbose`） |
| `AIWO_DISABLE_CREDENTIALS` | `0` | `1` 不读取 `$DSH_HOME/.credentials.yaml`（`--no-credentials`） |
| `DEEPSEEK_API_KEY` | 空 | headless 直接使用；未设置时从 `$DSH_HOME/.credentials.yaml` 的 `refs` 注入 |

## 执行流程

1. **提示词**：`/goal` 开头 → `# 项目背景`（项目 prompt）→ `# 引用提示卡`（claim.promptCards）
   → `# 任务`（task.title + 去掉 `/goal` 前缀的 task.prompt）→ `# 执行者`（executor.label）。
   最终 stdin 一定以 `/goal` 开头。
2. **ACP**：常驻 `dsh --profile acp`，每任务用项目工作区 `session/new {cwd}` → `session/prompt`；
   插件按项目 ID 在 `--workspace-root`（默认 `~/.aiwo/workspaces`）下生成 `projects/<projectId>` 作为该会话 `cwd`；同一项目固定同一目录。
   消费 `session/update`：
   - `agent_message_chunk` → `text`
   - `agent_thought_chunk` → `thinking`
   - `tool_call` / `tool_call_update`（completed/failed）→ `tool_call` / `tool_result`
   - `usage_update` 等 → `status`
   - 结束 → `final`，并 `complete {status, summary, sessionId}`
   - `session/request_permission` 按 `--permission` 自动允许/拒绝（默认允许 allow_once）。
3. **事件上报**：内存队列批量 `POST /api/runtime/tasks/:id/events`，每批 ≤100，1s 节流；
   失败保留队列重试；任务结束时尽力 flush。
4. **续租**：长任务每 90s `POST /api/runtime/tasks/:id/progress` 续租（服务端租约 3 分钟）。
5. **回退**：ACP 初始化失败（找不到 dsh/profile/SDK、initialize 超时）→ 记录 `回退 headless`，
   用 `dsh --profile headless --json -` 重跑当前任务，后续任务继续使用 headless。
6. **失败**：ACP prompt 错误、headless 非零退出、超时都会 `complete {status:'failed', error}`。
7. **停止**：`SIGINT`/`SIGTERM` 停止心跳/轮询；正在执行的任务发送 ACP `session/cancel` 并上报
   `failed`（服务停止），随后退出；再次信号强退（130）。
8. **任务取消**：代理每 5s 查询任务状态，控制台取消后中止 ACP/headless 会话；`decisions/lessons` 从最终输出的「决策 / 经验」小节提取后写回。

## 远端安装

远端只需要能 outbound 访问 Aiwo，无需开放入站端口：

```bash
# 方式 A：直接拷贝目录（含 package-lock.json）
scp -r integrations/aiwo-instance user@host:/opt/aiwo-instance
ssh user@host 'cd /opt/aiwo-instance && npm ci && node agent.mjs --base https://aiwo.example.com --token aiwo_ins_xxx --workspace /srv/aiwo-workspace --name remote-01'

# 方式 B：打包
cd integrations/aiwo-instance && npm pack
scp aiwo-instance-0.1.0.tgz user@host:/opt/
ssh user@host 'cd /opt && tar xzf aiwo-instance-0.1.0.tgz && cd package && npm ci'
```

远端需安装 DSH 并配置模型凭据（`DSH_HOME` 可写、`~/.dsh/.credentials.yaml` 或 `DEEPSEEK_API_KEY`）。
工作区建议用独立系统用户（例如 `aiwo`），避免代理接触无关文件。

### systemd

`/etc/systemd/system/aiwo-instance.service`：

```ini
[Unit]
Description=Aiwo DSH instance agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aiwo
WorkingDirectory=/opt/aiwo-instance
Environment=AIWO_BASE_URL=https://aiwo.example.com
Environment=AIWO_WORKSPACE=/srv/aiwo-workspace
Environment=DSH_HOME=/home/aiwo/.dsh
EnvironmentFile=/etc/aiwo-instance.env       # AIWO_INSTANCE_TOKEN=... / DEEPSEEK_API_KEY=...
ExecStart=/usr/bin/node /opt/aiwo-instance/agent.mjs --name aiwo-remote-01
Restart=always
RestartSec=3
# 可选：限制影响范围
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now aiwo-instance
journalctl -u aiwo-instance -f
```

### launchd（macOS）

`~/Library/LaunchAgents/com.aiwo.instance.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aiwo.instance</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/opt/aiwo-instance/agent.mjs</string>
    <string>--base</string><string>https://aiwo.example.com</string>
    <string>--workspace</string><string>/Users/me/aiwo-workspace</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AIWO_INSTANCE_TOKEN</key><string>aiwo_ins_xxx</string>
    <key>DSH_HOME</key><string>/Users/me/.dsh</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/aiwo-instance.log</string>
  <key>StandardErrorPath</key><string>/tmp/aiwo-instance.err.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.aiwo.instance.plist
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 注册 401 / 心跳 401 | token 错误或已吊销：Aiwo 服务页重置 token 后重启代理 |
| claim 一直 204 | 共享调度池没有 queued 任务，或当前服务已有任务在跑（单任务串行） |
| 日志 `回退 headless` | `dsh --profile acp` 不可用：检查 `$DSH_HOME` 可写、`dsh --profile acp --help`、`npm install` 是否完成 |
| headless 报 `MISSING_CREDENTIAL` | 导出 `DEEPSEEK_API_KEY`，或确认 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` |
| ACP 权限请求 | 默认 `--permission allow` 自动选择 allow_once；需要人工审批时改为 `reject` 并在控制台观察失败 |
| 任务长时间无事件 | `--verbose` 查看 DSH stderr；确认 workspace 可写、模型凭据有效 |
| 任务超时 | 调整 `--task-timeout`（默认 30 分钟） |

## 测试

```bash
node test/smoke.mjs        # 8 个用例：提示词/claim/ACP/权限/回退/失败/SIGTERM
node --check agent.mjs && node --check lib/*.mjs
```

冒烟测试使用 mock Aiwo HTTP + `test/fixtures/fake-dsh.mjs`，不需要真实 DSH/Aiwo，也不会消耗模型额度。

## 安全

- 服务 token 只放在 `Authorization` 头，不写日志；建议用环境变量 / EnvironmentFile，避免进入 shell history。
- `$DSH_HOME/.credentials.yaml` 的 `DEEPSEEK_API_KEY` 只在环境变量缺失时读取并注入子进程，不打印。
- 代理不向 DSH 暴露文件系统/终端 ACP 能力（`clientCapabilities` 为 false），工具执行仍由 DSH 宿主自己负责。
- 建议以独立系统用户运行，workspace 只放任务相关代码。
