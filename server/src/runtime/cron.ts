/**
 * 最小 cron 解析器（5 段：分 时 日 月 周）。
 *
 * 支持 `*`、数字、范围（a-b）、列表（a,b）与步进（星号/n、a-b/n、a/n）。
 * 时间按服务器本地时区（Date 的本地字段）匹配；非法表达式直接抛错，由调用方跳过。
 * 日 / 周两个字段同时被限定时的语义与 Vixie cron 一致：任一命中即匹配。
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** 日字段是否被显式限定（不是裸 `*`）。 */
  daysRestricted: boolean;
  /** 周字段是否被显式限定（不是裸 `*`）。 */
  weekdaysRestricted: boolean;
}

interface ParsedField {
  values: Set<number>;
  restricted: boolean;
}

const FIELD_NAMES = ['分', '时', '日', '月', '周'] as const;

const FIELD_LIMITS: [number, number][] = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周：允许 7 表示周日（内部归一为 0）
];

function parseField(raw: string, min: number, max: number, name: string, weekday = false): ParsedField {
  const text = raw.trim();
  if (!text) throw new Error(`cron ${name} 段为空`);
  const values = new Set<number>();
  for (const piece of text.split(',')) {
    const chunk = piece.trim();
    if (!chunk) throw new Error(`cron ${name} 段含空项：${text}`);
    const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(chunk);
    if (!match) throw new Error(`cron ${name} 段不合法：${chunk}`);
    const base = match[1]!;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${name} 步进不合法：${chunk}`);

    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(base);
      end = match[2] === undefined ? start : max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`cron ${name} 段不合法：${chunk}`);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron ${name} 段超出范围：${chunk}（允许 ${min}-${max}）`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(weekday ? value % 7 : value);
    }
  }
  if (values.size === 0) throw new Error(`cron ${name} 段没有有效值`);
  return { values, restricted: text !== '*' };
}

/** 解析 5 段 cron 表达式；不合法时抛 Error。 */
export function parseCron(expression: string): CronFields {
  const parts = String(expression ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length !== 5) {
    throw new Error('cron 表达式必须是 5 段：分 时 日 月 周');
  }
  const parsed = parts.map((part, index) => {
    const [min, max] = FIELD_LIMITS[index]!;
    return parseField(part!, min, max, FIELD_NAMES[index]!, index === 4);
  });
  return {
    minutes: parsed[0]!.values,
    hours: parsed[1]!.values,
    days: parsed[2]!.values,
    months: parsed[3]!.values,
    weekdays: parsed[4]!.values,
    daysRestricted: parsed[2]!.restricted,
    weekdaysRestricted: parsed[4]!.restricted,
  };
}

/** 表达式是否合法（调度器跳过非法表达式时使用）。 */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** 判断某个时刻（分钟粒度）是否命中已解析的 cron 字段。 */
export function matchesCronFields(fields: CronFields, date: Date): boolean {
  if (!fields.minutes.has(date.getMinutes())) return false;
  if (!fields.hours.has(date.getHours())) return false;
  if (!fields.months.has(date.getMonth() + 1)) return false;
  const dayOfMonth = fields.days.has(date.getDate());
  const dayOfWeek = fields.weekdays.has(date.getDay());
  // 日 / 周同时被限定时为「或」，否则两者都必须命中（未限定的字段天然全量）。
  return fields.daysRestricted && fields.weekdaysRestricted
    ? dayOfMonth || dayOfWeek
    : dayOfMonth && dayOfWeek;
}

/** 便捷函数：解析并判断某个时刻是否命中 cron 表达式。 */
export function matchesCron(expression: string, date: Date): boolean {
  return matchesCronFields(parseCron(expression), date);
}
