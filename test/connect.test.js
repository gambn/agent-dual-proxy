import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/server.js';
import { startFakeProxy, startAuthProxy, startTarget, startSilent, startEcho, startEcho6, closedPort, tunnelVia } from './helpers.js';

const silentLog = () => {};

function echoOnce(sock, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('echo timeout')), 2000);
    sock.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString('utf8'));
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.write(payload);
  });
}

test('CONNECT：上游不通时回退直连', async () => {
  const echo = await startEcho();
  const dead = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: dead, attemptTimeoutMs: 1000, log: silentLog });
  const addr = await d.listen();
  try {
    const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
    const got = await echoOnce(sock, 'ping');
    assert.equal(got, 'ping');
    sock.destroy();
  } finally {
    await d.close();
    await echo.close();
  }
});

test('CONNECT：上游可用时走代理隧道', async () => {
  const echo = await startEcho();
  const proxy = await startFakeProxy();
  const d = createDispatcher({ listenPort: 0, upstreamPort: proxy.port, attemptTimeoutMs: 1000, log: silentLog });
  const addr = await d.listen();
  try {
    const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
    const got = await echoOnce(sock, 'pong');
    assert.equal(got, 'pong');
    sock.destroy();
  } finally {
    await d.close();
    await proxy.close();
    await echo.close();
  }
});

test('CONNECT：两条路都不通时拒绝', async () => {
  const deadTarget = await closedPort();
  const deadUpstream = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: deadUpstream, attemptTimeoutMs: 800, log: silentLog });
  const addr = await d.listen();
  try {
    await assert.rejects(
      () => tunnelVia(addr.port, '127.0.0.1', deadTarget),
      /CONNECT failed: HTTP\/1\.1 502/
    );
  } finally {
    await d.close();
  }
});

test('CONNECT：多个网关时记住走通的那一个', async () => {
  const echo = await startEcho();
  const dead = await closedPort();
  const proxy = await startFakeProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: dead,
    gateways: ['127.0.0.1:' + proxy.port],
    attemptTimeoutMs: 800,
    log: silentLog
  });
  const addr = await d.listen();
  try {
    const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
    const got = await echoOnce(sock, 'multi');
    assert.equal(got, 'multi');
    sock.destroy();
    assert.equal(d.pref.get('127.0.0.1'), '127.0.0.1:' + proxy.port);
  } finally {
    await d.close();
    await proxy.close();
    await echo.close();
  }
});

test('CONNECT：缓存的网关卡住时用更短的超时，快速换到能用的那条', async () => {
  const echo = await startEcho();
  const silent = await startSilent();
  const proxy = await startFakeProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: silent.port,
    gateways: ['127.0.0.1:' + proxy.port],
    attemptTimeoutMs: 3000,
    fastFailTimeoutMs: 200,
    log: silentLog
  });
  const addr = await d.listen();
  try {
    // 预热：把这个卡住的网关写进偏好，模拟“缓存命中”
    d.pref.set('127.0.0.1', '127.0.0.1:' + silent.port);
    const started = Date.now();
    const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
    const got = await echoOnce(sock, 'fast');
    const elapsed = Date.now() - started;
    sock.destroy();
    assert.equal(got, 'fast');
    assert.ok(elapsed < 1500, '应快速失败，实际 ' + elapsed + 'ms');
    assert.equal(d.pref.get('127.0.0.1'), '127.0.0.1:' + proxy.port);
  } finally {
    await d.close();
    await proxy.close();
    await silent.close();
    await echo.close();
  }
});

test('网关失败后进入冷却，新的 host 不会再先撞它', async () => {
  const echo = await startEcho();
  const stalled = await startSilent();
  const proxy = await startFakeProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: stalled.port,
    gateways: ['127.0.0.1:' + proxy.port],
    attemptTimeoutMs: 600,
    fastFailTimeoutMs: 200,
    cooldownMs: 30000,
    log: silentLog
  });
  const addr = await d.listen();
  try {
    const first = await tunnelVia(addr.port, '127.0.0.1', echo.port);
    first.destroy();
    assert.equal(d.isCooling('127.0.0.1:' + stalled.port), true);

    const started = Date.now();
    const second = await tunnelVia(addr.port, 'localhost', echo.port);
    const elapsed = Date.now() - started;
    second.destroy();
    assert.ok(elapsed < 400, '冷却的网关应排到最后，实际 ' + elapsed + 'ms');
    assert.equal(d.pref.get('localhost'), '127.0.0.1:' + proxy.port);
  } finally {
    await d.close();
    await proxy.close();
    await stalled.close();
    await echo.close();
  }
});

test('CONNECT：IPv6 方括号地址能正常建隧道', async (t) => {
  let echo6;
  try {
    echo6 = await startEcho6();
  } catch (e) {
    t.skip('本机没有 IPv6 回环');
    return;
  }
  const dead = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: dead, attemptTimeoutMs: 500, log: silentLog });
  const addr = await d.listen();
  try {
    const sock = await tunnelVia(addr.port, '[::1]', echo6.port);
    const got = await echoOnce(sock, 'v6');
    sock.destroy();
    assert.equal(got, 'v6');
  } finally {
    await d.close();
    await echo6.close();
  }
});

test('关闭：在途隧道不会让 close 永久挂住', async () => {
  const echo = await startEcho();
  const dead = await closedPort();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: dead,
    attemptTimeoutMs: 500,
    shutdownTimeoutMs: 200,
    log: silentLog
  });
  const addr = await d.listen();
  const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
  const closed = new Promise((resolve) => sock.once('close', resolve));
  const started = Date.now();
  await d.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1200, 'close 应在强制超时后返回，实际 ' + elapsed + 'ms');
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('隧道没有被强制关闭')), 800))
  ]);
  await echo.close();
});

// ---- 0.7.0 上游代理认证（A1/A2） ----

const AUTH_HEADER = 'Basic ' + Buffer.from('alice:secret').toString('base64');

test('A1：CONNECT 经需认证的代理，目标看不到 Proxy-Authorization', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    upstreamAuth: AUTH_HEADER,
    attemptTimeoutMs: 1000,
    log: silentLog
  });
  const addr = await d.listen();
  try {
    const sock = await tunnelVia(addr.port, '127.0.0.1', target.port);
    sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const text = await new Promise((resolve, reject) => {
      let buf = '';
      sock.on('data', (chunk) => { buf += chunk; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('tunnel response timeout')), 2000);
    });
    assert.match(text, /HTTP\/1\.1 200/);
    assert.match(text, /x-echo-proxy-authorization: *\r\n/i);
    assert.equal(auth.connectCount(), 1);
    sock.destroy();
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

test('A2：CONNECT 认证失败时换下一条', async () => {
  const echo = await startEcho();
  const auth = await startAuthProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    attemptTimeoutMs: 1000,
    log: silentLog
  });
  const addr = await d.listen();
  try {
    const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
    const got = await echoOnce(sock, 'auth-fallback');
    assert.equal(got, 'auth-fallback');
    assert.equal(auth.connectCount(), 1);
    sock.destroy();
  } finally {
    await d.close();
    await auth.close();
    await echo.close();
  }
});
