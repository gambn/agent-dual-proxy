import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../src/server.js';
import { resolveAgent, buildProxyEnv, proxyUrl } from '../src/agents.js';
import { selectListener } from '../bin/agent-gateway.js';

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
  const expected = {
    claude: 'claude', codex: 'codex', gemini: 'gemini', pi: 'pi',
    aider: 'aider', opencode: 'opencode', qwen: 'qwen', cursor: 'cursor-agent',
    droid: 'droid', amp: 'amp', crush: 'crush', goose: 'goose', copilot: 'copilot'
  };
  for (const [name, bin] of Object.entries(expected)) {
    assert.equal(resolveAgent(name).bin, bin, name);
  }
});

test('resolveAgent：不认识的 agent 返回 null', () => {
  assert.equal(resolveAgent('nope'), null);
  assert.equal(resolveAgent(''), null);
});

test('buildProxyEnv：代理变量大小写各一份 + 本地绕过，无关变量原样保留', () => {
  const env = buildProxyEnv('http://127.0.0.1:7898', { PATH: '/usr/bin', FOO: 'bar' });
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.equal(env[key], 'http://127.0.0.1:7898', key);
  }
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(env.no_proxy, /localhost/);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FOO, 'bar');
});

test('buildProxyEnv：socks ALL_PROXY 被替换，NO_PROXY 合并不覆盖', () => {
  const env = buildProxyEnv('http://127.0.0.1:7898', {
    ALL_PROXY: 'socks://127.0.0.1:12334/',
    all_proxy: 'socks://127.0.0.1:12334/',
    NO_PROXY: 'localhost,192.168.0.0/16'
  });
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:7898');
  assert.equal(env.all_proxy, 'http://127.0.0.1:7898');
  assert.match(env.NO_PROXY, /192\.168\.0\.0\/16/);
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test('proxyUrl：拼出回环地址', () => {
  assert.equal(proxyUrl({ listenHost: '127.0.0.1', listenPort: 7898 }), 'http://127.0.0.1:7898');
});

test('selectListener：原端口被其他程序占用时直接报错，不启动', async () => {
  let started = false;
  const result = await selectListener({
    host: '127.0.0.1',
    port: 7898,
    fallback: 3,
    probe: async () => 'other',
    start: async () => { started = true; }
  });
  assert.deepEqual(result, { kind: 'other', port: 7898 });
  assert.equal(started, false);
});

test('selectListener：TIME-WAIT 时退避到下一个空闲端口并返回实际端口', async () => {
  const started = [];
  const result = await selectListener({
    host: '127.0.0.1',
    port: 7898,
    fallback: 3,
    probe: async () => 'free',
    start: async (port) => {
      started.push(port);
      if (port === 7898) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
      return { dispatcher: {}, addr: { address: '127.0.0.1', port } };
    }
  });
  assert.equal(result.kind, 'started');
  assert.equal(result.port, 7899);
  assert.deepEqual(started, [7898, 7899]);
});

test('selectListener：退避目标是本代理时复用而不是重开', async () => {
  const result = await selectListener({
    host: '127.0.0.1',
    port: 7898,
    fallback: 3,
    probe: async (host, port) => (port === 7898 ? 'free' : 'ours'),
    start: async () => { throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); }
  });
  assert.deepEqual(result, { kind: 'ours', port: 7899 });
});

test('selectListener：全部 TIME-WAIT 时抛出最后一次 EADDRINUSE', async () => {
  await assert.rejects(
    () => selectListener({
      host: '127.0.0.1',
      port: 7898,
      fallback: 1,
      probe: async () => 'free',
      start: async () => { throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); }
    }),
    (err) => err.code === 'EADDRINUSE'
  );
});

test('CLI run：把代理变量交给子进程，退出码透传', async () => {
  const port = await freePort();
  const result = spawnSync(process.execPath, [
    CLI, 'run', '--listen-port', String(port), '--', 'sh', '-c', 'printf %s "$HTTPS_PROXY"; exit 7'
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.stdout.trim(), 'http://127.0.0.1:' + port);
  assert.equal(result.status, 7);
});

test('CLI run：端口被其他程序占用时报错退出，不启动 agent', async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  try {
    const result = spawnSync(process.execPath, [
      CLI, 'run', '--listen-port', String(port), '--', 'sh', '-c', 'printf SHOULD_NOT_RUN'
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not agent-dual-proxy/);
    assert.ok(!result.stdout.includes('SHOULD_NOT_RUN'), 'agent 不应被启动');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

/** 异步启动 CLI：父进程要留着事件循环给同进程里的代理响应身份探测。 */
function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ status: code, stdout, stderr }));
  });
}

test('CLI run：端口上是本代理时复用现有监听', async () => {
  const port = await freePort();
  const proxy = createDispatcher({ listenPort: port, upstreamPort: 1, log: () => {} });
  await proxy.listen();
  try {
    const result = await runAsync([
      'run', '--listen-port', String(port), '--', 'sh', '-c', 'printf %s "$HTTPS_PROXY"'
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'http://127.0.0.1:' + port);
    assert.match(result.stderr, /reusing agent-dual-proxy/);
  } finally {
    await proxy.close();
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
