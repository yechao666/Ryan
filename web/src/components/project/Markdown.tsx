import type { ReactNode } from 'react';

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={key}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
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
