/**
 * 自动化提示词模板渲染：把 `{{变量}}` 替换为对应值。
 * 缺失 / 空值替换为空字符串，不抛错（模板由用户填写，渲染必须健壮）。
 */

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: TemplateVars = {}): string {
  if (!template) return '';
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/** 提取模板中出现的变量名（去重，按出现顺序）。 */
export function templateVariables(template: string): string[] {
  const found: string[] = [];
  if (!template) return found;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1]!;
    if (!found.includes(key)) found.push(key);
  }
  return found;
}
