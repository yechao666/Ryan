import { useMemo, type ReactNode } from 'react';
import { GenuiActionContext, GenuiBlock, processGenuiSpec } from '@changfenhuang/dsh-genui/embed';

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={key}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      if (link[2].startsWith('mention://')) {
        return <span className="mention-ref" key={key} title={link[2]}>{link[1]}</span>;
      }
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function isSpecial(line: string): boolean {
  return (
    !line.trim() ||
    line.startsWith('```') ||
    /^(#{1,4})\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(-{3,}|\*{3,})\s*$/.test(line)
  );
}

/**
 * GenUI 的 submit.groups 由模型生成，经常把“可选”字段也列为必填，导致按钮永久禁用。
 * 这里做一层无损展示归一化：有明确“必填”标记时只保留必填项；没有标记时保留输入框/文本域和第一个下拉框。
 */
function normalizeSubmitGroups(value: unknown): unknown {
  const root = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : value;
  const byKey = new Map<string, Record<string, unknown>>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const key = typeof record.id === 'string' ? record.id : typeof record.group === 'string' ? record.group : '';
    if (key) byKey.set(key, record);
    for (const child of Object.values(record)) walk(child);
  };
  walk(root);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === 'submit' && Array.isArray(record.groups)) {
      const groups = record.groups.filter((group): group is string => typeof group === 'string');
      const nodes = groups.map((group) => byKey.get(group)).filter(Boolean) as Record<string, unknown>[];
      const required = nodes.filter((item) => typeof item.label === 'string' && item.label.includes('必填'));
      let nextGroups = groups;
      if (required.length > 0) {
        const requiredKeys = new Set(nodes.filter((item) => typeof item.label === 'string' && item.label.includes('必填')).map((item) => String(item.id ?? item.group)));
        nextGroups = groups.filter((group) => requiredKeys.has(group));
      } else {
        const firstSelect = nodes.find((item) => item.type === 'select');
        const keep = new Set<string>();
        for (const item of nodes) {
          const key = String(item.id ?? item.group ?? '');
          if (item.type === 'input' || item.type === 'textarea' || item === firstSelect) keep.add(key);
        }
        if (keep.size > 0) nextGroups = groups.filter((group) => keep.has(group));
      }
      if (nextGroups.length > 0) record.groups = nextGroups;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(root);
  return root;
}

/** 把 dsh-ui 围栏解析为 dsh-genui 的声明式组件；无效围栏保留为代码块。 */
function GenuiFence({ code, fenceKey }: { code: string; fenceKey: string }) {
  const processed = useMemo(() => {
    try {
      return processGenuiSpec(normalizeSubmitGroups(JSON.parse(code)));
    } catch {
      return null;
    }
  }, [code]);
  if (!processed?.spec) {
    return (
      <div className="ws-md-code">
        <div className="ws-md-code-lang">dsh-ui</div>
        <pre><code>{code}</code></pre>
      </div>
    );
  }
  return (
    <GenuiActionContext.Provider value={(action, payload) => {
      window.dispatchEvent(new CustomEvent('aiwo:genui-action', { detail: { action, payload } }));
    }}>
      <GenuiBlock spec={processed.spec} stateKey={`${fenceKey}:${code.length}`} />
    </GenuiActionContext.Provider>
  );
}

/** 轻量 Markdown：标题、列表、引用、表格、代码块、链接、粗体/斜体/行内代码。 */
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith('```')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      if (language === 'dsh-ui') {
        blocks.push(<GenuiFence key={`genui-${key++}`} code={code.join('\n')} fenceKey={`md-${key}`} />);
        continue;
      }
      blocks.push(
        <div className="ws-md-code" key={`code-${key++}`}>
          {language ? <div className="ws-md-code-lang">{language}</div> : null}
          <pre><code>{code.join('\n')}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(4, heading[1]!.length);
      const content = heading[2] ?? '';
      const Tag = (`h${level}`) as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={`h-${key++}`}>{inline(content, `h${key}`)}</Tag>);
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${key++}`} />);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${key++}`}>{inline(quote.join('\n'), `q${key}`)}</blockquote>);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`}>
          {items.map((item, i) => <li key={i}>{inline(item, `li-${key}-${i}`)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`}>
          {items.map((item, i) => <li key={i}>{inline(item, `oli-${key}-${i}`)}</li>)}
        </ol>,
      );
      continue;
    }

    // 简单表格：标题行 + 分隔行
    if (line.includes('|') && /^\s*\|?[-:|\s]+\|?\s*$/.test(lines[index + 1] ?? '')) {
      const parseRow = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const headers = parseRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        rows.push(parseRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push(
        <div className="ws-md-table-wrap" key={`table-${key++}`}>
          <table>
            <thead><tr>{headers.map((header, i) => <th key={i}>{inline(header, `th-${key}-${i}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] ?? '', `td-${key}-${rowIndex}-${cellIndex}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !isSpecial(lines[index] ?? '')) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(<p key={`p-${key++}`}>{inline(paragraph.join('\n'), `p${key}`)}</p>);
  }

  return <div className="ws-md">{blocks}</div>;
}
