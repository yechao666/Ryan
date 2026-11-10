/**
 * Ryan 内置项目记忆：
 * - 记忆按 project_id 隔离，任务完成自动写回；
 * - 检索采用本地词项/中文二元组 + 时间衰减评分（无需外部服务）；
 * - context() 生成可直接注入 DSH 的项目记忆简报。
 */
import type { Db } from '../db/index.ts';
import type { MemoryBrief, MemoryContextResult, MemoryHit, MemorySearchResult } from '../../../shared/src/types.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { ProjectRow } from '../lib/access.ts';

export interface ProjectMemoryRow {
  id: string;
  project_id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  status: string;
  task_id: string | null;
  metadata: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddMemoryInput {
  projectId: string;
  content: string;
  title?: string;
  category?: string;
  source?: string;
  status?: 'durable' | 'candidate' | 'archived';
  taskId?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
}

const MAX_SCAN = 1_500;
const RECENT_DAYS = 30;

function rowOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
function rowsOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function memoryAgentIdForProject(project: Pick<ProjectRow, 'slug'>): string {
  return `aiwo_${project.slug.replace(/-/g, '_')}`;
}

export function memoryAgentIdOf(db: Db, projectId: string): string | null {
  const project = rowOf<{ slug: string }>(db, 'SELECT slug FROM projects WHERE id = ?', [projectId]);
  return project ? memoryAgentIdForProject(project) : null;
}

function mapHit(row: ProjectMemoryRow, score: number, signals: Record<string, number>, agentId: string): MemoryHit {
  const hit: MemoryHit = {
    id: row.id,
    content: row.content,
    score: Number(score.toFixed(4)),
    category: row.category,
    source: row.source,
    status: row.status as MemoryHit['status'],
    visibility: 'project',
    agentId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson(row.metadata),
    signals,
  };
  if (row.title) hit.title = row.title;
  if (row.task_id) hit.taskId = row.task_id;
  return hit;
}

/** 中文按二元组、英文按词切分；返回去重词项。 */
function queryTerms(query: string): string[] {
  const text = String(query ?? '').trim().toLowerCase();
  if (!text) return [];
  const terms = new Set<string>();
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) terms.add(run);
    else {
      terms.add(run);
      for (let i = 0; i < run.length - 1; i += 1) terms.add(run.slice(i, i + 2));
    }
  }
  for (const word of text.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) terms.add(word);
  return [...terms].filter((term) => term.length > 0).slice(0, 64);
}

function scoreMemory(row: ProjectMemoryRow, query: string, terms: string[]): { score: number; signals: Record<string, number> } {
  const content = `${row.title}\n${row.content}`.toLowerCase();
  let raw = 0;
  let matched = 0;
  const normalized = query.trim().toLowerCase();
  if (normalized && content.includes(normalized)) raw += 6;
  for (const term of terms) {
    if (content.includes(term)) {
      matched += 1;
      raw += term.length >= 2 ? 2 : 1;
      if (row.title.toLowerCase().includes(term)) raw += 1;
    }
  }
  const coverage = terms.length ? matched / terms.length : 0;
  raw += coverage * 4;
  const ageDays = Math.max(0, (Date.now() - new Date(row.created_at).getTime()) / 86_400_000);
  const recency = Math.max(0, 1 - ageDays / RECENT_DAYS);
  raw += recency * 1.5;
  const maxRaw = Math.max(1, terms.length * 3 + 8);
  const score = Math.min(1, raw / maxRaw);
  return { score, signals: { match: Number(coverage.toFixed(4)), recency: Number(recency.toFixed(4)) } };
}

export function searchMemories(
  db: Db,
  projectId: string,
  query: string,
  topK = 8,
  agentId = memoryAgentIdOf(db, projectId) ?? '',
): MemorySearchResult {
  const startedAt = Date.now();
  const rows = rowsOf<ProjectMemoryRow>(
    db,
    `SELECT * FROM project_memories WHERE project_id = ? AND status = 'durable' ORDER BY created_at DESC LIMIT ${MAX_SCAN}`,
    [projectId],
  );
  const terms = queryTerms(query);
  const scored = rows
    .map((row) => ({ row, ...scoreMemory(row, query, terms) }))
    .filter((item) => (query.trim() ? item.score > 0 : true))
    .sort((a, b) => b.score - a.score || b.row.created_at.localeCompare(a.row.created_at))
    .slice(0, Math.max(1, Math.min(50, topK)))
    .map((item) => mapHit(item.row, item.score, item.signals, agentId));
  return { hits: scored, tookMs: Date.now() - startedAt, configured: true };
}

export function buildMemoryContext(
  db: Db,
  projectId: string,
  query = '',
  budgetTokens = 1200,
  agentId = memoryAgentIdOf(db, projectId) ?? '',
): MemoryContextResult {
  const result = searchMemories(db, projectId, query, query ? 8 : 6, agentId);
  const lines: string[] = [];
  let chars = 0;
  const citations: string[] = [];
  const maxChars = Math.max(400, budgetTokens * 2);
  for (const hit of result.hits) {
    const line = `- [${hit.category}] ${hit.content.replace(/\s+/g, ' ').trim()}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    citations.push(hit.id);
    chars += line.length;
  }
  return {
    prompt: lines.length ? `# 项目记忆\n${lines.join('\n')}` : '',
    tokenEstimate: Math.ceil(chars / 2),
    citations,
    configured: true,
  };
}

