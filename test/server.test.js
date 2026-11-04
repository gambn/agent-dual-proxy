import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createDispatcher, mergeOptions, portHints, IDENTITY_HEADER, IDENTITY_PATH } from '../src/server.js';

const silent = () => {};

/** 65000 以上避开本机滚动 TIME-WAIT 常用的临时端口段。 */
function isFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function consecutiveHighPorts() {
  for (let port = 62000; port < 62900; port += 2) {
    if (await isFree(port) && await isFree(port + 1)) return port;
  }
  throw new Error('no consecutive free high ports');
}

test('mergeOptions：显式 undefined 不覆盖默认值', () => {
  const merged = mergeOptions({ prefTtlMs: 60000, attemptTimeoutMs: 5000 }, {
    prefTtlMs: undefined,
    attemptTimeoutMs: undefined
  });
  assert.equal(merged.prefTtlMs, 60000);
  assert.equal(merged.attemptTimeoutMs, 5000);
});

test('候选列表：上游与监听同端口时不会把自己当网关', () => {
  const d = createDispatcher({ listenPort: 7898, upstreamPort: 7898, log: silent });
  assert.deepEqual(d.candidates.map((gateway) => gateway.id), ['direct']);
  d.close();
});

test('候选公开视图：不暴露 auth（C1b）', () => {
  const d = createDispatcher({
    listenPort: 7898,
    upstreamHost: '127.0.0.1',
    upstreamPort: 7897,
    upstreamAuth: 'Basic c2VjcmV0',
    log: silent
  });
  assert.deepEqual(d.candidates[0], { id: '127.0.0.1:7897', host: '127.0.0.1', port: 7897 });
  assert.ok(!Object.prototype.hasOwnProperty.call(d.candidates[0], 'auth'));
  d.close();
});

test('listen：保留一个持久 error 监听，双 emit 不抛，端口占用仍 reject', async () => {
  const first = createDispatcher({ listenPort: 0, log: silent });
  const addr = await first.listen();
  try {
    assert.equal(first.server.listenerCount('error'), 1, '应保留持久日志监听');
    assert.doesNotThrow(() => {
      first.server.emit('error', new Error('first'));
      first.server.emit('error', new Error('second'));
    }, '连续两次 error 不应抛出');

    const second = createDispatcher({ listenPort: addr.port, log: silent });
    await assert.rejects(() => second.listen(), /EADDRINUSE/);
    await second.close();
  } finally {
    await first.close();
  }
});

test('身份端点：GET /__agent_dual_proxy__ 返回本代理标记', async () => {
  const d = createDispatcher({ listenPort: 0, log: silent });
  const addr = await d.listen();
  try {
    const result = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: addr.port, path: IDENTITY_PATH, agent: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers[IDENTITY_HEADER], '1');
    assert.equal(result.body.trim(), 'agent-dual-proxy');
  } finally {
    await d.close();
  }
});

test('listen：端口占用时按 portFallback 自动退避并返回实际端口', async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const busy = holder.address().port;
  const d = createDispatcher({ listenPort: busy, portFallback: 5, log: silent });
  try {
    const addr = await d.listen();
    assert.notEqual(addr.port, busy);
    assert.ok(addr.port > busy && addr.port <= busy + 5, '应落在退避范围内');
  } finally {
    await d.close();
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('listen：EADDRINUSE 诊断区分 LISTEN 冲突', async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const busy = holder.address().port;
  const d = createDispatcher({ listenPort: busy, portFallback: 0, log: silent });
  try {
    await assert.rejects(() => d.listen(), (err) => {
      assert.equal(err.code, 'EADDRINUSE');
      assert.match(err.message, /a process is listening/);
      assert.match(err.message, /--listen-port/);
      return true;
    });
  } finally {
    await d.close();
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('listen：TIME-WAIT 诊断分支（注入探测）', async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const busy = holder.address().port;
  const d = createDispatcher({
    listenPort: busy,
    portFallback: 0,
    log: silent,
    listenProbe: async () => 'timewait'
  });
  try {
    await assert.rejects(() => d.listen(), (err) => {
      assert.match(err.message, /nothing is listening/);
      assert.match(err.message, /TIME-WAIT/);
      assert.match(err.message, /--port-fallback/);
      return true;
    });
  } finally {
    await d.close();
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('portHints：Windows 用 Get-NetTCPConnection，其他平台用 ss', () => {
  assert.match(portHints(7898, 'win32').listen, /Get-NetTCPConnection -LocalPort 7898 -State Listen/);
  assert.match(portHints(7898, 'win32').all, /Get-NetTCPConnection -LocalPort 7898/);
  assert.match(portHints(7898, 'linux').listen, /ss -tln \| grep :7898/);
  assert.match(portHints(7898, 'linux').all, /ss -tan \| grep :7898/);
});

test('listen：退避耗尽后的文案提示 increase，而不是 enable', async () => {
  const base = await consecutiveHighPorts();
  const first = net.createServer();
  const second = net.createServer();
  await new Promise((resolve) => first.listen(base, '127.0.0.1', resolve));
  await new Promise((resolve) => second.listen(base + 1, '127.0.0.1', resolve));
  const d = createDispatcher({
    listenPort: base,
    portFallback: 1,
    log: silent,
    listenProbe: async () => 'timewait'
  });
  try {
    await assert.rejects(() => d.listen(), (err) => {
      assert.match(err.message, /Increase --port-fallback/);
      return true;
    });
  } finally {
    await d.close();
    await new Promise((resolve) => first.close(resolve));
    await new Promise((resolve) => second.close(resolve));
  }
});

test('listen：探测不确定时两种提示都给出', async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const busy = holder.address().port;
  const d = createDispatcher({
    listenPort: busy,
    portFallback: 0,
    log: silent,
    listenProbe: async () => 'unknown'
  });
  try {
    await assert.rejects(() => d.listen(), (err) => {
      assert.match(err.message, /may be listening/);
      assert.match(err.message, /may block/);
      return true;
    });
  } finally {
    await d.close();
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('listen：退避后实际端口不再出现在候选里（自环防护）', async () => {
  const base = await consecutiveHighPorts();
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(base, '127.0.0.1', resolve));
  const d = createDispatcher({
    listenPort: base,
    portFallback: 1,
    upstreamPort: 1,
    gateways: ['127.0.0.1:' + (base + 1)],
    log: silent
  });
  try {
    const addr = await d.listen();
    assert.equal(addr.port, base + 1);
    const ids = d.candidates.map((candidate) => candidate.id);
    assert.ok(!ids.includes('127.0.0.1:' + (base + 1)), '实际监听端口不应作为候选');
    assert.ok(ids.includes('127.0.0.1:1'));
    assert.ok(ids.includes('direct'));
  } finally {
    await d.close();
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('healthUrl 非法时按未配置处理，不抛', () => {
  const d = createDispatcher({ listenPort: 0, healthUrl: 'not a url', log: silent });
  assert.equal(d.server.listening, false);
  d.close();
});

test('HTTP 入口：非法 target 与 https:// target 都回 400', async () => {
  const d = createDispatcher({ listenPort: 0, upstreamPort: 1, log: silent });
  const addr = await d.listen();
  const raw = (line) => new Promise((resolve, reject) => {
    const sock = net.connect(addr.port, '127.0.0.1', () => {
      sock.write(line + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (chunk) => { buf += chunk; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
  try {
    assert.match(await raw('GET not-a-url'), /^HTTP\/1\.1 400/);
    assert.match(await raw('GET https://example.com/'), /^HTTP\/1\.1 400/);
  } finally {
    await d.close();
  }
});
