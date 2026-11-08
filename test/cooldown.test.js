import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDispatcher } from '../src/server.js';
import {
  connectDirectDetailed,
  connectViaProxyDetailed,
  probeTlsDetailed
} from '../src/paths.js';
import {
  startSilent,
  startAuthProxy,
  startRejectConnectProxy,
  startResetProxy,
  startFakeProxy,
  startTarget,
  startBrokenTarget,
  startEcho,
  closedPort,
  httpVia,
  tunnelVia
} from './helpers.js';

const silent = () => {};

async function withDispatcher(options, fn, internals = {}) {
  const d = createDispatcher(Object.assign({ listenPort: 0, log: silent }, options), internals);
  const addr = await d.listen();
  try {
    return await fn(d, addr);
  } finally {
    await d.close();
  }
}

function requestRaw(proxyPort, url) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: url,
      headers: { host: new URL(url).host }
    }, (res) => {
      res.resume();
      res.on('end', resolve);
      res.on('aborted', resolve);
      res.on('error', resolve);
    });
    req.on('error', resolve);
    req.end();
    setTimeout(resolve, 800);
  });
}

test('R8：direct 等头超时只冷却该 host，不冷却其他 host', async () => {
  const stalled = await startSilent();
  const dead = await closedPort();
  try {
    await withDispatcher({
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      responseTimeoutMs: 200,
      cooldownMs: 30000
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + stalled.port + '/x');
      assert.equal(r.status, 502);
      assert.equal(d.isCooling('direct', '127.0.0.1'), true);
      assert.equal(d.isCooling('direct', 'localhost'), false);
    });
  } finally {
    await stalled.close();
  }
});

test('R9b：direct 建连前失败只冷却该 host', async () => {
  const deadTarget = await closedPort();
  const deadUpstream = await closedPort();
  try {
    await withDispatcher({
      upstreamPort: deadUpstream,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + deadTarget + '/x');
      assert.equal(r.status, 502);
      assert.equal(d.isCooling('direct', '127.0.0.1'), true);
      assert.equal(d.isCooling('direct', 'localhost'), false);
    });
  } finally {
    // deadTarget 只是 closedPort() 返回的端口号，无需关闭
  }
});

test('R9：silent 代理全局冷却（新 host 不会先撞它）', async () => {
  const stalled = await startSilent();
  const target = await startTarget();
  try {
    await withDispatcher({
      upstreamPort: stalled.port,
      attemptTimeoutMs: 500,
      responseTimeoutMs: 200,
      cooldownMs: 30000
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/x');
      assert.equal(r.status, 200, '应回退到直连');
      assert.equal(d.isCooling('127.0.0.1:' + stalled.port), true);
      assert.equal(d.isCooling('127.0.0.1:' + stalled.port, 'localhost'), true);
    });
  } finally {
    await stalled.close();
    await target.close();
  }
});

test('R9/R10：代理建连失败与 407 都全局冷却', async () => {
  const deadProxy = await closedPort();
  const auth = await startAuthProxy();
  const target = await startTarget();
  try {
    await withDispatcher({
      upstreamPort: deadProxy,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/x');
      assert.equal(r.status, 200);
      assert.equal(d.isCooling('127.0.0.1:' + deadProxy), true);
    });
    await withDispatcher({
      upstreamPort: auth.port,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/x');
      assert.equal(r.status, 200);
      assert.equal(d.isCooling('127.0.0.1:' + auth.port), true);
    });
  } finally {
    await auth.close();
    await target.close();
  }
});

test('R9c：代理 CONNECT 到目标失败只冷却该 host', async () => {
  const reject = await startRejectConnectProxy(502);
  const echo = await startEcho();
  try {
    await withDispatcher({
      upstreamPort: reject.port,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
      sock.destroy();
      assert.equal(d.isCooling('127.0.0.1:' + reject.port, '127.0.0.1'), true);
      assert.equal(d.isCooling('127.0.0.1:' + reject.port, 'localhost'), false);
    });
  } finally {
    await reject.close();
    await echo.close();
  }
});

