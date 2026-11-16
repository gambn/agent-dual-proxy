import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../src/server.js';
import {
  parseProcNet,
  isPrivateTarget,
  probeProxy,
  checkIdentity,
  discoverLocalProxies,
  IDENTITY_HEADER
} from '../src/discovery.js';
import {
  startStatusTunnelProxy,
  startRejectConnectProxy,
  startSilent,
  startTarget,
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

function lineForProc(port, address = '0100007F', state = '0A') {
  return ' 0: ' + address + ':' + port.toString(16).toUpperCase().padStart(4, '0') +
    ' 00000000:0000 ' + state + ' 00000000:00000000 00:00000000 00000000 1000 0 1';
}

function requestVia(port, url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: url,
      method,
      headers: { host: new URL(url).host }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('discovery：解析 /proc/net/tcp 与 tcp6，只保留 LISTEN 回环/通配', () => {
  const tcp = [
    'header',
    lineForProc(7897),
    lineForProc(7898, '00000000'),
    lineForProc(7899, '0100007F', '01'),
    lineForProc(7900, '3600007F')
  ].join('\n');
  assert.deepEqual(parseProcNet(tcp, 'tcp'), [
    { host: '127.0.0.1', port: 7897, wildcard: false },
    { host: '127.0.0.1', port: 7898, wildcard: true }
  ]);

  const tcp6 = [
    'header',
    lineForProc(7897, '00000000000000000000000001000000'),
    lineForProc(7898, '00000000000000000000000000000000')
  ].join('\n');
  assert.deepEqual(parseProcNet(tcp6, 'tcp6'), [
    { host: '::1', port: 7897, wildcard: false },
    { host: '::1', port: 7898, wildcard: true }
  ]);

  const other6 = ['header', lineForProc(7897, '20010DB8000000000000000000000001')].join('\n');
  assert.deepEqual(parseProcNet(other6, 'tcp6'), []);
});

test('discovery：isPrivateTarget 覆盖回环/私网/域名边界', () => {
  for (const host of [
    '127.0.0.1', 'localhost', '10.1.2.3', '172.16.0.1', '192.168.1.1',
    '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1',
    'foo.local', 'bar.internal', 'x.lan', 'x.home.arpa'
  ]) {
    assert.equal(isPrivateTarget(host), true, host);
  }
  for (const host of ['api.openai.com', '8.8.8.8', '2001:4860:4860::8888', '', '[::1]']) {
    assert.equal(isPrivateTarget(host), host === '' || host === '[::1]');
  }
});

test('discovery：/proc 解析跳过坏行、非法端口和非法 IPv6', () => {
  const text = [
    'header',
    'short line',
    ' 0: 0100007F:ZZZZ 00000000:0000 0A 00000000:00000000',
    ' 0: :1ED9 00000000:0000 0A 00000000:00000000',
    ' 0: 0100007F:0000 00000000:0000 0A 00000000:00000000',
    ' 0: 0100007F:1ED9 00000000:0000 01 00000000:00000000'
  ].join('\n');
  assert.deepEqual(parseProcNet(text, 'tcp'), []);
  assert.deepEqual(parseProcNet('', 'tcp'), []);
  assert.deepEqual(parseProcNet(['header', lineForProc(1, 'ZZZZZZZZ')].join('\n'), 'tcp6'), []);
  assert.deepEqual(parseProcNet(['header', lineForProc(1, 'ZZZZZZZZ')].join('\n'), 'tcp'), []);
});

test('discovery：HTTP 探测按 <500 且非 407 接受，HTTPS 只接受 2xx', async () => {
  for (const status of [200, 301, 401, 403, 404]) {
    const proxy = await startStatusTunnelProxy(status);
    try {
      const result = await probeProxy({
        proxyHost: '127.0.0.1', proxyPort: proxy.port,
        targetHost: 'dead.invalid', targetPort: 80, secure: false, timeoutMs: 800
      });
      assert.equal(result.ok, true, 'HTTP ' + status);
    } finally { await proxy.close(); }
  }
  for (const status of [407, 500]) {
    const proxy = await startStatusTunnelProxy(status);
    try {
      const result = await probeProxy({
        proxyHost: '127.0.0.1', proxyPort: proxy.port,
        targetHost: 'dead.invalid', targetPort: 80, secure: false, timeoutMs: 800
      });
      assert.equal(result.ok, false, 'HTTP ' + status);
    } finally { await proxy.close(); }
  }

  const ok = await startStatusTunnelProxy(200);
  const bad = await startRejectConnectProxy(407);
  const bad500 = await startRejectConnectProxy(500);
  const dead = await closedPort();
  try {
    assert.equal((await probeProxy({
      proxyHost: '127.0.0.1', proxyPort: ok.port,
      targetHost: 'dead.invalid', targetPort: 443, secure: true, timeoutMs: 800
    })).ok, true);
    assert.equal((await probeProxy({
      proxyHost: '127.0.0.1', proxyPort: bad.port,
      targetHost: 'dead.invalid', targetPort: 443, secure: true, timeoutMs: 800
    })).ok, false);
    assert.equal((await probeProxy({
      proxyHost: '127.0.0.1', proxyPort: bad500.port,
      targetHost: 'dead.invalid', targetPort: 443, secure: true, timeoutMs: 800
    })).ok, false);
    assert.equal((await probeProxy({
      proxyHost: '127.0.0.1', proxyPort: dead,
      targetHost: 'dead.invalid', targetPort: 443, secure: true, timeoutMs: 200
    })).ok, false);
    assert.equal((await probeProxy({
      proxyHost: '127.0.0.1', proxyPort: ok.port,
      targetHost: '::1', targetPort: 80, secure: false, timeoutMs: 800
    })).ok, true);
  } finally {
    await ok.close(); await bad.close(); await bad500.close();
  }
});

test('discovery：探测 socket write/destroy 异常和重复 finish 有兜底', async () => {
  function fake({ writeThrows = false, destroyThrows = false, twice = false } = {}) {
    const sock = new EventEmitter();
    sock.write = () => { if (writeThrows) throw new Error('write failed'); };
    sock.destroy = () => { if (destroyThrows) throw new Error('destroy failed'); };
    process.nextTick(() => {
      sock.emit('connect');
      if (!writeThrows) {
        sock.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
        if (twice) sock.emit('data', Buffer.from('HTTP/1.1 500 NOK\r\n\r\n'));
      }
    });
    return sock;
  }
  const base = { proxyHost: '127.0.0.1', proxyPort: 1, targetHost: 'dead.invalid', targetPort: 80, secure: false, timeoutMs: 200 };
  assert.equal((await probeProxy({ ...base, connect: () => fake({ writeThrows: true }) })).ok, false);
  assert.equal((await probeProxy({ ...base, connect: () => fake({ destroyThrows: true }) })).ok, true);
  assert.equal((await probeProxy({ ...base, connect: () => fake({ twice: true }) })).ok, true);
});

test('discovery：身份端点识别兄弟实例，连接失败/无响应回 false', async () => {
  const proxy = await startStatusTunnelProxy(200);
  const sibling = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { [IDENTITY_HEADER]: '1' });
    res.end('sibling');
  });
  const silentSockets = new Set();
  const silent = net.createServer((sock) => {
    silentSockets.add(sock);
    sock.on('close', () => silentSockets.delete(sock));
    sock.resume();
  });
  const truncatedSockets = new Set();
  const truncated = net.createServer((sock) => {
    truncatedSockets.add(sock);
    sock.on('close', () => truncatedSockets.delete(sock));
    sock.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort');
    setTimeout(() => sock.destroy(), 10);
  });
  await new Promise((resolve) => sibling.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => truncated.listen(0, '127.0.0.1', resolve));
  const dead = await closedPort();
  try {
    assert.equal(await checkIdentity('127.0.0.1', proxy.port, 500), false);
    assert.equal(await checkIdentity('127.0.0.1', sibling.address().port, 500), true);
    assert.equal(await checkIdentity('127.0.0.1', dead, 100), false);
    assert.equal(await checkIdentity('127.0.0.1', silent.address().port, 100), false);
    assert.equal(await checkIdentity('127.0.0.1', truncated.address().port, 500), false);
  } finally {
    await proxy.close();
    for (const sock of silentSockets) sock.destroy();
    for (const sock of truncatedSockets) sock.destroy();
    await new Promise((resolve) => sibling.close(resolve));
    await new Promise((resolve) => silent.close(resolve));
    await new Promise((resolve) => truncated.close(resolve));
  }
});

