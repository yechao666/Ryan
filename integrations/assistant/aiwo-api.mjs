#!/usr/bin/env node
/**
 * DSH 助手调用 Aiwo API 的小工具。
 * 用法：node aiwo-api.mjs GET /api/projects
 *       node aiwo-api.mjs POST /api/projects/prj_x/tasks '{"title":"..."}'
 * 环境变量由 Aiwo 助手服务注入：AIWO_API_BASE、AIWO_TOKEN。
 */
const [, , method = 'GET', path, body] = process.argv;
if (!path) {
  console.error('用法：node aiwo-api.mjs <METHOD> <PATH> [JSON_BODY]');
  process.exit(2);
}
const { readFileSync } = await import('node:fs');
const base = process.env.AIWO_API_BASE;
let token = process.env.AIWO_TOKEN || '';
if (!token && process.env.HIVE_AUTH_FILE) {
  try {
    token = readFileSync(process.env.HIVE_AUTH_FILE, 'utf8').trim();
  } catch {
    /* fall through */
  }
}
if (!base || !token) {
  console.error('缺少 AIWO_API_BASE 或助手凭证文件');
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
if (body) headers['content-type'] = 'application/json';
const response = await fetch(`${base}${path}`, {
  method: method.toUpperCase(),
  headers,
  body: body || undefined,
});
const text = await response.text();
let data;
try {
  data = text ? JSON.parse(text) : null;
} catch {
  data = text;
}
console.log(JSON.stringify({ status: response.status, data }, null, 2));
if (!response.ok) process.exit(1);