test('R20：direct 响应头前 reset 只冷却该 host，phase 为 direct-reset', async () => {
  const reset = await startResetProxy();
  const dead = await closedPort();
  const logs = [];
  try {
    await withDispatcher({
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      cooldownMs: 30000,
      log: (msg) => logs.push(msg)
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + reset.port + '/x');
      assert.equal(r.status, 502);
      assert.equal(d.isCooling('direct', '127.0.0.1'), true);
      assert.equal(d.isCooling('direct', 'localhost'), false);
      assert.ok(logs.some((msg) => msg.includes('direct-reset')), '日志应包含 direct-reset phase');
    });
  } finally {
    await reset.close();
  }
});

test('R20b：收到响应头后的流式中断不记冷却', async () => {
  const broken = await startBrokenTarget();
  const dead = await closedPort();
  try {
    await withDispatcher({
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      await requestRaw(addr.port, 'http://127.0.0.1:' + broken.port + '/broken');
      assert.equal(d.isCooling('direct', '127.0.0.1'), false);
      assert.equal(d.isCooling('direct', 'localhost'), false);
    });
  } finally {
    await broken.close();
  }
});

test('R18：健康检查成功只清 health.host 的 host 冷却', async () => {
  const stalled = await startSilent();
  const healthTarget = await startTarget();
  const dead = await closedPort();
  try {
    await withDispatcher({
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      responseTimeoutMs: 200,
      cooldownMs: 30000,
      healthUrl: 'http://localhost:' + healthTarget.port + '/health',
      healthIntervalMs: 0,
      healthTimeoutMs: 1000
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + stalled.port + '/x');
      assert.equal(r.status, 502);
      assert.equal(d.isCooling('direct', '127.0.0.1'), true);
      await d.runHealth();
      assert.equal(d.getPreferred(), 'direct');
      assert.equal(d.isCooling('direct', '127.0.0.1'), true, '其他 host 的冷却不应被健康检查清掉');
      assert.equal(d.isCooling('direct', 'localhost'), false);
    });
  } finally {
    await stalled.close();
    await healthTarget.close();
  }
});

test('R9e：代理响应头前 reset 全局冷却', async () => {
  const reset = await startResetProxy();
  const target = await startTarget();
  try {
    await withDispatcher({
      upstreamPort: reset.port,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/x');
      assert.equal(r.status, 200, '应回退到直连');
      assert.equal(d.isCooling('127.0.0.1:' + reset.port), true);
    });
  } finally {
    await reset.close();
    await target.close();
  }
});

test('R8b：direct TLS 失败只冷却该 host 的 direct', async () => {
  const echo = await startEcho();
  const dead = await closedPort();
  try {
    await withDispatcher({
      upstreamPort: dead,
      verifyTls: true,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      await assert.rejects(() => tunnelVia(addr.port, '127.0.0.1', echo.port), /CONNECT failed/);
      assert.equal(d.isCooling('direct', '127.0.0.1'), true);
      assert.equal(d.isCooling('direct', 'localhost'), false);
    }, { tlsProbePort: echo.port });
  } finally {
    await echo.close();
  }
});

test('R8c：proxy TLS 失败只冷却该 host 的该代理', async () => {
  const proxy = await startFakeProxy('proxy');
  const echo = await startEcho();
  try {
    await withDispatcher({
      upstreamPort: proxy.port,
      verifyTls: true,
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      await assert.rejects(() => tunnelVia(addr.port, '127.0.0.1', echo.port), /CONNECT failed/);
      assert.equal(d.isCooling('127.0.0.1:' + proxy.port, '127.0.0.1'), true);
      assert.equal(d.isCooling('127.0.0.1:' + proxy.port, 'localhost'), false);
    }, { tlsProbePort: echo.port });
  } finally {
    await proxy.close();
    await echo.close();
  }
});