test('discovery：探测收到非 HTTP 响应/超大响应时拒绝', async () => {
  const garbageSockets = new Set();
  const hugeSockets = new Set();
  const garbage = net.createServer((sock) => {
    garbageSockets.add(sock);
    sock.on('close', () => garbageSockets.delete(sock));
    sock.write('garbage\r\n');
  });
  const huge = net.createServer((sock) => {
    hugeSockets.add(sock);
    sock.on('close', () => hugeSockets.delete(sock));
    sock.write('x'.repeat(17000));
  });
  await new Promise((resolve) => garbage.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => huge.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await probeProxy({
      proxyHost: '127.0.0.1', proxyPort: garbage.address().port,
      targetHost: 'dead.invalid', targetPort: 80, secure: false, timeoutMs: 300
    })).ok, false);
    assert.equal((await probeProxy({
      proxyHost: '127.0.0.1', proxyPort: huge.address().port,
      targetHost: 'dead.invalid', targetPort: 80, secure: false, timeoutMs: 300
    })).ok, false);
  } finally {
    for (const sock of garbageSockets) sock.destroy();
    for (const sock of hugeSockets) sock.destroy();
    await new Promise((resolve) => garbage.close(resolve));
    await new Promise((resolve) => huge.close(resolve));
  }
});

