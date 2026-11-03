import test from 'node:test';
import assert from 'node:assert/strict';
import { hasIdempotencyKey, isIdempotent, shouldRetryAfterSend } from '../src/retry-policy.js';

test('retry-policy：幂等集合', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']) {
    assert.equal(isIdempotent(method), true, method);
  }
  for (const method of ['POST', 'PATCH', 'FOO', undefined]) {
    assert.equal(isIdempotent(method), false, String(method));
  }
});

test('retry-policy：方法大小写不敏感', () => {
  assert.equal(isIdempotent('get'), true);
  assert.equal(isIdempotent('Put'), true);
});

test('retry-policy：重放决策表', () => {
  const base = { retryNonIdempotentAfterSend: false };
  assert.equal(shouldRetryAfterSend({ method: 'POST', sent: false, ...base }), true);
  assert.equal(shouldRetryAfterSend({ method: 'GET', sent: true, ...base }), true);
  assert.equal(shouldRetryAfterSend({ method: 'POST', sent: true, ...base }), false);
  assert.equal(shouldRetryAfterSend({ method: 'POST', sent: true, retryNonIdempotentAfterSend: true }), true);
  assert.equal(shouldRetryAfterSend({ method: 'PATCH', sent: true, ...base }), false);
  assert.equal(shouldRetryAfterSend({ method: 'PUT', sent: true, ...base }), true);
});

test('retry-policy：幂等键存在性（U13/A8）', () => {
  assert.equal(hasIdempotencyKey({ 'idempotency-key': 'abc' }), true);
  assert.equal(hasIdempotencyKey({ 'Idempotency-Key': ' abc ' }), true);
  assert.equal(hasIdempotencyKey({ 'x-idempotency-key': 'abc' }), true);
  assert.equal(hasIdempotencyKey({ 'idempotency-key': ['', 'abc'] }), true);
  assert.equal(hasIdempotencyKey({ 'idempotency-key': '' }), false);
  assert.equal(hasIdempotencyKey({ 'idempotency-key': '   ' }), false);
  assert.equal(hasIdempotencyKey({ 'idempotency-key': ['', '  '] }), false);
  assert.equal(hasIdempotencyKey({}), false);
  assert.equal(hasIdempotencyKey(undefined), false);
  assert.equal(hasIdempotencyKey(null), false);
  assert.equal(hasIdempotencyKey('idempotency-key'), false);
  assert.equal(hasIdempotencyKey({ 'idempotency-key': null }), false);
  assert.equal(hasIdempotencyKey({ 'content-type': 'application/json' }), false);
  assert.equal(hasIdempotencyKey({ 'content-type': 'application/json', 'idempotency-key': 'abc' }), true);
});

test('retry-policy：键开关与全局开关的优先级（U14/C3）', () => {
  const post = { method: 'POST', sent: true };
  assert.equal(shouldRetryAfterSend({ ...post, retryNonIdempotentWithIdempotencyKey: true, idempotencyKey: true }), true);
  assert.equal(shouldRetryAfterSend({ ...post, retryNonIdempotentWithIdempotencyKey: true, idempotencyKey: false }), false);
  assert.equal(shouldRetryAfterSend({ ...post, retryNonIdempotentWithIdempotencyKey: true }), false);
  assert.equal(shouldRetryAfterSend({ ...post, retryNonIdempotentWithIdempotencyKey: false, idempotencyKey: true }), false);
  assert.equal(shouldRetryAfterSend({ ...post, retryNonIdempotentAfterSend: true }), true);
  assert.equal(shouldRetryAfterSend({ ...post, retryNonIdempotentAfterSend: true, retryNonIdempotentWithIdempotencyKey: true }), true);
  assert.equal(shouldRetryAfterSend({ ...post, sent: false, retryNonIdempotentWithIdempotencyKey: false, idempotencyKey: false }), true);
});
