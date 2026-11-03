import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDispatcher } from '../src/server.js';
import { startTarget, startHopTarget, startFakeProxy, startCountingProxy, startAuthProxy, startSilent, startResetProxy, startStatusTarget, startFlakyProxy, startBrokenTarget, closedPort, httpVia, requestVia } from './helpers.js';

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

test('HTTP：网关黑洞时按超时换路，不会永久挂住', async () => {
  const target = await startTarget();
  const stalled = await startSilent();
  const proxy = await startFakeProxy('next');
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: stalled.port,
    gateways: ['127.0.0.1:' + proxy.port],
    attemptTimeoutMs: 1200,
    fastFailTimeoutMs: 200,
    responseTimeoutMs: 200,
    log: silent
  });
  const addr = await d.listen();
  try {
    d.pref.set('127.0.0.1', '127.0.0.1:' + stalled.port);
    const started = Date.now();
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/timeout');
    const elapsed = Date.now() - started;
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-via'], 'next');
    assert.ok(elapsed < 900, '应快速超时换路，实际 ' + elapsed + 'ms');
    assert.equal(d.pref.get('127.0.0.1'), '127.0.0.1:' + proxy.port);
  } finally {
    await d.close();
    await proxy.close();
    await stalled.close();
    await target.close();
  }
});

test('HTTP：逐跳标头不转发，Host 重写为目标', async () => {
  const target = await startTarget();
  const dead = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: dead, attemptTimeoutMs: 500, log: silent });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/headers', {
      'proxy-connection': 'keep-alive',
      'x-custom': 'kept'
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-echo-host'], '127.0.0.1:' + target.port);
    assert.equal(r.headers['x-echo-proxy-connection'], '');
    assert.equal(r.headers['x-echo-custom'], 'kept');
  } finally {
    await d.close();
    await target.close();
  }
});

test('HTTP：上游响应中途断开不会带崩进程', async () => {
  const broken = await startBrokenTarget();
  const dead = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: dead, attemptTimeoutMs: 500, log: silent });
  const addr = await d.listen();
  try {
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: addr.port,
        path: 'http://127.0.0.1:' + broken.port + '/broken'
      }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
        res.on('error', resolve);
        res.on('aborted', resolve);
      });
      req.on('error', resolve);
      req.end();
      setTimeout(resolve, 800);
    });
    // 若上游的 error 没有被兜住，这里的未捕获异常会让整个测试进程失败
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await d.close();
    await broken.close();
  }
});

test('HTTP：响应方向的逐跳标头也会被清掉', async () => {
  const target = await startHopTarget();
  const dead = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: dead, attemptTimeoutMs: 500, log: silent });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/resp');
    assert.equal(r.status, 200);
    assert.equal(r.headers['proxy-connection'], undefined, '上游的 proxy-connection 不应透传');
    // keep-alive 由本代理的 ServerResponse 自己添加，不能作为透传依据
    assert.equal(r.headers['x-custom'], 'kept');
  } finally {
    await d.close();
    await target.close();
  }
});

// ---- 0.6.0 非幂等重放策略（SPEC 第八节 I1–I18） ----

const NOT_REPLAYED = 'non-idempotent request may have been delivered; not replayed';

function retryConfig(extra = {}) {
  return Object.assign({
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: 1,
    gateways: [],
    healthUrl: '',
    healthIntervalMs: 0,
    fastFailTimeoutMs: 100,
    cooldownMs: 0,
    retryNonIdempotentAfterSend: false,
    attemptTimeoutMs: 500,
    responseTimeoutMs: 200,
    log: silent
  }, extra);
}

async function withDispatcher(options, fn) {
  const d = createDispatcher(options);
  const addr = await d.listen();
  try {
    return await fn(d, addr);
  } finally {
    await d.close();
  }
}

test('I1：直连 silent 目标，POST 未重放', async () => {
  const silentTarget = await startSilent();
  const dead = await closedPort();
  try {
    await withDispatcher(retryConfig({ upstreamPort: dead }), async (d, addr) => {
      const started = Date.now();
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + silentTarget.port + '/x', {
        method: 'POST', body: 'payload'
      });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.ok(Date.now() - started < 1200, '不应重试多次');
    });
  } finally {
    await silentTarget.close();
  }
});

