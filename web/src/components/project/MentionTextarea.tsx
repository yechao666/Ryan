import { useEffect, useRef, useState } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { Badge } from '@ui';
import { api, type MentionTarget } from '@lib/api.ts';

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
}

interface OpenState {
  start: number;
  query: string;
}

/** 支持 @ 人员/智能体补全的多行输入框。 */
export function MentionTextarea({ value, onChange, onKeyDown, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [targets, setTargets] = useState<MentionTarget[]>([]);
  const [open, setOpen] = useState<OpenState | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.mentionTargets()
      .then((result) => { if (!cancelled) setTargets(result.targets); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const options = open
    ? targets.filter((target) => target.name.toLowerCase().includes(open.query.toLowerCase())).slice(0, 8)
    : [];

  const detect = (next: string, cursor: number): void => {
    const before = next.slice(0, cursor);
    const at = before.lastIndexOf('@');
    if (at < 0) { setOpen(null); return; }
    if (at > 0 && /[A-Za-z0-9._%+-]/.test(before[at - 1] ?? '')) { setOpen(null); return; }
    const query = before.slice(at + 1);
    if (query.includes('\n') || query.length > 40) { setOpen(null); return; }
    setOpen({ start: at, query });
    setActive(0);
  };

  const choose = (target: MentionTarget): void => {
    if (!open || !ref.current) return;
    const cursor = ref.current.selectionStart;
    const scheme = target.kind === 'person' ? 'person' : 'agent';
    const token = `[@${target.name}](mention://${scheme}/${encodeURIComponent(target.id)}) `;
    const next = `${value.slice(0, open.start)}${token}${value.slice(cursor)}`;
    onChange(next);
    setOpen(null);
    requestAnimationFrame(() => {
      const position = open.start + token.length;
      ref.current?.focus();
      ref.current?.setSelectionRange(position, position);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    onKeyDown?.(event);
    if (!open || options.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => (index + 1) % options.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => (index - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' && options[active]) { event.preventDefault(); choose(options[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(null); }
  };

  return (
    <div className="mention-field">
      <textarea
        {...rest}
        ref={ref}
        className={`textarea ${rest.className ?? ''}`}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          detect(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => window.setTimeout(() => setOpen(null), 150)}
      />
      {open && options.length > 0 ? (
        <div className="mention-menu">
          {options.map((target, index) => (
            <button
              type="button"
              key={`${target.kind}:${target.id}`}
              className={`mention-item${index === active ? ' active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(target)}
            >
              <span className="mention-item__main">
                <span className="mention-item__name">@{target.name}</span>
                <span className="mention-item__detail">{target.detail}</span>
              </span>
              <Badge size="sm" tone={target.kind === 'person' ? 'cyan' : 'violet'}>{target.kind === 'person' ? '人员' : '智能体'}</Badge>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
