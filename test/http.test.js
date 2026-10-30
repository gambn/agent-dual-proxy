import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/server.js';
import { startTarget, startFakeProxy, closedPort, httpVia } from './helpers.js';

const silent = () => {};

test('HTTP：上游不通时回退直连', async () => {
  const target = await startTarget();
  const dead = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: dead, attemptTimeoutMs: 1000, log: silent });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/hello');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-target'], 'yes');
    assert.match(r.body, /^target:GET:/);
  } finally {
    await d.close();
    await target.close();
  }
});

test('HTTP：上游可用时走上游代理', async () => {
  const target = await startTarget();
  const proxy = await startFakeProxy();
  const d = createDispatcher({ listenPort: 0, upstreamPort: proxy.port, attemptTimeoutMs: 1000, log: silent });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/via-proxy');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-via'], 'proxy', '应经上游代理');
  } finally {
    await d.close();
    await proxy.close();
    await target.close();
  }
});

test('HTTP：两条路都不通时返回 502', async () => {
  const deadTarget = await closedPort();
  const deadUpstream = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: deadUpstream, attemptTimeoutMs: 800, log: silent });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + deadTarget + '/nope');
    assert.equal(r.status, 502);
  } finally {
    await d.close();
  }
});

test('HTTP：多个网关时跳过不通的那个', async () => {
  const target = await startTarget();
  const dead = await closedPort();
  const proxy = await startFakeProxy('second');
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: dead,
    gateways: ['127.0.0.1:' + proxy.port],
    attemptTimeoutMs: 800,
    log: silent
  });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/multi');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-via'], 'second');
    assert.equal(d.pref.get('127.0.0.1'), '127.0.0.1:' + proxy.port);
  } finally {
    await d.close();
    await proxy.close();
    await target.close();
  }
});

test('HTTP：缓存的网关挂掉后，下一次请求就换到能用的那条', async () => {
  const target = await startTarget();
  const proxyA = await startFakeProxy('a');
  const proxyB = await startFakeProxy('b');
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: proxyA.port,
    gateways: ['127.0.0.1:' + proxyB.port],
    attemptTimeoutMs: 500,
    log: silent
  });
  const addr = await d.listen();
  try {
    const first = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/one');
    assert.equal(first.headers['x-via'], 'a');
    assert.equal(d.pref.get('127.0.0.1'), '127.0.0.1:' + proxyA.port);

    await proxyA.close();

    const second = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/two');
    assert.equal(second.status, 200);
    assert.equal(second.headers['x-via'], 'b');
    assert.equal(d.pref.get('127.0.0.1'), '127.0.0.1:' + proxyB.port);
  } finally {
    await d.close();
    await proxyB.close();
    await target.close();
  }
});
