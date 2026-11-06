import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { githubSignature, safeEqualStrings, verifyGithubSignature, verifyGitlabToken } from './signature.ts';

const SECRET = 'demo-github-secret';
const BODY = JSON.stringify({ action: 'opened', pull_request: { title: '缓存改造' } });

function expectedHeader(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

test('githubSignature：与手工 HMAC 一致', () => {
  assert.equal(githubSignature(SECRET, BODY), expectedHeader(SECRET, BODY));
  assert.equal(githubSignature(SECRET, Buffer.from(BODY, 'utf8')), expectedHeader(SECRET, BODY));
});

test('verifyGithubSignature：正确签名通过', () => {
  assert.equal(verifyGithubSignature(SECRET, BODY, expectedHeader(SECRET, BODY)), true);
});

test('verifyGithubSignature：错误 secret / 篡改 body / 缺头均拒绝', () => {
  assert.equal(verifyGithubSignature(SECRET, BODY, expectedHeader('other-secret', BODY)), false);
  assert.equal(verifyGithubSignature(SECRET, `${BODY} `, expectedHeader(SECRET, BODY)), false);
  assert.equal(verifyGithubSignature(SECRET, BODY, undefined), false);
  assert.equal(verifyGithubSignature(SECRET, BODY, ''), false);
  assert.equal(verifyGithubSignature('', BODY, expectedHeader(SECRET, BODY)), false);
});

test('verifyGithubSignature：格式不合法拒绝', () => {
  assert.equal(verifyGithubSignature(SECRET, BODY, 'sha1=abcdef'), false);
  assert.equal(verifyGithubSignature(SECRET, BODY, 'sha256='), false);
  assert.equal(verifyGithubSignature(SECRET, BODY, 'sha256=zzzz'), false);
  assert.equal(verifyGithubSignature(SECRET, BODY, expectedHeader(SECRET, BODY).toUpperCase()), true);
});

test('verifyGitlabToken：正确 token 通过，错误 token 拒绝', () => {
  assert.equal(verifyGitlabToken('demo-gitlab-secret', 'demo-gitlab-secret'), true);
  assert.equal(verifyGitlabToken('demo-gitlab-secret', 'demo-gitlab-secret '), false);
  assert.equal(verifyGitlabToken('demo-gitlab-secret', 'demo-gitlab-secret-x'), false);
  assert.equal(verifyGitlabToken('demo-gitlab-secret', ''), false);
  assert.equal(verifyGitlabToken('demo-gitlab-secret', undefined), false);
  assert.equal(verifyGitlabToken('', 'demo-gitlab-secret'), false);
});

test('safeEqualStrings：等长比较', () => {
  assert.equal(safeEqualStrings('abc', 'abc'), true);
  assert.equal(safeEqualStrings('abc', 'abd'), false);
  assert.equal(safeEqualStrings('abc', 'ab'), false);
});
