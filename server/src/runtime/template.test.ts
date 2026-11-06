import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTemplate, templateVariables } from './template.ts';

test('renderTemplate：替换已知变量', () => {
  const text = renderTemplate('项目 {{project}} 收到 {{event}}：{{title}}', {
    project: 'Orion 订单服务',
    event: 'merge_request',
    title: '拆分查询服务',
  });
  assert.equal(text, '项目 Orion 订单服务 收到 merge_request：拆分查询服务');
});

test('renderTemplate：允许变量名两侧空白', () => {
  assert.equal(renderTemplate('a {{ branch }} b', { branch: 'main' }), 'a main b');
});

test('renderTemplate：缺失 / 空值替换为空字符串', () => {
  assert.equal(renderTemplate('[{{missing}}]', {}), '[]');
  assert.equal(renderTemplate('[{{n}}]', { n: null }), '[]');
  assert.equal(renderTemplate('[{{u}}]', { u: undefined }), '[]');
  assert.equal(renderTemplate('[{{zero}}]', { zero: 0 }), '[0]');
  assert.equal(renderTemplate('[{{flag}}]', { flag: false }), '[false]');
});

test('renderTemplate：同一变量多次出现全部替换', () => {
  assert.equal(renderTemplate('{{x}}-{{x}}', { x: 'v' }), 'v-v');
});

test('renderTemplate：空模板与非模板文本原样返回', () => {
  assert.equal(renderTemplate('', { a: 'b' }), '');
  assert.equal(renderTemplate('没有占位符', { a: 'b' }), '没有占位符');
  assert.equal(renderTemplate('{{ 非法 占位 }}', {}), '{{ 非法 占位 }}');
});

test('templateVariables：按出现顺序去重', () => {
  assert.deepEqual(templateVariables('{{project}} {{event}} {{project}} {{title}}'), ['project', 'event', 'title']);
  assert.deepEqual(templateVariables('无变量'), []);
});
