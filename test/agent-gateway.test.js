import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAgent, buildProxyEnv, proxyUrl } from '../src/agents.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agent-gateway.js');

/** 拿一个当前空闲的本地端口，避免用例互相撞端口。 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('resolveAgent：已知 agent 映射到可执行文件', () => {
  assert.equal(resolveAgent('claude').bin, 'claude');
  assert.equal(resolveAgent('codex').bin, 'codex');
  assert.equal(resolveAgent('gemini').bin, 'gemini');
  assert.equal(resolveAgent('pi').bin, 'pi');
});

test('resolveAgent：不认识的 agent 返回 null', () => {
  assert.equal(resolveAgent('nope'), null);
  assert.equal(resolveAgent(''), null);
});

test('buildProxyEnv：四个大小写变量 + 本地绕过，无关变量原样保留', () => {
  const env = buildProxyEnv('http://127.0.0.1:7898', { PATH: '/usr/bin', FOO: 'bar' });
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.equal(env[key], 'http://127.0.0.1:7898', key);
  }
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(env.no_proxy, /localhost/);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FOO, 'bar');
});

test('proxyUrl：拼出回环地址', () => {
  assert.equal(proxyUrl({ listenHost: '127.0.0.1', listenPort: 7898 }), 'http://127.0.0.1:7898');
});

test('CLI run：把代理变量交给子进程，退出码透传', async () => {
  const port = await freePort();
  const result = spawnSync(process.execPath, [
    CLI, 'run', '--listen-port', String(port), '--', 'sh', '-c', 'printf %s "$HTTPS_PROXY"; exit 7'
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.stdout.trim(), 'http://127.0.0.1:' + port);
  assert.equal(result.status, 7);
});

test('CLI run：端口已被占用时复用在跑的那一份，不报错', async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  try {
    const result = spawnSync(process.execPath, [
      CLI, 'run', '--listen-port', String(port), '--', 'sh', '-c', 'printf %s "$HTTPS_PROXY"'
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'http://127.0.0.1:' + port);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('CLI env：打印可直接 source 的导出语句', async () => {
  const result = spawnSync(process.execPath, [CLI, 'env', '--listen-port', '7898'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /export HTTPS_PROXY=http:\/\/127\.0\.0\.1:7898/);
  assert.match(result.stdout, /export http_proxy=http:\/\/127\.0\.0\.1:7898/);
});

test('CLI run：未知 agent 给出用法提示并非零退出', () => {
  const result = spawnSync(process.execPath, [CLI, 'run', 'nope'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown agent/);
});