export function listMemories(db: Db, projectId: string, limit = 50): MemoryHit[] {
  const agentId = memoryAgentIdOf(db, projectId) ?? '';
  return rowsOf<ProjectMemoryRow>(
    db,
    'SELECT * FROM project_memories WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    [projectId, Math.max(1, Math.min(200, limit))],
  ).map((row) => mapHit(row, 0, {}, agentId));
}

export function addMemory(db: Db, input: AddMemoryInput): MemoryHit {
  const project = rowOf<{ slug: string }>(db, 'SELECT slug FROM projects WHERE id = ?', [input.projectId]);
  if (!project) throw new Error('项目不存在');
  const agentId = memoryAgentIdForProject(project);
  const now = nowIso();
  if (input.taskId) {
    const existing = rowOf<ProjectMemoryRow>(
      db,
      'SELECT * FROM project_memories WHERE project_id = ? AND task_id = ?',
      [input.projectId, input.taskId],
    );
    if (existing) {
      db.prepare(
        `UPDATE project_memories SET category = ?, title = ?, content = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.category ?? existing.category,
        input.title ?? existing.title,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        now,
        existing.id,
      );
      const updated = rowOf<ProjectMemoryRow>(db, 'SELECT * FROM project_memories WHERE id = ?', [existing.id])!;
      return mapHit(updated, 1, { match: 1 }, agentId);
    }
  }
  const id = newId('mem');
  db.prepare(
    `INSERT INTO project_memories
       (id, project_id, category, title, content, source, status, task_id, metadata, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.category ?? 'fact',
    input.title ?? '',
    input.content,
    input.source ?? 'manual',
    input.status ?? 'durable',
    input.taskId ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.createdBy ?? null,
    now,
    now,
  );
  const row = rowOf<ProjectMemoryRow>(db, 'SELECT * FROM project_memories WHERE id = ?', [id]);
  if (!row) throw new Error('记忆写入失败');
  return mapHit(row, 1, { match: 1 }, agentId);
}

export function deleteMemory(db: Db, projectId: string, memoryId: string): boolean {
  const result = db.prepare('DELETE FROM project_memories WHERE id = ? AND project_id = ?').run(memoryId, projectId);
  return Number(result.changes) > 0;
}

export function getMemoryBriefMaxChars(db: Db, projectId: string): number {
  const row = rowOf<{ memory_brief_max_chars: number }>(db, 'SELECT memory_brief_max_chars FROM projects WHERE id = ?', [projectId]);
  const value = Number(row?.memory_brief_max_chars);
  return Number.isFinite(value) ? Math.max(100, Math.min(5000, value)) : 500;
}

export function setMemoryBriefMaxChars(db: Db, projectId: string, maxChars: number): number {
  const value = Math.max(100, Math.min(5000, Math.floor(maxChars)));
  db.prepare('UPDATE projects SET memory_brief_max_chars = ?, updated_at = ? WHERE id = ?').run(value, nowIso(), projectId);
  return value;
}

/** 仅取最近的持久记忆/洞见，生成有字数上限、可直接注入会话的简报。 */
export function buildMemoryBrief(db: Db, projectId: string, maxChars = 500): MemoryBrief {
  const limit = Math.max(100, Math.min(5000, maxChars));
  const agentId = memoryAgentIdOf(db, projectId) ?? '';
  const rows = rowsOf<ProjectMemoryRow>(
    db,
    `SELECT * FROM project_memories WHERE project_id = ? AND status = 'durable'
      ORDER BY updated_at DESC, created_at DESC LIMIT 30`,
    [projectId],
  );
  const header = '# 项目记忆简报（仅最近记忆/洞见）\n';
  let text = header;
  let count = 0;
  const recent: MemoryHit[] = [];
  for (const row of rows) {
    const content = row.content.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const title = row.title ? `${row.title}：` : '';
    const line = `- [${row.category}] ${title}${content}`;
    const remaining = limit - text.length;
    if (remaining <= 0) break;
    const clipped = line.length <= remaining ? line : `${line.slice(0, Math.max(0, remaining - 1))}…`;
    text += `${clipped}\n`;
    count += 1;
    recent.push(mapHit(row, 0, {}, agentId));
    if (text.length >= limit) break;
  }
  return { text: count ? text.trimEnd() : '', maxChars: limit, count, recent };
}

/** 任务完成后只沉淀显式决策/经验，不把普通任务结果写入项目记忆。 */
export function taskMemoryText(input: {
  decisions?: string[];
  progress?: string[];
  lessons?: string[];
}): string {
  const decisions = input.decisions ?? [];
  const progress = input.progress ?? [];
  const lessons = input.lessons ?? [];
  return [
    decisions.length ? `决策：${decisions.join('；')}` : '',
    progress.length ? `进展：${progress.join('；')}` : '',
    lessons.length ? `经验：${lessons.join('；')}` : '',
  ].filter(Boolean).join('\n');
}
