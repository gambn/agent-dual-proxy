import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGateway, collectGateways } from '../src/gateways.js';

test('parseGateway：接受 host:port 与带 scheme 的 URL', () => {
  assert.deepEqual(parseGateway('127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
  assert.deepEqual(parseGateway('http://127.0.0.1:12334'), { host: '127.0.0.1', port: 12334 });
  assert.deepEqual(parseGateway(' https://proxy.local:8443/ '), { host: 'proxy.local', port: 8443 });
  assert.deepEqual(parseGateway('http://[::1]:7890'), { host: '::1', port: 7890 });
});

test('parseGateway：无法解析或端口越界时返回 null', () => {
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