test('I2：silent 网关在前，POST 不碰第二个代理', async () => {
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    await withDispatcher(retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + proxy.port] }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('I2b：不传重放开关时，运行期默认仍为 false', async () => {
  // 不显式传 retryNonIdempotentAfterSend，锁住 mergeOptions 的运行期默认值
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({
      upstreamPort: stalled.port,
      gateways: ['127.0.0.1:' + proxy.port]
    });
    delete cfg.retryNonIdempotentAfterSend;
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('I3：建连前失败，POST 正常重放到第二个代理', async () => {
  const target = await startTarget();
  const dead = await closedPort();
  const proxy = await startCountingProxy('second');
  try {
    await withDispatcher(retryConfig({ upstreamPort: dead, gateways: ['127.0.0.1:' + proxy.port] }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/echo', {
        method: 'POST', body: 'payload-123'
      });
      assert.equal(r.status, 200);
      assert.equal(r.body, 'target:POST:payload-123');
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('I4：silent 网关在前，GET 仍重放', async () => {
  const target = await startTarget();
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    await withDispatcher(retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + proxy.port] }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/get');
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-via'], 'second');
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await stalled.close();
    await target.close();
  }
});

test('I5：PUT 带请求体重放，body 一致', async () => {
  const target = await startTarget();
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    await withDispatcher(retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + proxy.port] }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/put', {
        method: 'PUT', body: 'payload-put'
      });
      assert.equal(r.status, 200);
      assert.equal(r.body, 'target:PUT:payload-put');
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await stalled.close();
    await target.close();
  }
});

test('I6：DELETE 重放', async () => {
  const target = await startTarget();
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    await withDispatcher(retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + proxy.port] }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/del', { method: 'DELETE' });
      assert.equal(r.status, 200);
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await stalled.close();
    await target.close();
  }
});

test('I7：PATCH 在 sent 后不重放', async () => {
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    await withDispatcher(retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + proxy.port] }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/patch', { method: 'PATCH', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('I8：开关打开后 POST 恢复重放', async () => {
  const target = await startTarget();
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({
      upstreamPort: stalled.port,
      gateways: ['127.0.0.1:' + proxy.port],
      retryNonIdempotentAfterSend: true
    });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/retry', {
        method: 'POST', body: 'payload'
      });
      assert.equal(r.status, 200);
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await stalled.close();
    await target.close();
  }
});

test('I8b：开关打开时，所有候选发送后失败仍回 all gateways failed', async () => {
  const first = await startSilent();
  const second = await startSilent();
  try {
    const cfg = retryConfig({
      upstreamPort: first.port,
      gateways: ['127.0.0.1:' + second.port],
      retryNonIdempotentAfterSend: true
    });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, 'all gateways failed');
      assert.notEqual(r.body, NOT_REPLAYED);
    });
  } finally {
    await second.close();
    await first.close();
  }
});

test('I9：死端口 → silent → 可用代理，POST 在第二个候选处停止', async () => {
  const dead = await closedPort();
  const stalled = await startSilent();
  const proxy = await startCountingProxy('third');
  try {
    const cfg = retryConfig({
      upstreamPort: dead,
      gateways: ['127.0.0.1:' + stalled.port, '127.0.0.1:' + proxy.port]
    });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('I10：所有候选都在建连前失败，POST 得到 all gateways failed', async () => {
  const dead1 = await closedPort();
  const dead2 = await closedPort();
  try {
    const cfg = retryConfig({ upstreamPort: dead1, gateways: ['127.0.0.1:' + dead2] });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, 'all gateways failed');
    });
  } finally { /* ports closed */ }
});

test('I11：上游 500 原样转发，不触发换路', async () => {
  const target = await startStatusTarget(500);
  const first = await startCountingProxy('first');
  const second = await startCountingProxy('second');
  try {
    const cfg = retryConfig({
      upstreamPort: first.port,
      gateways: ['127.0.0.1:' + second.port]
    });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/500', {
        method: 'POST', body: 'p'
      });
      assert.equal(r.status, 500);
      assert.equal(first.count(), 1);
      assert.equal(second.count(), 0);
    });
  } finally {
    await second.close();
    await first.close();
    await target.close();
  }
});

test('I12：所有候选 silent，GET 得到 all gateways failed', async () => {
  const first = await startSilent();
  const second = await startSilent();
  try {
    const cfg = retryConfig({
      upstreamPort: first.port,
      gateways: ['127.0.0.1:' + second.port]
    });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/get');
      assert.equal(r.status, 502);
      assert.equal(r.body, 'all gateways failed');
    });
  } finally {
    await second.close();
    await first.close();
  }
});

