import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { hostHeader } from '../src/paths.js';
import { createDispatcher } from '../src/server.js';
import { startBannerProxy } from './helpers.js';

test('CONNECT：200 同包到达的早期数据会转交客户端', async () => {
  const proxy = await startBannerProxy('SSH-2.0-banner\r\n');
  const d = createDispatcher({
    listenPort: 0,
    upstreamPort: proxy.port,
    attemptTimeoutMs: 500,
    verifyTls: false,
    log: () => {}
  });
  const addr = await d.listen();
  const sock = net.connect(addr.port, '127.0.0.1');
  const banner = await new Promise((resolve) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('SSH-2.0-banner')) resolve('SSH-2.0-banner');
    });
    sock.once('connect', () => sock.write('CONNECT example.com:22 HTTP/1.1\r\n\r\n'));
    setTimeout(() => resolve(buf), 800);
  });
  sock.destroy();
  await d.close();
  await proxy.close();
  assert.equal(banner, 'SSH-2.0-banner');
});

test('hostHeader：IPv6 加方括号，非默认端口带端口', () => {
  assert.equal(hostHeader('example.com', 443, true), 'example.com');
  assert.equal(hostHeader('example.com', 8443, true), 'example.com:8443');
  assert.equal(hostHeader('127.0.0.1', 80, false), '127.0.0.1');
  assert.equal(hostHeader('127.0.0.1', 8080, false), '127.0.0.1:8080');
  assert.equal(hostHeader('::1', 443, true), '[::1]');
  assert.equal(hostHeader('::1', 8080, false), '[::1]:8080');
});
