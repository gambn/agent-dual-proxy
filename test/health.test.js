import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/server.js';
import { startTarget, startSlowTarget, startFakeProxy, startSilent, startEcho, closedPort, tunnelVia } from './helpers.js';

const silent = () => {};

test('健康检查：跳过不通的网关，选中能到达模型的', async () => {
  const target = await startTarget();
  const proxy = await startFakeProxy();
  const dead = await closedPort();
  const healthUrl = 'http://127.0.0.1:' + target.port + '/health';
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: dead,
    gateways: ['127.0.0.1:' + proxy.port],
    healthUrl,
    healthIntervalMs: 0,
    attemptTimeoutMs: 800,
    log: silent
  });
  await d.listen();
  try {
    const result = await d.checkHealth();
    assert.equal(result.id, '127.0.0.1:' + proxy.port);
    assert.equal(result.status, 200);
  } finally {
    await d.close();
    await proxy.close();
    await target.close();
  }
});

test('健康检查：全都不通时返回 null，且不留下偏好', async () => {
  const deadTarget = await closedPort();
  const deadUpstream = await closedPort();
  const deadGateway = await closedPort();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: deadUpstream,
    gateways: ['127.0.0.1:' + deadGateway],
    healthUrl: 'http://127.0.0.1:' + deadTarget + '/health',
    healthIntervalMs: 0,
    attemptTimeoutMs: 500,
    log: silent
  });
  await d.listen();
  try {
    assert.equal(await d.checkHealth(), null);
    assert.equal(d.getPreferred(), null);
  } finally {
    await d.close();
  }
});

test('健康循环：通过后把首选网关记下来', async () => {
  const target = await startTarget();
  const proxy = await startFakeProxy();
  const dead = await closedPort();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: dead,
    gateways: ['127.0.0.1:' + proxy.port],
    healthUrl: 'http://127.0.0.1:' + target.port + '/health',
    healthIntervalMs: 60000,
    healthTimeoutMs: 800,
    attemptTimeoutMs: 800,
    log: silent
  });
  await d.listen();
  try {
    d.startHealth();
    const expected = '127.0.0.1:' + proxy.port;
    for (let i = 0; i < 40 && d.getPreferred() !== expected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(d.getPreferred(), expected);
    assert.equal(d.pref.get('127.0.0.1'), expected, '健康主机应写入偏好');
  } finally {
    await d.close();
    await proxy.close();
    await target.close();
  }
});

test('网关失败会立刻触发健康检查，把首选换到能用的那条', async () => {
  const target = await startTarget();
  const proxy = await startFakeProxy();
  const stalled = await startSilent();
  const echo = await startEcho();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: stalled.port,
    gateways: ['127.0.0.1:' + proxy.port],
    healthUrl: 'http://127.0.0.1:' + target.port + '/health',
    healthIntervalMs: 60000,
    attemptTimeoutMs: 500,
    fastFailTimeoutMs: 200,
    log: silent
  });
  const addr = await d.listen();
  try {
    // 不启动周期循环：这次请求的失败应当自己踢一次健康检查
    const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
    sock.destroy();
    const expected = '127.0.0.1:' + proxy.port;
    for (let i = 0; i < 40 && d.getPreferred() !== expected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(d.getPreferred(), expected);
  } finally {
    await d.close();
    await proxy.close();
    await stalled.close();
    await echo.close();
    await target.close();
  }
});

test('健康检查：并发触发只跑一次', async () => {
  const slow = await startSlowTarget(150);
  const dead = await closedPort();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: dead,
    healthUrl: 'http://127.0.0.1:' + slow.port + '/health',
    healthIntervalMs: 60000,
    attemptTimeoutMs: 500,
    log: silent
  });
  await d.listen();
  try {
    await Promise.all([d.runHealth(), d.runHealth(), d.runHealth()]);
    assert.equal(slow.count(), 1, '同一时刻只应有一次探测');
  } finally {
    await d.close();
    await slow.close();
  }
});
