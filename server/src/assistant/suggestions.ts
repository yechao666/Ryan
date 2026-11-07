/** 助手“下一步任务”推荐：基于当前页面/项目/任务上下文，由本机 DSH 生成。 */
import type { Db } from '../db/index.ts';
import { runDshText } from '../ai/dsh.ts';

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; items: string[]; source: 'ai' | 'fallback' }>();

export interface SuggestionInput {
  personName: string;
  pathname: string;
  projectId?: string;
  taskId?: string;
  context?: string;
}

export interface SuggestionResult {
  suggestions: string[];
  source: 'ai' | 'fallback';
}

function fallback(input: SuggestionInput): string[] {
  if (input.taskId) {
    return ['总结这个任务的执行结果', '基于这个任务创建后续任务', '检查相关服务是否在线'];
  }
  if (input.projectId) {
    return ['查看这个项目的任务进度', '为这个项目创建一个新任务', '整理项目记忆与决策'];
  }
  return ['创建一个新任务', '列出当前项目的 DSH 服务', '查看最近的任务执行情况'];
}

function cleanItems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/^[-*\d.\s]+/, '').replace(/^["'“”]+|["'“”]+$/g, '').trim())
    .filter((item) => item.length >= 2 && item.length <= 80))]
    .slice(0, 3);
}

function parseArray(text: string): string[] {
  const value = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = value.indexOf('[');
  const end = value.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    return cleanItems(JSON.parse(value.slice(start, end + 1)));
  } catch {
    return [];
  }
}

export async function generateSuggestions(db: Db, input: SuggestionInput): Promise<SuggestionResult> {
  const cacheKey = `${input.personName}|${input.pathname}|${input.projectId ?? ''}|${input.taskId ?? ''}|${(input.context ?? '').slice(-200)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { suggestions: cached.items, source: cached.source };
  }
  const project = input.projectId
    ? (db.prepare('SELECT name, description FROM projects WHERE id = ?').get(input.projectId) as unknown as { name: string; description: string } | undefined)
    : undefined;
  const task = input.taskId
    ? (db.prepare('SELECT title, status FROM work_items WHERE id = ?').get(input.taskId) as unknown as { title: string; status: string } | undefined)
    : undefined;
  const prompt = [
    '你是 Aiwo 的助手。请根据当前界面上下文，生成 3 条用户接下来可能让助手执行的中文任务建议。',
    '每条不超过 24 个中文字符，必须具体、可执行；不要解释，不要编号，不要 Markdown。',
    '只输出 JSON 字符串数组，例如 ["建议一","建议二","建议三"]。',
    '',
    `当前页面：${input.pathname}`,
    project ? `当前项目：${project.name}${project.description ? `（${project.description.slice(0, 200)}）` : ''}` : '当前不在项目内',
    task ? `当前任务：${task.title}（${task.status}）` : '',
    input.context ? `最近对话：${input.context.slice(-1200)}` : '',
  ].filter(Boolean).join('\n');
  const text = await runDshText({ prompt, timeoutMs: 12_000, maxChars: 4_000 });
  const generated = parseArray(text);
  const source: 'ai' | 'fallback' = generated.length >= 2 ? 'ai' : 'fallback';
  const items = (generated.length >= 2 ? generated : fallback(input)).slice(0, 3);
  cache.set(cacheKey, { at: Date.now(), items, source });
  return { suggestions: items, source };
}
