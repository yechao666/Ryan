/**
 * Ryan 助手唯一工具：通过 HTTP 调用 Ryan 开放 API。
 *
 * 不注册 bash、文件读写、搜索、web_fetch、subagent 等工具；
 * 认证 token 从 HIVE_AUTH_FILE 读取，不接受模型传入。
 */
import { readFile } from 'node:fs/promises';

export const name = 'aiwo-api-tool';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

async function authToken() {
  const file = process.env.HIVE_AUTH_FILE;
  if (!file) throw new Error('AIWO_AUTH_FILE_MISSING');
  return (await readFile(file, 'utf8')).trim();
}

function apiBase() {
  const value = process.env.AIWO_API_BASE;
  if (!value) throw new Error('AIWO_API_BASE_MISSING');
  return new URL(value);
}

export function apply(ctx) {
  ctx.inject(['tools'], (sctx) => {
    const tools = sctx.get('tools', false);
    if (!tools) return;
    tools.register({
      name: 'aiwo_api',
      description:
        '通过 HTTP 访问 Ryan 开放 API。只能访问当前 Ryan 服务的 /api 路径；不要尝试执行命令或读取文件。' +
        '先 GET /api/assistant/manifest 获取接口清单。',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'], description: 'HTTP method' },
          path: { type: 'string', description: 'Ryan API path starting with /api' },
          body: { type: 'object', description: 'JSON request body for POST/PATCH' },
        },
        required: ['method', 'path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const method = String(args.method ?? '').toUpperCase();
        if (!ALLOWED_METHODS.has(method)) throw new Error(`AIWO_METHOD_NOT_ALLOWED: ${method}`);
        const base = apiBase();
        const url = new URL(String(args.path ?? ''), base);
        if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) {
          throw new Error('AIWO_PATH_NOT_ALLOWED');
        }
        const token = await authToken();
        const headers = {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        };
        const init = { method, headers, signal: exec.signal };
        if (args.body !== undefined && method !== 'GET') {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(args.body);
        }
        const response = await fetch(url, init);
        const text = await response.text();
        let data = text;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          /* keep text */
        }
        if (!response.ok) {
          const message = data && typeof data === 'object' && data.error ? data.error.message : text;
          throw new Error(`AIWO_HTTP_${response.status}: ${String(message ?? '').slice(0, 500)}`);
        }
        return { status: response.status, data };
      },
    });
  });
}