test('discovery：/proc 注入、排除端口、上限和探测筛选', async () => {
  const proxy = await startStatusTunnelProxy(200);
  const second = await startStatusTunnelProxy(200);
  const other = await startStatusTunnelProxy(500);
  const sibling = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { [IDENTITY_HEADER]: '1' });
    res.end('sibling');
  });
  await new Promise((resolve) => sibling.listen(0, '127.0.0.1', resolve));
  const text = ['header', lineForProc(proxy.port), lineForProc(second.port), lineForProc(other.port), lineForProc(sibling.address().port)].join('\n');
  const readFile = async (path) => path.endsWith('tcp6') ? '' : text;
  try {
    const result = await discoverLocalProxies({
      targetHost: 'dead.invalid', targetPort: 80, secure: false,
      excludePorts: new Set(), maxResults: 8, timeoutMs: 800, readFile
    });
    assert.equal(result.scanned, 4);
    assert.deepEqual(result.results.map((item) => item.port).sort((a, b) => a - b), [proxy.port, second.port].sort((a, b) => a - b));

    const excluded = await discoverLocalProxies({
      targetHost: 'dead.invalid', targetPort: 80, secure: false,
      excludePorts: new Set([proxy.port, second.port]), readFile
    });
    assert.deepEqual(excluded.results, []);

    const limited = await discoverLocalProxies({
      targetHost: 'dead.invalid', targetPort: 80, secure: false,
      limit: 1, readFile
    });
    assert.equal(limited.scanned, 1);
  } finally {
    await proxy.close();
    await second.close();
    await other.close();
    await new Promise((resolve) => sibling.close(resolve));
  }
});

test('discovery：非 Linux / 读不到 /proc / 缺少目标时返回空结果', async () => {
  const readFile = async () => { throw new Error('ENOENT'); };
  const result = await discoverLocalProxies({
    targetHost: 'dead.invalid', targetPort: 80, secure: false, readFile
  });
  assert.deepEqual(result, { scanned: 0, results: [] });
  assert.deepEqual(await discoverLocalProxies({ readFile }), { scanned: 0, results: [] });
});

