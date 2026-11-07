/**
 * 项目记忆“做梦”：增量记忆巩固。
 *
 * 只处理 dreamed_at 为空的新记忆，归纳为高层洞见（category=insight），
 * 然后把这些新记忆标记为已做梦；不重放旧记忆，也不执行任务。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import type {
  MemoryDreamRun,
  MemoryDreamSettings,
  MemoryDreamStatus,
  MemoryHit,
} from '../../../shared/src/types.ts';
import { addMemory, memoryAgentIdOf } from './store.ts';
import { newId, nowIso } from '../lib/ids.ts';

const MAX_BATCH = 50;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60 * 24 * 30;
const runningProjects = new Set<string>();

interface DreamRunRow {
  id: string;
  project_id: string;
  trigger: string;
  status: string;
  input_count: number;
  insight_count: number;
  summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface NewMemoryRow {
  id: string;
  title: string;
  content: string;
  category: string;
  created_at: string;
}

interface ProjectDreamRow {
  id: string;
  slug: string;
  memory_dream_enabled: number;
  memory_dream_interval_minutes: number;
  memory_dream_last_at: string | null;
}

function rowOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
function rowsOf<T>(db: Db, sql: string, params: (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function mapRun(row: DreamRunRow): MemoryDreamRun {
  const run: MemoryDreamRun = {
    id: row.id,
    projectId: row.project_id,
    trigger: row.trigger as MemoryDreamRun['trigger'],
    status: row.status as MemoryDreamRun['status'],
    inputCount: row.input_count,
    insightCount: row.insight_count,
    startedAt: row.started_at,
  };
  if (row.summary) run.summary = row.summary;
  if (row.error) run.error = row.error;
  if (row.finished_at) run.finishedAt = row.finished_at;
  return run;
}

export function getDreamSettings(db: Db, projectId: string): MemoryDreamSettings {
  const row = rowOf<ProjectDreamRow>(
    db,
    'SELECT id, slug, memory_dream_enabled, memory_dream_interval_minutes, memory_dream_last_at FROM projects WHERE id = ?',
    [projectId],
  );
  if (!row) return { enabled: true, intervalMinutes: 1440 };
  const settings: MemoryDreamSettings = {
    enabled: Boolean(row.memory_dream_enabled),
    intervalMinutes: Number(row.memory_dream_interval_minutes) || 1440,
  };
  if (row.memory_dream_last_at) settings.lastAt = row.memory_dream_last_at;
  return settings;
}

export function updateDreamSettings(
  db: Db,
  projectId: string,
  input: { enabled?: boolean; intervalMinutes?: number },
): MemoryDreamSettings {
  const current = getDreamSettings(db, projectId);
  const enabled = input.enabled ?? current.enabled;
  const interval = input.intervalMinutes ?? current.intervalMinutes;
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES) {
    throw new Error(`做梦间隔必须在 ${MIN_INTERVAL_MINUTES} 到 ${MAX_INTERVAL_MINUTES} 分钟之间`);
  }
  db.prepare('UPDATE projects SET memory_dream_enabled = ?, memory_dream_interval_minutes = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Math.floor(interval), nowIso(), projectId);
  return getDreamSettings(db, projectId);
}

export function pendingMemoryCount(db: Db, projectId: string): number {
  const row = rowOf<{ c: number }>(
    db,
    'SELECT COUNT(*) AS c FROM project_memories WHERE project_id = ? AND status = \'candidate\' AND dreamed_at IS NULL',
    [projectId],
  );
  return Number(row?.c ?? 0);
}

export function getDreamStatus(db: Db, projectId: string): MemoryDreamStatus {
  const runs = rowsOf<DreamRunRow>(
    db,
    'SELECT * FROM memory_dream_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 10',
    [projectId],
  ).map(mapRun);
  return {
    settings: getDreamSettings(db, projectId),
    pendingCount: pendingMemoryCount(db, projectId),
    ...(runs[0] ? { lastRun: runs[0] } : {}),
    runs,
  };
}

function cleanJson(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function insightLines(rows: NewMemoryRow[]): string {
  return rows.map((row) => {
    const title = row.title ? `${row.title}：` : '';
    return `- [${row.category}] ${title}${row.content.replace(/\s+/g, ' ').trim()}`;
  }).join('\n');
}

function fallbackInsights(rows: NewMemoryRow[]): { title: string; content: string }[] {
  const meaningful = rows.filter((row) => ['decision', 'lesson', 'fact', 'note'].includes(row.category) && row.content.trim().length >= 10);
  if (meaningful.length === 0) return [];
  return [{
    title: `记忆整理 · ${new Date().toLocaleDateString('zh-CN')}`,
    content: insightLines(meaningful).slice(0, 4_000),
  }];
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/[，。！？；：、,.!?;:]/g, '');
}

function duplicateOf(db: Db, projectId: string, content: string): boolean {
  const target = normalized(content);
  if (!target) return true;
  const rows = rowsOf<{ content: string }>(
    db,
    "SELECT content FROM project_memories WHERE project_id = ? AND status = 'durable' ORDER BY updated_at DESC LIMIT 200",
    [projectId],
  );
  return rows.some((row) => {
    const existing = normalized(row.content);
    if (!existing) return false;
    if (existing === target) return true;
    const shorter = existing.length < target.length ? existing : target;
    const longer = existing.length < target.length ? target : existing;
    return shorter.length >= 20 && longer.includes(shorter) && shorter.length / longer.length >= 0.8;
  });
}

async function deepseekKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const yaml = await readFile(join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8');
    const match = yaml.match(/DEEPSEEK_API_KEY:\s*["']?([^\s"']+)/);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

/** 让 DSH 归纳这批新记忆；失败时回退为确定性摘要。 */
async function synthesize(
  db: Db,
  projectId: string,
  rows: NewMemoryRow[],
): Promise<{ summary: string; insights: { title: string; content: string }[] }> {
  const fallback = fallbackInsights(rows);
  if (process.env.AIWO_DREAM_AI === '0') {
    return { summary: `已整理 ${rows.length} 条新记忆`, insights: fallback };
  }
  const key = await deepseekKey();
  if (!key) return { summary: `已整理 ${rows.length} 条新记忆`, insights: fallback };
  const dir = await mkdtemp(join(tmpdir(), 'aiwo-dream-'));
  const child = spawn(process.env.HIVE_DSH_BIN || 'dsh', ['--profile', 'headless', '--json', '-'], {
    cwd: dir,
    env: {
      ...process.env,
      DSH_HOME: process.env.DSH_HOME || join(homedir(), '.dsh'),
      DEEPSEEK_API_KEY: key,
      DSH_HIVE_RUNTIME_DISABLED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let finalText = '';
  let text = '';
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; text?: string };
        if (event.type === 'text' && event.text) text = event.text;
        if (event.type === 'final' && event.text) finalText = event.text;
      } catch { /* ignore */ }
    }
  });
  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
  }, 25_000);
  timeout.unref?.();
  try {
    child.stdin.end([
      '你在做项目记忆巩固（“做梦”）。只根据给定新记忆，归纳可复用的高层洞见。',
      '不要调用工具，不要编造未出现的事实。合并重复、指出决策与经验。',
      '只输出 JSON，格式：',
      '{"summary":"一句话总结","insights":[{"title":"短标题","content":"洞见正文"}]}',
      '最多 5 条 insights。没有跨任务可复用的有效洞见时，返回空数组 []，不要为了凑数生成泛泛总结。',
      '',
      `项目：${projectId}`,
      '新记忆：',
      insightLines(rows).slice(0, 30_000),
    ].join('\n'));
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    const parsed = JSON.parse(cleanJson(finalText || text)) as {
      summary?: unknown;
      insights?: unknown;
    };
    const insights = Array.isArray(parsed.insights)
      ? parsed.insights
          .filter((item): item is { title?: unknown; content?: unknown } => Boolean(item && typeof item === 'object'))
          .map((item) => ({
            title: typeof item.title === 'string' ? item.title.slice(0, 200) : '记忆洞见',
            content: typeof item.content === 'string' ? item.content.trim() : '',
          }))
          .filter((item) => item.content)
          .slice(0, 5)
      : [];
    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : `已整理 ${rows.length} 条新记忆`,
      insights,
    };
  } catch {
    return { summary: `已整理 ${rows.length} 条新记忆`, insights: fallback };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
}

