#!/usr/bin/env node
/**
 * 独立运行时 worker：加载 dsh-hive-runtime 的运行时引擎（headless 执行器），
 * 适合没有常驻 DSH 宿主的机器/容器。用法：node scripts/worker.mjs <config.json>
 */
import { readFileSync } from 'node:fs';
import { HiveClient, HiveRuntime, resolveConfig } from '../lib/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/worker.mjs <config.json>');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(file, 'utf8'));
const config = resolveConfig(raw);
if (!config.agentToken) {
  console.error('config.agentToken is required');
  process.exit(2);
}
const logger = {
  info: (message, fields) => console.log(new Date().toISOString(), 'INFO', message, fields ?? ''),
  warn: (message, fields) => console.warn(new Date().toISOString(), 'WARN', message, fields ?? ''),
  error: (message, fields) => console.error(new Date().toISOString(), 'ERROR', message, fields ?? ''),
};
const runtime = new HiveRuntime({}, () => config, new HiveClient(() => config), logger);
await runtime.start();
console.log(new Date().toISOString(), 'worker ready', runtime.snapshot());
// 运行时内部的 timer 都 unref 了（避免拖住 DSH 宿主）；独立 worker 需要自己的 keepalive。
const keepAlive = setInterval(() => {}, 60_000);
const shutdown = async () => {
  clearInterval(keepAlive);
  await runtime.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await new Promise(() => {});
