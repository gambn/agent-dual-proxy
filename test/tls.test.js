import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDirect, probeTls, probeHttp } from '../src/paths.js';
import { startEcho } from './helpers.js';

function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'dual-proxy-tls-'));
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'
  ], { stdio: 'ignore' });
  return {
    dir,
    key: readFileSync(keyFile, 'utf8'),
    cert: readFileSync(certFile, 'utf8')
  };
}

test('TLS 探测：自签服务握手成功，明文 TCP 失败', async (t) => {
  let material;
  try {
    material = makeCert();
  } catch (e) {
    t.skip('本机没有 openssl，跳过 TLS 用例');
    return;
  }

  const sockets = new Set();
  const server = tls.createServer({ key: material.key, cert: material.cert }, (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    assert.equal(await probeTls(connectDirect, '127.0.0.1', port, 1500), true, 'TLS 握手应成功');
    assert.equal(await probeHttp(connectDirect, '127.0.0.1', port, '/', true, 1500), 200, 'HTTP over TLS 应返回 200');

    const echo = await startEcho();
    try {
      assert.equal(await probeTls(connectDirect, '127.0.0.1', echo.port, 500), false, '明文 TCP 不应握手成功');
    } finally {
      await echo.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    const deprecation = warnings.find((warning) => /DEP0123/.test(String(warning && warning.message)));
    assert.equal(deprecation, undefined, 'IP 字面量不应触发 DEP0123');
  } finally {
    process.removeListener('warning', onWarning);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(material.dir, { recursive: true, force: true });
  }
});