test('discovery：启动发现异步注入候选，不抢占 preferred', async () => {
  const health = await startTarget();
  const proxy = await startStatusTunnelProxy(200);
  try {
    await withDispatcher({
      discoverLocalProxy: true,
      healthUrl: 'http://127.0.0.1:' + health.port + '/health',
      healthIntervalMs: 0
    }, async (d) => {
      for (let i = 0; i < 40 && !d.candidates.some((c) => c.port === proxy.port); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(d.candidates.some((c) => c.port === proxy.port), '应注入发现的代理');
      assert.equal(d.getPreferred(), null, '启动发现不应设置 preferred');
    }, {
      discoveryFind: async () => ({ scanned: 1, results: [{ host: '127.0.0.1', port: proxy.port, source: 'discovered' }] })
    });
  } finally {
    await health.close();
    await proxy.close();
  }
});

test('discovery：按目标失败触发发现并重试一次', async () => {
  const proxy = await startStatusTunnelProxy(200);
  const dead = await closedPort();
  let finds = 0;
  try {
    await withDispatcher({
      discoverLocalProxy: true,
      upstreamPort: dead,
      attemptTimeoutMs: 500
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://dead.invalid/');
      assert.equal(r.status, 200);
      assert.equal(finds, 1, '目标失败应触发一次发现');
    }, {
      startupDiscovery: false,
      discoveryFind: async () => {
        finds += 1;
        return { scanned: 1, results: [{ host: '127.0.0.1', port: proxy.port, source: 'discovered' }] };
      }
    });
  } finally {
    await proxy.close();
  }
});

test('discovery：健康直连成功、海外目标失败仍触发发现', async () => {
  const health = await startTarget();
  const proxy = await startStatusTunnelProxy(200);
  const dead = await closedPort();
  let finds = 0;
  try {
    await withDispatcher({
      discoverLocalProxy: true,
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      healthUrl: 'http://127.0.0.1:' + health.port + '/health',
      healthIntervalMs: 0,
      healthTimeoutMs: 800
    }, async (d, addr) => {
      await d.runHealth();
      assert.equal(d.getPreferred(), 'direct', '健康直连应先成功');
      const r = await httpVia(addr.port, 'http://dead.invalid/');
      assert.equal(r.status, 200);
      assert.equal(finds, 1, '健康未全失败时，海外目标失败仍应触发发现');
    }, {
      startupDiscovery: false,
      discoveryFind: async () => {
        finds += 1;
        return { scanned: 1, results: [{ host: '127.0.0.1', port: proxy.port, source: 'discovered' }] };
      }
    });
  } finally {
    await health.close();
    await proxy.close();
  }
});

test('discovery：非幂等已发送失败不因发现重试', async () => {
  const stalled = await startSilent();
  const proxy = await startStatusTunnelProxy(200);
  let finds = 0;
  try {
    await withDispatcher({
      discoverLocalProxy: true,
      upstreamPort: stalled.port,
      attemptTimeoutMs: 500,
      responseTimeoutMs: 200
    }, async (d, addr) => {
      const r = await requestVia(addr.port, 'http://dead.invalid/', { method: 'POST', body: 'p' });
      assert.equal(r.status, 502);
      assert.equal(r.body, 'non-idempotent request may have been delivered; not replayed');
      assert.equal(finds, 0, '已发送的非幂等失败不应触发发现重试');
    }, {
      startupDiscovery: false,
      discoveryFind: async () => {
        finds += 1;
        return { scanned: 1, results: [{ host: '127.0.0.1', port: proxy.port, source: 'discovered' }] };
      }
    });
  } finally {
    await stalled.close();
    await proxy.close();
  }
});

test('discovery：CONNECT 在建立前失败可按目标发现并重试', async () => {
  const proxy = await startStatusTunnelProxy(200);
  const dead = await closedPort();
  let finds = 0;
  try {
    await withDispatcher({
      discoverLocalProxy: true,
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      verifyTls: false
    }, async (d, addr) => {
      const sock = await tunnelVia(addr.port, 'dead.invalid', 443);
      sock.destroy();
      assert.equal(finds, 1);
    }, {
      startupDiscovery: false,
      discoveryFind: async () => {
        finds += 1;
        return { scanned: 1, results: [{ host: '127.0.0.1', port: proxy.port, source: 'discovered' }] };
      }
    });
  } finally {
    await proxy.close();
  }
});

test('discovery：健康全失败触发发现并复检为首选', async () => {
  const proxy = await startStatusTunnelProxy(200);
  const dead = await closedPort();
  let finds = 0;
  try {
    await withDispatcher({
      discoverLocalProxy: true,
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      healthUrl: 'http://dead.invalid/health',
      healthIntervalMs: 0,
      healthTimeoutMs: 800
    }, async (d) => {
      await d.runHealth();
      for (let i = 0; i < 60 && d.getPreferred() !== '127.0.0.1:' + proxy.port; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(finds, 1);
      assert.equal(d.getPreferred(), '127.0.0.1:' + proxy.port, '发现后应复检并设为 preferred');
    }, {
      startupDiscovery: false,
      discoveryFind: async () => {
        finds += 1;
        return { scanned: 1, results: [{ host: '127.0.0.1', port: proxy.port, source: 'discovered' }] };
      }
    });
  } finally {
    await proxy.close();
  }
});

test('discovery：TTL 到期移除发现项，不按失败次数删除', async () => {
  const proxy = await startStatusTunnelProxy(200);
  const target = await startTarget();
  const dead = await closedPort();
  try {
    await withDispatcher({
      discoverLocalProxy: true,
      upstreamPort: dead,
      attemptTimeoutMs: 500,
      discoveryTtlMs: 50
    }, async (d, addr) => {
      const first = await httpVia(addr.port, 'http://dead.invalid/');
      assert.equal(first.status, 200);
      assert.ok(d.candidates.some((c) => c.port === proxy.port));
      await new Promise((resolve) => setTimeout(resolve, 90));
      const second = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/');
      assert.equal(second.status, 200);
      assert.equal(d.candidates.some((c) => c.port === proxy.port), false, 'TTL 到期应移除');
    }, {
      startupDiscovery: false,
      discoveryFind: async () => ({ scanned: 1, results: [{ host: '127.0.0.1', port: proxy.port, source: 'discovered' }] })
    });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('discovery：库层默认关闭，CLI 默认开启，关闭开关生效', async () => {
  const { parseArgs } = await import('../bin/dual-proxy.js');
  assert.equal(parseArgs([], {}).discoverLocalProxy, true);
  assert.equal(parseArgs(['--no-discover-local-proxy'], {}).discoverLocalProxy, false);
  assert.equal(parseArgs([], { DISCOVER_LOCAL_PROXY: '0' }).discoverLocalProxy, false);

  const dualBin = fileURLToPath(new URL('../bin/dual-proxy.js', import.meta.url));
  const gatewayBin = fileURLToPath(new URL('../bin/agent-gateway.js', import.meta.url));
  const dual = spawnSync(process.execPath, [dualBin, '--print-config'], { encoding: 'utf8' });
  assert.equal(dual.status, 0, dual.stderr);
  assert.equal(JSON.parse(dual.stdout).discoverLocalProxy, true);
  const dualOff = spawnSync(process.execPath, [dualBin, '--print-config', '--no-discover-local-proxy'], { encoding: 'utf8' });
  assert.equal(dualOff.status, 0, dualOff.stderr);
  assert.equal(JSON.parse(dualOff.stdout).discoverLocalProxy, false);
  const gateway = spawnSync(process.execPath, [gatewayBin, '--print-config'], { encoding: 'utf8' });
  assert.equal(gateway.status, 0, gateway.stderr);
  assert.equal(JSON.parse(gateway.stdout).discoverLocalProxy, true);

  const dead = await closedPort();
  let finds = 0;
  await withDispatcher({
    upstreamPort: dead,
    attemptTimeoutMs: 500
  }, async (d, addr) => {
    const r = await httpVia(addr.port, 'http://dead.invalid/');
    assert.equal(r.status, 502);
    assert.equal(finds, 0);
  }, {
    startupDiscovery: false,
    discoveryFind: async () => {
      finds += 1;
      return { scanned: 1, results: [] };
    }
  });
});
