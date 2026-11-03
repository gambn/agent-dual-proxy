import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGateway,
  collectGateways,
  resolveUpstream,
  redactGateway,
  buildCandidates,
  UpstreamError
} from '../src/gateways.js';

const basic = (value) => 'Basic ' + Buffer.from(value).toString('base64');

test('parseGateway：接受 host:port、http URL、userinfo 与 IPv6', () => {
  assert.deepEqual(parseGateway('127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
  assert.deepEqual(parseGateway('http://127.0.0.1:12334'), { host: '127.0.0.1', port: 12334 });
  assert.deepEqual(parseGateway('http://[::1]:7890'), { host: '::1', port: 7890 });
  assert.deepEqual(parseGateway('http://alice:secret@127.0.0.1:8080'), {
    host: '127.0.0.1',
    port: 8080,
    auth: basic('alice:secret')
  });
});

test('parseGateway：百分号编码的 user/pass 解码后再编 Basic', () => {
  assert.deepEqual(parseGateway('http://u%40ser:p%3Ass@127.0.0.1:8080'), {
    host: '127.0.0.1',
    port: 8080,
    auth: basic('u@ser:p:ss')
  });
  assert.equal(parseGateway('http://u%ZZ:p@127.0.0.1:8080'), null);
});

test('parseGateway：https 上游、无法解析或端口越界时返回 null', () => {
  assert.equal(parseGateway('https://proxy.local:8443/'), null);
  assert.equal(parseGateway(''), null);
  assert.equal(parseGateway('   '), null);
  assert.equal(parseGateway('http://'), null);
  assert.equal(parseGateway('127.0.0.1:0'), null);
  assert.equal(parseGateway('127.0.0.1:70000'), null);
});

test('collectGateways：合并配置与 env，去重并排除自身端口', () => {
  const list = collectGateways({
    upstream: { host: '127.0.0.1', port: 7897 },
    extra: ['127.0.0.1:12334', '127.0.0.1:7897'],
    env: { HTTPS_PROXY: 'http://127.0.0.1:12334' },
    self: { host: '127.0.0.1', port: 7898 }
  });
  assert.deepEqual(list.map((g) => g.host + ':' + g.port), ['127.0.0.1:7897', '127.0.0.1:12334']);
});

test('collectGateways：env 优先 https_proxy，自身端口不会被当成网关', () => {
  const list = collectGateways({
    upstream: { host: '127.0.0.1', port: 7898 },
    extra: [],
    env: { https_proxy: 'http://127.0.0.1:7898', HTTPS_PROXY: 'http://127.0.0.1:12334' },
    self: { host: '127.0.0.1', port: 7898 }
  });
  assert.deepEqual(list.map((g) => g.host + ':' + g.port), ['127.0.0.1:12334']);
});

test('collectGateways：同 host:port 无 auth + 有 auth 时补 auth（U12b）', () => {
  const list = collectGateways({
    upstream: { host: '127.0.0.1', port: 7897 },
    extra: [],
    env: { HTTPS_PROXY: 'http://alice:secret@127.0.0.1:7897' }
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].auth, basic('alice:secret'));
});

test('collectGateways：同 host:port 两边 auth 不同保留第一条并脱敏 warning（U12c）', () => {
  const warnings = [];
  const list = collectGateways({
    upstream: { host: '127.0.0.1', port: 7897, auth: basic('first:one') },
    extra: ['http://second:two@127.0.0.1:7897'],
    onInvalid: (subject, reason) => warnings.push([subject, reason])
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].auth, basic('first:one'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1], /conflicting proxy credentials/);
  assert.ok(!warnings[0][0].includes('first') && !warnings[0][0].includes('second'));
});

test('collectGateways：https/非法项给脱敏 warning，不静默丢弃', () => {
  const warnings = [];
  const list = collectGateways({
    upstream: { host: '127.0.0.1', port: 7897 },
    extra: ['https://alice:secret@proxy.local:8443', 'not a gateway'],
    onInvalid: (subject, reason) => warnings.push([subject, reason])
  });
  assert.deepEqual(list.map((g) => g.host + ':' + g.port), ['127.0.0.1:7897']);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0][1], /https upstream proxy is not supported/);
  assert.ok(!warnings[0][0].includes('alice') && !warnings[0][0].includes('secret'));
  assert.match(warnings[1][1], /invalid gateway/);
});

test('resolveUpstream：upstreamUrl 覆盖 host/port，空值沿用 host/port', () => {
  assert.deepEqual(resolveUpstream({ upstreamHost: '127.0.0.1', upstreamPort: 7897 }), {
    host: '127.0.0.1',
    port: 7897
  });
  assert.deepEqual(resolveUpstream({
    upstreamUrl: 'http://alice:secret@127.0.0.2:8888',
    upstreamHost: '127.0.0.1',
    upstreamPort: 7897
  }), {
    host: '127.0.0.2',
    port: 8888,
    auth: basic('alice:secret')
  });
});

test('resolveUpstream：非法/带凭证的 upstreamUrl 抛脱敏错误（U19）', () => {
  for (const value of ['https://alice:secret@proxy.local:8443', 'http://u%ZZ:p@127.0.0.1:8080', 'not a url']) {
    assert.throws(
      () => resolveUpstream({ upstreamUrl: value }),
      (err) => err instanceof UpstreamError &&
        !String(err.message).includes('alice') &&
        !String(err.message).includes('secret') &&
        !String(err.message).includes('proxy.local')
    );
  }
});

test('buildCandidates：upstreamUrl 的 host/port/auth 替换旧 upstream（U20/U21）', () => {
  const replaced = buildCandidates(
    { host: '10.0.0.2', port: 8888, auth: basic('alice:secret') },
    ['10.0.0.3:9999'],
    undefined
  );
  assert.deepEqual(replaced.map((g) => g.id), ['10.0.0.2:8888', '10.0.0.3:9999', 'direct']);
  assert.equal(replaced[0].auth, basic('alice:secret'));
  assert.ok(!replaced.some((g) => g.id === '127.0.0.1:7897'));

  const same = buildCandidates(
    { host: '127.0.0.1', port: 7897, auth: basic('alice:secret') },
    ['http://127.0.0.1:7897'],
    undefined
  );
  assert.deepEqual(same.map((g) => g.id), ['127.0.0.1:7897', 'direct']);
  assert.equal(same[0].auth, basic('alice:secret'));
});

test('redactGateway：去掉 userinfo，非法值不泄漏原文', () => {
  assert.equal(redactGateway('http://alice:secret@127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(redactGateway('https://alice:secret@proxy.local:8443'), 'https://proxy.local:8443');
  assert.equal(redactGateway('not a gateway'), '<invalid>');
  assert.equal(redactGateway('http://alice:secret@'), '<invalid>');
});

test('collectGateways：非法 upstream 对象也走 warning，不静默（U16 数据层）', () => {
  const warnings = [];
  const list = collectGateways({
    upstream: { host: '', port: 1 },
    onInvalid: (subject, reason) => warnings.push([subject, reason])
  });
  assert.deepEqual(list, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1], /invalid gateway/);
});

test('resolveUpstream：非法 host/port 抛脱敏错误', () => {
  assert.throws(() => resolveUpstream({ upstreamHost: '127.0.0.1', upstreamPort: 0 }), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.match(err.message, /invalid upstreamHost/);
    return true;
  });
});