test('I13：日志含 not replayed，不含请求体', async () => {
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  const logs = [];
  try {
    const cfg = retryConfig({
      upstreamPort: stalled.port,
      gateways: ['127.0.0.1:' + proxy.port],
      log: (msg) => logs.push(msg)
    });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', {
        method: 'POST', body: 'SENTINEL-BODY'
      });
      assert.equal(r.status, 502);
      assert.equal(proxy.count(), 0);
    });
    const joined = logs.join('\n');
    assert.match(joined, /not replayed/);
    assert.ok(!joined.includes('SENTINEL-BODY'), '日志不应包含请求体');
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('I14：停止前仍然给失败网关记账（冷却）', async () => {
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({
      upstreamPort: stalled.port,
      gateways: ['127.0.0.1:' + proxy.port],
      cooldownMs: 30000
    });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(d.isCooling('127.0.0.1:' + stalled.port), true);
    });
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('I15：连接建立后立即断开，POST 不重放', async () => {
  const reset = await startResetProxy();
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({ upstreamPort: reset.port, gateways: ['127.0.0.1:' + proxy.port] });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await reset.close();
  }
});

test('I16：连接建立后立即断开，GET 仍重放', async () => {
  const target = await startTarget();
  const reset = await startResetProxy();
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({ upstreamPort: reset.port, gateways: ['127.0.0.1:' + proxy.port] });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/get');
      assert.equal(r.status, 200);
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await reset.close();
    await target.close();
  }
});

test('I17：空 body 的 POST 仍按非幂等处理', async () => {
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + proxy.port] });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'POST' });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('I18：未列入幂等集合的扩展方法按非幂等处理', async () => {
  // Node 的 llhttp 不接受自造方法 FOO（直接 400），用 WebDAV 的 PROPFIND 代表“扩展方法”；
  // FOO 的分类在 retry-policy 的纯函数单测里覆盖。
  const stalled = await startSilent();
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + proxy.port] });
    await withDispatcher(cfg, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:9/x', { method: 'PROPFIND', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await stalled.close();
  }
});

test('K1：keep-alive 复用 socket 视为已发送，POST 不重放', async () => {
  const target = await startTarget();
  const flaky = await startFlakyProxy('flaky');
  const proxy = await startCountingProxy('second');
  try {
    const cfg = retryConfig({ upstreamPort: flaky.port, gateways: ['127.0.0.1:' + proxy.port] });
    await withDispatcher(cfg, async (d, addr) => {
      const first = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/warm');
      assert.equal(first.status, 200);
      const second = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/post', {
        method: 'POST', body: 'p'
      });
      assert.equal(second.status, 502);
      assert.equal(second.body, NOT_REPLAYED);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await flaky.close();
    await target.close();
  }
});

// ---- 0.7.0 上游代理认证（A3/A4/A4b/A4c/A6b/A7） ----

const AUTH_HEADER = 'Basic ' + Buffer.from('alice:secret').toString('base64');

test('A3：普通 HTTP 经需认证的代理，转发成功且目标看不到凭证', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    upstreamAuth: AUTH_HEADER,
    attemptTimeoutMs: 1000,
    log: silent
  });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/auth');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-via'], 'auth');
    assert.equal(r.headers['x-echo-proxy-authorization'], '');
    assert.equal(auth.plainCount(), 1);
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

test('A4：普通 HTTP 代理返回 407 时不转发，换下一条', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    attemptTimeoutMs: 1000,
    log: silent
  });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/no-auth');
    assert.equal(r.status, 200, '应回退到直连，而不是把 407 转给客户端');
    assert.equal(r.headers['x-via'], undefined);
    assert.equal(auth.plainCount(), 1);
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

test('A4b：407 + POST 继续下一条，不走非幂等停止', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    attemptTimeoutMs: 1000,
    responseTimeoutMs: 200,
    log: silent
  });
  const addr = await d.listen();
  try {
    const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/post', {
      method: 'POST', body: 'payload'
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'target:POST:payload');
    assert.equal(auth.plainCount(), 1);
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

test('A4c：direct 目标自己的 407 原样转发', async () => {
  const target = await startStatusTarget(407);
  const dead = await closedPort();
  const d = createDispatcher({ listenPort: 0, upstreamPort: dead, attemptTimeoutMs: 500, log: silent });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/direct-407');
    assert.equal(r.status, 407);
    assert.equal(r.body, 'status:407');
  } finally {
    await d.close();
    await target.close();
  }
});

test('A6b：plain HTTP 健康检查经需认证代理，首选正确', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    upstreamAuth: AUTH_HEADER,
    healthUrl: 'http://127.0.0.1:' + target.port + '/health',
    healthIntervalMs: 60000,
    healthTimeoutMs: 1000,
    log: silent
  });
  await d.listen();
  try {
    d.startHealth();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(d.pref.get('127.0.0.1'), '127.0.0.1:' + auth.port);
    assert.ok(auth.connectCount() >= 1);
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

test('A7：认证失败日志不含 user/pass/Basic', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy({ password: 'other' });
  const messages = [];
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    upstreamAuth: AUTH_HEADER,
    attemptTimeoutMs: 1000,
    log: (msg) => messages.push(msg)
  });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/log');
    assert.equal(r.status, 200);
    const text = messages.join('\n');
    assert.ok(!text.includes('alice'));
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('Basic'));
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