/** 执行一次增量做梦；同一项目不会并发。 */
export async function runDream(
  db: Db,
  projectId: string,
  trigger: 'schedule' | 'manual' = 'manual',
): Promise<MemoryDreamRun | null> {
  if (runningProjects.has(projectId)) return null;
  runningProjects.add(projectId);
  const runId = newId('dream');
  const startedAt = nowIso();
  db.prepare(
    'INSERT INTO memory_dream_runs (id, project_id, trigger, status, input_count, insight_count, started_at) VALUES (?, ?, ?, \'running\', 0, 0, ?)',
  ).run(runId, projectId, trigger, startedAt);
  try {
    const rows = rowsOf<NewMemoryRow>(
      db,
      `SELECT id, title, content, category, created_at FROM project_memories
        WHERE project_id = ? AND status = 'candidate' AND dreamed_at IS NULL ORDER BY created_at ASC LIMIT ?`,
      [projectId, MAX_BATCH],
    );
    if (rows.length === 0) {
      const finishedAt = nowIso();
      db.prepare("UPDATE memory_dream_runs SET status = 'skipped', summary = ?, finished_at = ? WHERE id = ?")
        .run('没有需要整理的新记忆', finishedAt, runId);
      db.prepare('UPDATE projects SET memory_dream_last_at = ?, updated_at = ? WHERE id = ?')
        .run(finishedAt, finishedAt, projectId);
      return mapRun(rowOf<DreamRunRow>(db, 'SELECT * FROM memory_dream_runs WHERE id = ?', [runId])!);
    }
    const { summary, insights } = await synthesize(db, projectId, rows);
    const now = nowIso();
    let insightCount = 0;
    for (const insight of insights) {
      const content = insight.content.trim();
      if (content.length < 20 || /^(?:没有|暂无|本批没有|无有效)/.test(content)) continue;
      if (duplicateOf(db, projectId, content)) continue;
      const memory = addMemory(db, {
        projectId,
        title: insight.title,
        content: insight.content,
        category: 'insight',
        source: 'dream',
        metadata: { dreamRunId: runId, sourceMemoryIds: rows.map((row) => row.id) },
      });
      db.prepare('UPDATE project_memories SET dreamed_at = ? WHERE id = ?').run(now, memory.id);
      insightCount += 1;
    }
    const marks = rows.map(() => '?').join(', ');
    db.prepare(`UPDATE project_memories SET dreamed_at = ?, status = 'archived' WHERE id IN (${marks})`).run(now, ...rows.map((row) => row.id));
    db.prepare('UPDATE projects SET memory_dream_last_at = ?, updated_at = ? WHERE id = ?').run(now, now, projectId);
    db.prepare("UPDATE memory_dream_runs SET status = 'completed', input_count = ?, insight_count = ?, summary = ?, finished_at = ? WHERE id = ?")
      .run(rows.length, insightCount, insightCount > 0 ? summary : '本批没有形成有效洞见', now, runId);
    return mapRun(rowOf<DreamRunRow>(db, 'SELECT * FROM memory_dream_runs WHERE id = ?', [runId])!);
  } catch (error) {
    const finishedAt = nowIso();
    db.prepare("UPDATE memory_dream_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(error instanceof Error ? error.message : String(error), finishedAt, runId);
    if (trigger === 'manual') throw error;
    return mapRun(rowOf<DreamRunRow>(db, 'SELECT * FROM memory_dream_runs WHERE id = ?', [runId])!);
  } finally {
    runningProjects.delete(projectId);
  }
}

/** 供调度器使用：按项目间隔判断是否到期。 */
export function dueDreamProjects(db: Db, now = new Date()): string[] {
  const rows = rowsOf<ProjectDreamRow>(
    db,
    `SELECT p.id, p.slug, p.memory_dream_enabled, p.memory_dream_interval_minutes, p.memory_dream_last_at
       FROM projects p WHERE p.memory_dream_enabled = 1
       AND EXISTS (SELECT 1 FROM project_memories m WHERE m.project_id = p.id AND m.status = 'candidate' AND m.dreamed_at IS NULL)`,
  );
  return rows
    .filter((row) => {
      if (!row.memory_dream_last_at) return true;
      const last = new Date(row.memory_dream_last_at).getTime();
      if (!Number.isFinite(last)) return true;
      return now.getTime() - last >= Math.max(MIN_INTERVAL_MINUTES, Number(row.memory_dream_interval_minutes) || 1440) * 60_000;
    })
    .map((row) => row.id);
}