test('R17b：规则命中但无 known 时首条用完整 attemptTimeoutMs', async () => {
  const echo = await startEcho();
  const dead = await closedPort();
  const attempts = [];
  try {
    await withDispatcher({
      upstreamPort: dead,
      preferDirect: ['127.0.0.1'],
      verifyTls: true,
      attemptTimeoutMs: 600,
      fastFailTimeoutMs: 100,
      cooldownMs: 30000
    }, async (d, addr) => {
      await assert.rejects(() => tunnelVia(addr.port, '127.0.0.1', echo.port), /CONNECT failed/);
      assert.ok(attempts.length > 0);
      assert.equal(attempts[0].timeout, 600, '规则不应制造 known/fast-fail');
      assert.equal(attempts[0].known, false);
    }, { tlsProbePort: echo.port, onAttempt: (attempt) => attempts.push(attempt) });
  } finally {
    await echo.close();
  }
});

test('R17：known 在冷却且不是首条时不启用 fast-fail', async () => {
  const deadProxy = await closedPort();
  const plainTarget = await startTarget();
  const echo = await startEcho();
  const attempts = [];
  try {
    await withDispatcher({
      upstreamPort: deadProxy,
      preferDirect: ['127.0.0.1'],
      verifyTls: true,
      attemptTimeoutMs: 600,
      fastFailTimeoutMs: 100,
      cooldownMs: 30000
    }, async (d, addr) => {
      // 用一个不命中规则的 host 让 deadProxy 进入全局冷却
      const cooled = await httpVia(addr.port, 'http://localhost:' + plainTarget.port + '/warm');
      assert.equal(cooled.status, 200);
      assert.equal(d.isCooling('127.0.0.1:' + deadProxy), true);
      d.pref.set('127.0.0.1', '127.0.0.1:' + deadProxy);

      attempts.length = 0;
      await assert.rejects(() => tunnelVia(addr.port, '127.0.0.1', echo.port), /CONNECT failed/);
      assert.ok(attempts.length > 0);
      assert.equal(attempts[0].timeout, 600, '冷却中的 known 不应让首条用 fast-fail');
      assert.equal(attempts[0].known, false);
    }, { tlsProbePort: echo.port, onAttempt: (attempt) => attempts.push(attempt) });
  } finally {
    await plainTarget.close();
    await echo.close();
  }
});

test('R19：phase 分类（proxy-connect/proxy-auth/proxy-response/proxy-reset/target-connect/direct-connect/tls）', async () => {
  const deadProxy = await closedPort();
  const deadDirect = await closedPort();
  const auth = await startAuthProxy();
  const silentProxy = await startSilent();
  const resetProxy = await startResetProxy();
  const reject = await startRejectConnectProxy(502);
  const echo = await startEcho();
  try {
    assert.equal((await connectViaProxyDetailed({ host: '127.0.0.1', port: deadProxy }, 'example.com', 443, 300)).phase, 'proxy-connect');
    assert.equal((await connectViaProxyDetailed({ host: '127.0.0.1', port: auth.port }, 'example.com', 443, 500)).phase, 'proxy-auth');
    assert.equal((await connectViaProxyDetailed({ host: '127.0.0.1', port: reject.port }, 'example.com', 443, 500)).phase, 'target-connect');
    assert.equal((await connectViaProxyDetailed({ host: '127.0.0.1', port: silentProxy.port }, 'example.com', 443, 200)).phase, 'proxy-response');
    assert.equal((await connectViaProxyDetailed({ host: '127.0.0.1', port: resetProxy.port }, 'example.com', 443, 500)).phase, 'proxy-reset');
    assert.equal((await connectDirectDetailed('127.0.0.1', deadDirect, 300)).phase, 'direct-connect');
    assert.deepEqual(
      await probeTlsDetailed((h, p) => connectDirectDetailed(h, p, 500), '127.0.0.1', echo.port, 500),
      { ok: false, phase: 'tls' }
    );
  } finally {
    await auth.close();
    await silentProxy.close();
    await resetProxy.close();
    await reject.close();
    await echo.close();
  }
});
