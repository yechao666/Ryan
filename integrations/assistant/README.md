# Aiwo 助手集成

## 安全边界

助手通过受限 DSH profile 启动，默认工具被禁用：

- `bash` / `pwsh` / `jobs`
- `read` / `write` / `edit` / 文件搜索
- `skill`
- `web_fetch` / `web_search`
- `subagent` / `workflow`
- `plugin_manager`
- `todo` / `goal`

唯一可用工具是 `aiwo_api`：

```text
aiwo_api({ method: "GET"|"POST"|"PATCH"|"DELETE", path: "/api/...", body?: object })
```

它只能访问当前 Aiwo 服务的同源 `/api/` 路径；认证 token 从 `HIVE_AUTH_FILE` 读取，模型不能传入或看到明文 token。

## API 契约

助手先调用：

```text
aiwo_api({ method: "GET", path: "/api/assistant/manifest" })
```

`/api/assistant/manifest` 是唯一 API 定义来源。助手不需要、也不应该读取 Aiwo 源码或数据库。

## 文件

- `aiwo-api-tool.mjs`：DSH 工具插件，注册唯一 `aiwo_api` 工具。
- `restricted.cordis.yml`：助手 profile patch，禁用默认工具并插入 `aiwo_api`。

## 运行

服务端 `assistant/runner.ts` 用以下 profile 参数启动：

```text
dsh --profile headless --patch integrations/assistant/restricted.cordis.yml --json
```

工作目录默认是 `~/.aiwo/assistant`，不是 Aiwo 源码目录；如需指定，使用 `AIWO_ASSISTANT_WORKSPACE`。
