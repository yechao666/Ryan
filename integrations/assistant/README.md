# Aiwo DSH 助手

全局助手运行在真实的 DSH headless 实例中，不再依赖本地意图解析：

- 前端 `POST /api/assistant/chat`，附带当前人员 token、当前页面/项目上下文。
- Aiwo 后端启动 `dsh --profile headless --json -`，复用同一人员的 DSH session。
- 子进程通过 `HIVE_AUTH_FILE` 读取一次性 token 文件；token 不写入提示词。
- 助手通过 `GET /api/assistant/manifest` 获取稳定 API 清单，通过 `integrations/assistant/aiwo-api.mjs` 调用开放 API；不需要读取 Aiwo 源码。
- 写操作直接执行；最终回复可带 `HIVE_NAVIGATE: /path`，前端自动跳转并刷新当前页面。
- 本地意图解析仅作为 DSH 不可用时的降级。

## 环境

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIVE_DSH_BIN` | `dsh` | DSH CLI 路径 |
| `HIVE_DSH_HOME` / `DSH_HOME` | `~/.dsh` | DSH home |
| `HIVE_DSH_PROFILE` | `headless` | headless profile |
| `HIVE_DSH_WORKSPACE` | Aiwo 仓库 | 助手工作目录 |
| `AIWO_API_BASE` | `http://host:port` | 助手调用 API 的地址 |
| `DEEPSEEK_API_KEY` | 读 `$DSH_HOME/.credentials.yaml` | 模型密钥 |

## 调用示例

```bash
node integrations/assistant/aiwo-api.mjs GET /api/projects
node integrations/assistant/aiwo-api.mjs POST /api/projects/prj_xxx/tasks \
  '{"agentId":"agt_xxx","title":"...","prompt":"...","type":"feature"}'
```

助手提示词要求先读取 `docs/api.md`，不要修改源码/数据库；权限沿用当前人员。