test('A5：gateways 与 upstream 同 host:port 的 auth 合并后端到端生效', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy();
  const d = createDispatcher({
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: auth.port,
    gateways: ['http://alice:secret@127.0.0.1:' + auth.port],
    attemptTimeoutMs: 1000,
    log: silent
  });
  const addr = await d.listen();
  try {
    const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/merged');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-via'], 'auth');
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

test('A6c：健康检查认证失败时不把该代理设为首选', async () => {
  const target = await startTarget();
  const auth = await startAuthProxy({ password: 'other' });
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: auth.port,
    upstreamAuth: AUTH_HEADER,
    healthUrl: 'http://127.0.0.1:' + target.port + '/health',
    healthIntervalMs: 60000,
    healthTimeoutMs: 1000,
    log: silent
  });
  await d.listen();
  try {
    d.startHealth();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.notEqual(d.pref.get('127.0.0.1'), '127.0.0.1:' + auth.port);
  } finally {
    await d.close();
    await auth.close();
    await target.close();
  }
});

// ---- 0.7.0 带幂等键的发送后重放（P1–P5、A7b） ----

test('P1/P2：无键或键开关关闭时，POST 发送后失败仍不重放', async () => {
  const stalled = await startSilent();
  const second = await startCountingProxy('second');
  const target = await startTarget();
  try {
    for (const [label, options] of [
      ['无键', {}],
      ['有键但开关关', { headers: { 'Idempotency-Key': 'key-1' } }]
    ]) {
      await withDispatcher(retryConfig({ upstreamPort: stalled.port, gateways: ['127.0.0.1:' + second.port] }), async (d, addr) => {
        const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/p1', {
          method: 'POST', body: 'p', ...options
        });
        assert.equal(r.status, 502, label);
        assert.equal(r.body, NOT_REPLAYED, label);
      });
    }
    assert.equal(second.count(), 0);
  } finally {
    await second.close();
    await stalled.close();
    await target.close();
  }
});

test('P3/P5：带键且开关打开时，发送后失败换下一条并转发键', async () => {
  const stalled = await startSilent();
  const second = await startCountingProxy('second');
  const target = await startTarget();
  try {
    await withDispatcher(retryConfig({
      upstreamPort: stalled.port,
      gateways: ['127.0.0.1:' + second.port],
      retryNonIdempotentWithIdempotencyKey: true
    }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/p3', {
        method: 'POST',
        body: 'payload',
        headers: { 'Idempotency-Key': 'key-123' }
      });
      assert.equal(r.status, 200);
      assert.equal(r.body, 'target:POST:payload');
      assert.equal(r.headers['x-echo-idempotency-key'], 'key-123');
      assert.equal(second.count(), 1);
    });
  } finally {
    await second.close();
    await stalled.close();
    await target.close();
  }
});

test('P4：键为空/空白时即使开关打开也不重放', async () => {
  const stalled = await startSilent();
  const second = await startCountingProxy('second');
  const target = await startTarget();
  try {
    for (const value of ['', '   ']) {
      await withDispatcher(retryConfig({
        upstreamPort: stalled.port,
        gateways: ['127.0.0.1:' + second.port],
        retryNonIdempotentWithIdempotencyKey: true
      }), async (d, addr) => {
        const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/p4', {
          method: 'POST', body: 'p', headers: { 'Idempotency-Key': value }
        });
        assert.equal(r.status, 502);
        assert.equal(r.body, NOT_REPLAYED);
      });
    }
    assert.equal(second.count(), 0);
  } finally {
    await second.close();
    await stalled.close();
    await target.close();
  }
});

test('A7b：重放日志含“idempotency key”，不含键值', async () => {
  const stalled = await startSilent();
  const second = await startCountingProxy('second');
  const target = await startTarget();
  const messages = [];
  try {
    await withDispatcher(retryConfig({
      upstreamPort: stalled.port,
      gateways: ['127.0.0.1:' + second.port],
      retryNonIdempotentWithIdempotencyKey: true,
      log: (msg) => messages.push(msg)
    }), async (d, addr) => {
      const r = await requestVia(addr.port, 'http://127.0.0.1:' + target.port + '/log', {
        method: 'POST', body: 'p', headers: { 'Idempotency-Key': 'secret-key-value' }
      });
      assert.equal(r.status, 200);
    });
    const text = messages.join('\n');
    assert.ok(text.includes('idempotency key'));
    assert.ok(!text.includes('secret-key-value'));
  } finally {
    await second.close();
    await stalled.close();
    await target.close();
  }
});
