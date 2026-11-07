/**
 * 命令行 / 环境变量解析。
 *
 * 优先级：CLI 参数 > 环境变量 > 默认值。
 * 只做纯配置解析（不启动任何进程），便于测试与 --help。
 */
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
export const MEMORY_TOOL_PATCH = path.join(here, '..', 'aiwo-memory-tools.cordis.yml');

export const PLUGIN_VERSION = pkg.version ?? '0.0.0';
export const DEFAULT_BASE = 'http://127.0.0.1:4500';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseIntStrict(value, label) {
  const num = Number(value);
  if (!Number.isInteger(num)) throw new ConfigError(`${label} 必须是整数：${value}`);
  return num;
}

function parseBool(value) {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function normalizeBase(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`--base 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('--base 只支持 http/https');
  }
  return value;
}

function readCli(argv) {
  const out = { _: [] };
  const takesValue = new Set([
    'base',
    'token',
    'workspace',
    'workspace-root',
    'dsh-bin',
    'profile',
    'headless-profile',
    'name',
    'host',
    'kind',
    'port',
    'heartbeat',
    'poll',
    'lease-renew',
    'task-timeout',
    'acp-init-timeout',
    'dsh-home',
    'permission',
  ]);
  const booleans = new Set([
    'force-headless',
    'no-acp',
    'once',
    'verbose',
    'no-credentials',
    'help',
    'version',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (booleans.has(key)) {
      if (eq >= 0) throw new ConfigError(`--${key} 不接受取值`);
      out[key] = true;
      continue;
    }
    if (!takesValue.has(key)) throw new ConfigError(`未知参数：--${key}`);
    let value;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ConfigError(`--${key} 需要一个值`);
      i += 1;
    }
    out[key] = value;
  }
  return out;
}

export function usage() {
  return `Ryan DSH 服务代理 v${PLUGIN_VERSION}

用法：
  node agent.mjs --base <Ryan URL> --token <服务 token> [options]

必填：
  --base <url>              Ryan 服务地址（默认 http://127.0.0.1:4500）
  --token <token>           Ryan 服务 token（aiwo_ins_...；管理端创建）
  --workspace <dir>         无项目时的回退工作区（默认当前目录）
  --workspace-root <dir>    按项目 ID 自动生成工作区的根目录
                            （默认 ~/.aiwo/workspaces，目录为 projects/<projectId>）

DSH：
  --dsh-bin <path>          dsh 可执行文件（默认 dsh）
  --profile <name>          ACP profile（默认 acp）
  --headless-profile <name> ACP 不可用时的回退 profile（默认 headless）
  --dsh-home <dir>          DSH_HOME（默认继承环境变量 / ~/.dsh）
  --force-headless, --no-acp  跳过 ACP，直接用 headless
  --acp-init-timeout <ms>   ACP initialize 超时（默认 30000）
  --permission <allow|reject>  ACP 权限请求处理（默认 allow）
  --no-credentials          不从未设置的环境变量读取 ~/.dsh 凭据（headless 用）

服务 / 任务：
  --name <name>             服务名（默认主机名）
  --host <host>             主机名（默认主机名）
  --kind <local|remote>     服务类型（默认沿用服务端配置）
  --port <port>             服务端口（可选）
  --heartbeat <ms>          心跳间隔（默认 20000，最小 200）
  --poll <ms>               claim 轮询（默认 5000，最小 100）
  --lease-renew <ms>        任务运行中续租间隔（默认 90000，0 关闭）
  --task-timeout <ms>       单任务超时（默认 1800000，0 关闭）
  --once                    执行完一个任务后退出（联调 / 测试）
  --verbose                 输出调试日志
  -h, --help                显示帮助
  -V, --version             显示版本

常用环境变量：
  AIWO_BASE_URL / AIWO_INSTANCE_TOKEN（或 AIWO_TOKEN） / AIWO_WORKSPACE
  AIWO_WORKSPACE_ROOT（默认 ~/.aiwo/workspaces）
  AIWO_DSH_BIN / AIWO_DSH_PROFILE / AIWO_HEADLESS_PROFILE / DSH_HOME
  AIWO_INSTANCE_NAME / AIWO_INSTANCE_HOST / AIWO_HEARTBEAT_MS / AIWO_POLL_MS
  AIWO_LEASE_RENEW_MS / AIWO_TASK_TIMEOUT_MS / AIWO_ACP_PERMISSION
  AIWO_FORCE_HEADLESS=1 / AIWO_ONCE=1 / AIWO_VERBOSE=1

示例：
  node agent.mjs --base http://127.0.0.1:4500 --token aiwo_ins_xxx \\
    --workspace-root /srv/aiwo-workspaces --name aiwo-remote-01
`;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function parseConfig(argv, env = process.env) {
  const cli = readCli(argv);
  if (cli.help) return { action: 'help' };
  if (cli.version) return { action: 'version' };

  const token = cli.token ?? env.AIWO_INSTANCE_TOKEN ?? env.AIWO_TOKEN ?? '';
  if (!token) throw new ConfigError('缺少服务 token：请传 --token 或设置 AIWO_INSTANCE_TOKEN');
  if (cli._.length > 0) throw new ConfigError(`不支持的位置参数：${cli._.join(' ')}`);

  const base = normalizeBase(cli.base ?? env.AIWO_BASE_URL ?? DEFAULT_BASE);
  const workspace = path.resolve(cli.workspace ?? env.AIWO_WORKSPACE ?? process.cwd());
  const workspaceRoot = path.resolve(
    cli['workspace-root'] ?? env.AIWO_WORKSPACE_ROOT ?? path.join(os.homedir(), '.aiwo', 'workspaces'),
  );

  const heartbeatMs = cli.heartbeat !== undefined
    ? parseIntStrict(cli.heartbeat, '--heartbeat')
    : env.AIWO_HEARTBEAT_MS
      ? parseIntStrict(env.AIWO_HEARTBEAT_MS, 'AIWO_HEARTBEAT_MS')
      : 20_000;
  if (heartbeatMs < 200) throw new ConfigError('--heartbeat 不能小于 200ms');

  const pollMs = cli.poll !== undefined
    ? parseIntStrict(cli.poll, '--poll')
    : env.AIWO_POLL_MS
      ? parseIntStrict(env.AIWO_POLL_MS, 'AIWO_POLL_MS')
      : 5_000;
  if (pollMs < 100) throw new ConfigError('--poll 不能小于 100ms');

  const leaseRenewMs = cli['lease-renew'] !== undefined
    ? parseIntStrict(cli['lease-renew'], '--lease-renew')
    : env.AIWO_LEASE_RENEW_MS
      ? parseIntStrict(env.AIWO_LEASE_RENEW_MS, 'AIWO_LEASE_RENEW_MS')
      : 90_000;
  if (leaseRenewMs !== 0 && leaseRenewMs < 5_000) throw new ConfigError('--lease-renew 不能小于 5000ms（或传 0 关闭）');

  const taskTimeoutMs = cli['task-timeout'] !== undefined
    ? parseIntStrict(cli['task-timeout'], '--task-timeout')
    : env.AIWO_TASK_TIMEOUT_MS
      ? parseIntStrict(env.AIWO_TASK_TIMEOUT_MS, 'AIWO_TASK_TIMEOUT_MS')
      : 30 * 60_000;
  if (taskTimeoutMs < 0) throw new ConfigError('--task-timeout 不能为负数');

  const acpInitTimeoutMs = cli['acp-init-timeout'] !== undefined
    ? parseIntStrict(cli['acp-init-timeout'], '--acp-init-timeout')
    : env.AIWO_ACP_INIT_TIMEOUT_MS
      ? parseIntStrict(env.AIWO_ACP_INIT_TIMEOUT_MS, 'AIWO_ACP_INIT_TIMEOUT_MS')
      : 30_000;
  if (acpInitTimeoutMs < 200) throw new ConfigError('--acp-init-timeout 不能小于 200ms');

  const permission = cli.permission ?? env.AIWO_ACP_PERMISSION ?? 'allow';
  if (permission !== 'allow' && permission !== 'reject') {
    throw new ConfigError('--permission 只能是 allow 或 reject');
  }

  const kind = cli.kind ?? env.AIWO_INSTANCE_KIND;
  if (kind !== undefined && kind !== 'local' && kind !== 'remote') {
    throw new ConfigError('--kind 只能是 local 或 remote');
  }

  let port;
  if (cli.port !== undefined) port = parseIntStrict(cli.port, '--port');
  else if (env.AIWO_INSTANCE_PORT) port = parseIntStrict(env.AIWO_INSTANCE_PORT, 'AIWO_INSTANCE_PORT');
  if (port !== undefined && (port < 1 || port > 65535)) throw new ConfigError('--port 必须在 1..65535');

  const forceHeadless = Boolean(cli['force-headless'] || cli['no-acp'] || parseBool(env.AIWO_FORCE_HEADLESS ?? ''));
  const once = Boolean(cli.once || parseBool(env.AIWO_ONCE ?? ''));
  const verbose = Boolean(cli.verbose || parseBool(env.AIWO_VERBOSE ?? ''));
  const credentials = !Boolean(cli['no-credentials'] || parseBool(env.AIWO_DISABLE_CREDENTIALS ?? ''));

  const dshHome = cli['dsh-home'] ?? env.DSH_HOME ?? '';

  return {
    action: 'run',
    base,
    token,
    workspace,
    workspaceRoot,
    dshBin: cli['dsh-bin'] ?? env.AIWO_DSH_BIN ?? 'dsh',
    profile: cli.profile ?? env.AIWO_DSH_PROFILE ?? 'acp',
    headlessProfile: cli['headless-profile'] ?? env.AIWO_HEADLESS_PROFILE ?? 'headless',
    memoryToolPatch: env.AIWO_MEMORY_TOOL_PATCH || MEMORY_TOOL_PATCH,
    dshHome,
    name: cli.name ?? env.AIWO_INSTANCE_NAME ?? os.hostname(),
    host: cli.host ?? env.AIWO_INSTANCE_HOST ?? os.hostname(),
    kind,
    port,
    heartbeatMs,
    pollMs,
    leaseRenewMs,
    taskTimeoutMs,
    acpInitTimeoutMs,
    permission,
    forceHeadless,
    once,
    verbose,
    credentials,
    pluginVersion: PLUGIN_VERSION,
  };
}
