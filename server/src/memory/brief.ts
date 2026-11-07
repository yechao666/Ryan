/**
 * 记忆简报：只取最近的持久记忆/洞见，由本机 DSH 归纳成有字数上限的上下文。
 * 结果缓存到 memory_briefs；记忆或字数上限变化时自动失效。
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { MemoryBrief } from '../../../shared/src/types.ts';
import { buildMemoryBrief, getMemoryBriefMaxChars } from './store.ts';
import { runDshText } from '../ai/dsh.ts';
import { nowIso } from '../lib/ids.ts';

interface BriefCacheRow {
  project_id: string;
  text: string;
  max_chars: number;
  source_hash: string;
  generated_at: string;
}

const inFlight = new Map<string, Promise<MemoryBrief>>();

function rowOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function hashBrief(brief: MemoryBrief): string {
  const source = [
    String(brief.maxChars),
    ...brief.recent.map((hit) => `${hit.id}:${hit.updatedAt ?? hit.createdAt}:${hit.content.length}`),
  ].join('|');
  return createHash('sha256').update(source).digest('hex');
}

function cached(db: Db, projectId: string): BriefCacheRow | undefined {
  return rowOf<BriefCacheRow>(db, 'SELECT * FROM memory_briefs WHERE project_id = ?', [projectId]);
}

function toBrief(row: BriefCacheRow, recent: MemoryBrief['recent']): MemoryBrief {
  return {
    text: row.text,
    maxChars: row.max_chars,
    count: recent.length,
    recent,
  };
}

function saveCache(db: Db, projectId: string, text: string, maxChars: number, sourceHash: string): void {
  db.prepare(
    `INSERT INTO memory_briefs (project_id, text, max_chars, source_hash, generated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, max_chars = excluded.max_chars,
       source_hash = excluded.source_hash, generated_at = excluded.generated_at`,
  ).run(projectId, text, maxChars, sourceHash, nowIso());
}

function clip(text: string, maxChars: number): string {
  const value = String(text ?? '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

async function generate(db: Db, projectId: string, maxChars: number, fallback: MemoryBrief): Promise<MemoryBrief> {
  if (fallback.count === 0) {
    saveCache(db, projectId, '', maxChars, hashBrief(fallback));
    return fallback;
  }
  const prompt = [
    `你是 Aiwo 的项目记忆整理器。请把下面的最近项目记忆/洞见整理成一段不超过 ${maxChars} 个字符的中文记忆简报。`,
    '只保留跨任务可复用的决策、约定、领域事实、架构关系、踩坑、流程；删去任务流水、重复内容和一次性细节。',
    '直接输出简报正文，不要标题、不要 Markdown 代码块、不要解释，不要调用工具。',
    '',
    '最近记忆/洞见：',
    fallback.text.slice(0, 12_000),
  ].join('\n');
  const generated = clip(await runDshText({ prompt, timeoutMs: 20_000, maxChars: maxChars + 200 }), maxChars);
  const text = generated || fallback.text;
  saveCache(db, projectId, text, maxChars, hashBrief(fallback));
  return { text, maxChars, count: fallback.count, recent: fallback.recent };
}

/** 获取（必要时用本机 DSH 生成）记忆简报；同项目请求去重。 */
export async function ensureMemoryBrief(db: Db, projectId: string, force = false): Promise<MemoryBrief> {
  const key = `${projectId}:${force ? 'force' : 'cached'}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = (async () => {
    const maxChars = getMemoryBriefMaxChars(db, projectId);
    const fallback = buildMemoryBrief(db, projectId, maxChars);
    const sourceHash = hashBrief(fallback);
    const cachedRow = cached(db, projectId);
    if (!force && cachedRow && cachedRow.source_hash === sourceHash && cachedRow.max_chars === maxChars) {
      return toBrief(cachedRow, fallback.recent);
    }
    return generate(db, projectId, maxChars, fallback);
  })();
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
