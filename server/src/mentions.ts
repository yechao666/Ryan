/** 统一的 @ 提及解析：人员与智能体都是可提及对象。 */
import type { Db } from './db/index.ts';

export interface MentionTarget {
  kind: 'person' | 'agent';
  id: string;
  name: string;
  detail: string;
}

export interface ParsedMention extends MentionTarget {
  when: 'now' | 'completion';
}

export function listMentionTargets(db: Db): MentionTarget[] {
  const persons = db.prepare('SELECT id, name, title, email FROM persons ORDER BY name ASC').all() as unknown as Array<{
    id: string; name: string; title: string | null; email: string;
  }>;
  const agents = db.prepare("SELECT id, name, host, status, agent_type, capabilities FROM dsh_instances WHERE revoked_at IS NULL ORDER BY name ASC").all() as unknown as Array<{
    id: string; name: string; host: string; status: string; agent_type: string; capabilities: string;
  }>;
  return [
    ...persons.map((person) => ({
      kind: 'person' as const,
      id: person.id,
      name: person.name,
      detail: person.title || person.email,
    })),
    ...agents.map((agent) => {
      let capabilities: string[] = [];
      try {
        const parsed: unknown = JSON.parse(agent.capabilities || '[]');
        if (Array.isArray(parsed)) capabilities = parsed.filter((item): item is string => typeof item === 'string');
      } catch {
        capabilities = [];
      }
      return {
        kind: 'agent' as const,
        id: agent.id,
        name: agent.name,
        detail: [agent.agent_type.toUpperCase(), agent.host || '未设置主机', capabilities.join('/'), agent.status === 'online' ? '在线' : '离线'].filter(Boolean).join(' · '),
      };
    }),
  ];
}

function completionCue(text: string): boolean {
  return /(完成后|完成之后|结束后|结束之后|之后再|然后请|再请|接着请|随后请|交给|接力给|转给|最后由)/.test(text);
}

/**
 * 从自然语言中解析 @人员 / @智能体。
 * 名称按长度降序匹配，支持智能体名称里带空格和主机地址。
 */
export function parseMentions(db: Db, text: string): ParsedMention[] {
  if (!text.includes('@')) return [];
  const targets = listMentionTargets(db);
  const byId = new Map(targets.map((target) => [`${target.kind}:${target.id}`, target]));
  const ranges: Array<[number, number]> = [];
  const found: ParsedMention[] = [];

  // 新格式：[@姓名](mention://person/<id>)，选中后是一个完整的 Markdown 链接。
  const markdown = /\[@([^\]]+)\]\(mention:\/\/(person|agent)\/([^)]+)\)/g;
  for (const match of text.matchAll(markdown)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const target = byId.get(`${match[2]}:${decodeURIComponent(match[3] ?? '')}`);
    if (!target) continue;
    ranges.push([start, end]);
    const before = text.slice(0, start);
    const sentence = before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('；'), before.lastIndexOf(';')) + 1);
    found.push({ ...target, when: completionCue(sentence) ? 'completion' : 'now' });
  }

  const ordered = targets.sort((left, right) => right.name.length - left.name.length);
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue;
    if (ranges.some(([start, end]) => index >= start && index < end)) continue;
    const previous = index > 0 ? text[index - 1] : '';
    // 邮箱等普通文本里的 @ 不当提及。
    if (previous && /[A-Za-z0-9._%+-]/.test(previous)) continue;
    const rest = text.slice(index + 1);
    const target = ordered.find((candidate) => rest.startsWith(candidate.name));
    if (!target) continue;
    const before = text.slice(0, index);
    const sentence = before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('；'), before.lastIndexOf(';')) + 1);
    found.push({ ...target, when: completionCue(sentence) ? 'completion' : 'now' });
    index += target.name.length;
  }
  return found;
}
