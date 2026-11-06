import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidCron, matchesCron, matchesCronFields, parseCron } from './cron.ts';

test('parseCron：星号步进', () => {
  const fields = parseCron('*/15 * * * *');
  assert.deepEqual([...fields.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.equal(fields.hours.size, 24);
  assert.equal(fields.days.size, 31);
  assert.equal(fields.daysRestricted, false);
  assert.equal(fields.weekdaysRestricted, false);
});

test('parseCron：数字 / 范围 / 列表', () => {
  const fields = parseCron('0,30 8-18/2 * * 1-5');
  assert.deepEqual([...fields.minutes].sort((a, b) => a - b), [0, 30]);
  assert.deepEqual([...fields.hours].sort((a, b) => a - b), [8, 10, 12, 14, 16, 18]);
  assert.deepEqual([...fields.weekdays].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(fields.daysRestricted, false);
  assert.equal(fields.weekdaysRestricted, true);
});

test('parseCron：单值步进从起始值到上界', () => {
  const fields = parseCron('5/20 * * * *');
  assert.deepEqual([...fields.minutes].sort((a, b) => a - b), [5, 25, 45]);
});

test('parseCron：周字段 7 归一为周日 0', () => {
  assert.deepEqual([...parseCron('0 9 * * 7').weekdays], [0]);
  assert.deepEqual([...parseCron('0 9 * * 5-7').weekdays].sort((a, b) => a - b), [0, 5, 6]);
});

test('parseCron：非法表达式抛错', () => {
  for (const expr of ['', '0 9 * *', '0 9 * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a b c d e', '*/0 * * * *', '5-3 * * * *', '1,,2 * * * *']) {
    assert.throws(() => parseCron(expr), Error, `应拒绝：${JSON.stringify(expr)}`);
    assert.equal(isValidCron(expr), false);
  }
  assert.equal(isValidCron('0 9 * * *'), true);
});

test('matchesCron：分 / 时精确命中', () => {
  const at = new Date(2026, 10, 6, 9, 0, 30);
  assert.equal(matchesCron('0 9 * * *', at), true);
  assert.equal(matchesCron('1 9 * * *', at), false);
  assert.equal(matchesCron('0 10 * * *', at), false);
  assert.equal(matchesCron('*/5 * * * *', at), true);
});

test('matchesCron：月份 / 日期约束', () => {
  const at = new Date(2026, 10, 6, 9, 0); // 2026-11-06，周五
  assert.equal(matchesCron('0 9 * 11 *', at), true);
  assert.equal(matchesCron('0 9 * 12 *', at), false);
  assert.equal(matchesCron('0 9 6 * *', at), true);
  assert.equal(matchesCron('0 9 7 * *', at), false);
  assert.equal(matchesCron('0 9 * * 5', at), true);
  assert.equal(matchesCron('0 9 * * 1', at), false);
});

test('matchesCron：日 / 周同时限定时为「或」', () => {
  const friday = new Date(2026, 10, 6, 9, 0); // 11-06 周五
  // 6 号命中，或周五命中 → 两者均命中
  assert.equal(matchesCron('0 9 6 * 5', friday), true);
  // 7 号不命中但周五命中 → Vixie 语义下仍匹配
  assert.equal(matchesCron('0 9 7 * 5', friday), true);
  // 只有日字段限定（周为 *）→ 必须命中日期
  assert.equal(matchesCron('0 9 7 * *', friday), false);
  const fields = parseCron('0 9 7 * 5');
  assert.equal(matchesCronFields(fields, friday), true);
});

test('matchesCron：秒与毫秒不影响分钟粒度判断', () => {
  const at = new Date(2026, 10, 6, 9, 0, 59, 999);
  assert.equal(matchesCron('0 9 * * *', at), true);
});
