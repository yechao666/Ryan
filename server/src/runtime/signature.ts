/**
 * Webhook 验签工具：GitHub 的 HMAC-SHA256 签名与 GitLab 的共享令牌。
 * 所有比较均使用 crypto.timingSafeEqual，避免时序侧信道；绝不回显 secret。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** 计算 GitHub 风格签名头：`sha256=<hex>`。 */
export function githubSignature(secret: string, body: Buffer | string): string {
  const hmac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hmac}`;
}

/** 常量时间字符串比较（长度不同直接返回 false）。 */
export function safeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 校验 `x-hub-signature-256`（格式 `sha256=<hex>`）。
 * secret 或头缺失时一律视为不通过。
 */
export function verifyGithubSignature(
  secret: string,
  body: Buffer | string,
  header: string | undefined | null,
): boolean {
  if (!secret || !header) return false;
  const value = header.trim();
  if (!value.toLowerCase().startsWith('sha256=')) return false;
  const provided = value.slice('sha256='.length).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;
  const expected = githubSignature(secret, body).slice('sha256='.length);
  return safeEqualStrings(provided, expected);
}

/**
 * 校验 `x-gitlab-token`：先各自 sha256 再常量时间比较，
 * 这样长度差异不会泄漏 token 长度，也避免提前返回。
 */
export function verifyGitlabToken(secret: string, token: string | undefined | null): boolean {
  if (!secret || !token) return false;
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  const provided = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(expected, provided);
}
