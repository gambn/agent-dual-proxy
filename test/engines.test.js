import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeAtLeast, assertNode, MIN_NODE } from '../src/engines.js';

test('engines：版本比较', () => {
  assert.equal(MIN_NODE, '22.19.0');
  assert.equal(nodeAtLeast('22.19.0'), true);
  assert.equal(nodeAtLeast('22.18.9'), false);
  assert.equal(nodeAtLeast('20.11.0'), false);
  assert.equal(nodeAtLeast('24.18.0'), true);
});

test('engines：低于门槛时给出可读错误', () => {
  assert.doesNotThrow(() => assertNode('22.19.0'));
  assert.throws(() => assertNode('18.20.0'), /requires Node >= 22\.19\.0 \(current 18\.20\.0\)/);
});
