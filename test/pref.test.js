import test from 'node:test';
import assert from 'node:assert/strict';
import { createPref } from '../src/pref.js';

test('pref: TTL 到期后失效', () => {
  let now = 1000;
  const pref = createPref(100, () => now);
  pref.set('a', 'proxy');
  assert.equal(pref.get('a'), 'proxy');

  now += 50;
  assert.equal(pref.get('a'), 'proxy');

  now += 51;
  assert.equal(pref.get('a'), null, '过期后应返回 null');
  assert.equal(pref.size(), 0, '过期项应被清掉');
});

test('pref: 覆盖与主动删除', () => {
  const pref = createPref(1000);
  pref.set('a', 'proxy');
  pref.set('a', 'direct');
  assert.equal(pref.get('a'), 'direct');

  pref.delete('a');
  assert.equal(pref.get('a'), null);
});

test('pref: 未设置过的 host 返回 null', () => {
  const pref = createPref(1000);
  assert.equal(pref.get('nope'), null);
});
