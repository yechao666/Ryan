/**
 * Ryan 任务记忆工具（注入任务执行 DSH）。
 *
 * 工具只能访问当前服务正在执行的任务所属项目：
 * - aiwo_memory_search
 * - aiwo_memory_context
 * - aiwo_memory_add
 *
 * 服务 token 从 HIVE_AUTH_FILE 读取，模型无法指定项目或任意任务。
 */
import { readFile } from 'node:fs/promises';

export const name = 'aiwo-memory-tools';

function baseUrl() {
  const value = process.env.AIWO_API_BASE;
  if (!value) throw new Error('AIWO_API_BASE_MISSING');
  return new URL(value);
}

async function token() {
  const file = process.env.HIVE_AUTH_FILE;
  if (!file) throw new Error('AIWO_AUTH_FILE_MISSING');
  return (await readFile(file, 'utf8')).trim();
}

async function request(method, path, body) {
  const base = baseUrl();
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('AIWO_PATH_NOT_ALLOWED');
  const headers = {
    authorization: `Bearer ${await token()}`,
    accept: 'application/json',
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (response.status === 204) return { task: null };
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!response.ok) {
    const message = data && typeof data === 'object' && data.error ? data.error.message : text;
    throw new Error(`AIWO_HTTP_${response.status}: ${String(message ?? '').slice(0, 400)}`);
  }
  return data;
}

async function currentTask() {
  const data = await request('GET', '/api/runtime/tasks/current');
  if (!data || !data.taskId) throw new Error('当前没有正在执行的任务');
  return data.taskId;
}

function textOutput(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

const toolDefinitions = [
  {
    name: 'aiwo_memory_search',
    description: '检索当前任务所属项目的持久项目记忆。返回相关记忆及分数；候选/归档记忆不会命中。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题' },
        topK: { type: 'number', description: '最多返回条数，默认 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const taskId = await currentTask();
      const topK = Number.isFinite(args.topK) ? Math.max(1, Math.min(20, Number(args.topK))) : 8;
      const data = await request('POST', `/api/runtime/tasks/${taskId}/memory/search`, {
        query: String(args.query ?? ''),
        topK,
      });
      return data;
    },
  },
  {
    name: 'aiwo_memory_context',
    description: '获取当前任务所属项目的记忆上下文简报，可直接用于理解项目约定。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：让简报更聚焦的任务主题' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const taskId = await currentTask();
      const query = typeof args.query === 'string' ? args.query : '';
      const data = await request('GET', `/api/runtime/tasks/${taskId}/memory/context?query=${encodeURIComponent(query)}`);
      return data;
    },
  },
  {
    name: 'aiwo_memory_add',
    description: '向当前任务所属项目写入一条候选记忆，经做梦提升为持久知识。仅用于跨任务可复用的决策/约定/领域事实/架构/踩坑/流程；不要写任务摘要、状态、日志、逐文件改动、临时调试或未验证猜测。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆正文' },
        title: { type: 'string', description: '可选标题' },
        category: { type: 'string', enum: ['fact', 'decision', 'lesson', 'note'], description: '记忆类型：事实/决策/经验/笔记' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    async execute(args) {
      const taskId = await currentTask();
      const data = await request('POST', `/api/runtime/tasks/${taskId}/memory/add`, {
        content: String(args.content ?? ''),
        title: typeof args.title === 'string' ? args.title : undefined,
        category: typeof args.category === 'string' ? args.category : 'note',
      });
      return data;
    },
  },
];

export function apply(ctx) {
  ctx.inject(['tools'], (sctx) => {
    const tools = sctx.get('tools', false);
    if (!tools) return;
    for (const definition of toolDefinitions) {
      tools.register({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: {
          schema: { type: 'object' },
          render: (_args, value) => textOutput(value),
        },
        execute: definition.execute,
      });
    }
  });
}
