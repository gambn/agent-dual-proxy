import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDispatcher, isKnownFirst } from '../src/server.js';
import { splitPatterns, matchPattern, createRouteDecision } from '../src/rules.js';
import { parseArgs } from '../bin/dual-proxy.js';
import {
  startFakeProxy,
  startStaticProxy,
  startAuthProxy,
  startTarget,
  startEcho,
  closedPort,
  httpVia,
  tunnelVia
} from './helpers.js';

const silent = () => {};
const AUTH_HEADER = 'Basic ' + Buffer.from('alice:secret').toString('base64');
const dualBin = fileURLToPath(new URL('../bin/dual-proxy.js', import.meta.url));
const gatewayBin = fileURLToPath(new URL('../bin/agent-gateway.js', import.meta.url));

async function withDispatcher(options, fn) {
  const d = createDispatcher(Object.assign({ listenPort: 0, log: silent }, options));
  const addr = await d.listen();
  try {
    return await fn(d, addr);
  } finally {
    await d.close();
  }
}

test('rules：splitPatterns 逗号切分与清洗', () => {
  assert.deepEqual(splitPatterns(' a, b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(splitPatterns(''), []);
  assert.deepEqual(splitPatterns(undefined), []);
  assert.deepEqual(splitPatterns(null), []);
});

test('rules：matchPattern 精确、glob、大小写与 apex 语义', () => {
  assert.equal(matchPattern('api.deepseek.com', 'api.deepseek.com'), true);
  assert.equal(matchPattern('API.DeepSeek.com', 'api.deepseek.com'), true);
  assert.equal(matchPattern('api.deepseek.com', '*.deepseek.com'), true);
  assert.equal(matchPattern('deepseek.com', '*.deepseek.com'), false);
  assert.equal(matchPattern('deepseek.com', '*.cn'), false);
  assert.equal(matchPattern('api.deepseek.cn', '*.cn'), true);
  assert.equal(matchPattern('a+b.example', 'a+b.example'), true);
  assert.equal(matchPattern('aab.example', 'a+b.example'), false);
  assert.equal(matchPattern('anything', '*'), true);
  assert.equal(matchPattern('', 'a'), false);
  assert.equal(matchPattern('a', ''), false);
  assert.equal(matchPattern('a', '   '), false);
});

test('rules：两名单同时命中时直连优先，无命中回 null', () => {
  const decide = createRouteDecision({
    preferDirect: ['api.deepseek.com'],
    preferProxy: ['api.deepseek.com', 'api.openai.com']
  });
  assert.equal(decide('api.deepseek.com'), 'direct');
  assert.equal(decide('api.openai.com'), 'proxy');
  assert.equal(decide('example.com'), null);
  assert.equal(createRouteDecision({})('example.com'), null);
  assert.equal(createRouteDecision({ preferDirect: ['a'] })('a'), 'direct');
  assert.equal(createRouteDecision({ preferProxy: ['b'] })('b'), 'proxy');
});

test('known：规则命中不算已知路径', () => {
  assert.equal(isKnownFirst(null, [{ id: 'direct' }]), false);
  assert.equal(isKnownFirst('direct', [{ id: 'direct' }]), true);
  assert.equal(isKnownFirst('direct', [{ id: '127.0.0.1:7897' }]), false);
  assert.equal(isKnownFirst('direct', []), false);
});

test('R1/R4：prefer-direct 压过健康首选，首条走直连', async () => {
  const proxy = await startFakeProxy('proxy');
  const target = await startTarget();
  try {
    await withDispatcher({
      upstreamPort: proxy.port,
      preferDirect: ['127.0.0.1'],
      healthUrl: 'http://localhost:' + target.port + '/health',
      healthIntervalMs: 0,
      healthTimeoutMs: 1000
    }, async (d, addr) => {
      await d.runHealth();
      assert.equal(d.getPreferred(), '127.0.0.1:' + proxy.port, '健康首选应是代理');
      const before = proxy.count();
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/direct');
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-via'], undefined, '规则命中后应直接连目标');
      assert.equal(proxy.count(), before, '直连不应经过代理');
    });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('R2：prefer-proxy 压过 per-host 缓存', async () => {
  const proxy = await startFakeProxy('proxy');
  const target = await startTarget();
  try {
    await withDispatcher({
      upstreamPort: proxy.port,
      preferProxy: ['127.0.0.1']
    }, async (d, addr) => {
      d.pref.set('127.0.0.1', 'direct');
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/proxy');
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-via'], 'proxy');
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('R3：两名单同时命中时直连优先', async () => {
  const proxy = await startFakeProxy('proxy');
  const target = await startTarget();
  try {
    await withDispatcher({
      upstreamPort: proxy.port,
      preferDirect: ['127.0.0.1'],
      preferProxy: ['127.0.0.1']
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/both');
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-via'], undefined);
      assert.equal(proxy.count(), 0);
    });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('R5：未命中规则时维持原行为（代理优先）', async () => {
  const proxy = await startFakeProxy('proxy');
  const target = await startTarget();
  try {
    await withDispatcher({
      upstreamPort: proxy.port,
      preferDirect: ['api.deepseek.com'],
      preferProxy: ['api.openai.com']
    }, async (d, addr) => {
      const r = await httpVia(addr.port, 'http://127.0.0.1:' + target.port + '/unmatched');
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-via'], 'proxy');
      assert.equal(proxy.count(), 1);
    });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('R11：规则目标冷却后不会被规则拉回', async () => {
  const proxy = await startStaticProxy('static');
  const deadTarget = await closedPort();
  try {
    await withDispatcher({
      upstreamPort: proxy.port,
      preferDirect: ['127.0.0.1'],
      attemptTimeoutMs: 500,
      cooldownMs: 30000
    }, async (d, addr) => {
      const first = await httpVia(addr.port, 'http://127.0.0.1:' + deadTarget + '/x');
      assert.equal(first.status, 200);
      assert.equal(first.headers['x-via'], 'static');
      assert.equal(d.isCooling('direct', '127.0.0.1'), true);
      const second = await httpVia(addr.port, 'http://127.0.0.1:' + deadTarget + '/x');
      assert.equal(second.status, 200);
      assert.equal(second.headers['x-via'], 'static');
      assert.equal(proxy.count(), 2, '第二次不应再把冷的 direct 拉回');
    });
  } finally {
    await proxy.close();
  }
});

test('R12：规则作用于 CONNECT', async () => {
  const echo = await startEcho();
  const auth = await startAuthProxy();
  try {
    await withDispatcher({
      upstreamPort: auth.port,
      upstreamAuth: AUTH_HEADER,
      preferDirect: ['127.0.0.1'],
      attemptTimeoutMs: 500
    }, async (d, addr) => {
      const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
      sock.destroy();
      assert.equal(auth.connectCount(), 0, 'prefer-direct 不应向代理建 CONNECT');
    });
    await withDispatcher({
      upstreamPort: auth.port,
      upstreamAuth: AUTH_HEADER,
      preferProxy: ['127.0.0.1'],
      attemptTimeoutMs: 500
    }, async (d, addr) => {
      const sock = await tunnelVia(addr.port, '127.0.0.1', echo.port);
      sock.destroy();
      assert.equal(auth.connectCount(), 1, 'prefer-proxy 应走代理 CONNECT');
    });
  } finally {
    await auth.close();
    await echo.close();
  }
});

test('R15：CLI 与 env 解析 prefer-direct/prefer-proxy', () => {
  const fromCli = parseArgs([
    '--prefer-direct', ' api.deepseek.com, *.cn ',
    '--prefer-proxy', 'api.openai.com'
  ], {});
  assert.deepEqual(fromCli.preferDirect, ['api.deepseek.com', '*.cn']);
  assert.deepEqual(fromCli.preferProxy, ['api.openai.com']);

  const fromEnv = parseArgs([], { PREFER_DIRECT: 'a, b', PREFER_PROXY: 'c' });
  assert.deepEqual(fromEnv.preferDirect, ['a', 'b']);
  assert.deepEqual(fromEnv.preferProxy, ['c']);
});

test('R14：健康检查 host 命中规则时按规则选路', async () => {
  const proxy = await startFakeProxy('proxy');
  const target = await startTarget();
  const healthUrl = 'http://127.0.0.1:' + target.port + '/health';
  try {
    await withDispatcher({
      upstreamPort: proxy.port,
      preferDirect: ['127.0.0.1'],
      healthUrl,
      healthIntervalMs: 0,
      healthTimeoutMs: 1000
    }, async (d) => {
      await d.runHealth();
      assert.equal(d.getPreferred(), 'direct');
      assert.equal(proxy.connectCount(), 0);
    });
    await withDispatcher({
      upstreamPort: proxy.port,
      preferProxy: ['127.0.0.1'],
      healthUrl,
      healthIntervalMs: 0,
      healthTimeoutMs: 1000
    }, async (d) => {
      await d.runHealth();
      assert.equal(d.getPreferred(), '127.0.0.1:' + proxy.port);
      assert.equal(proxy.connectCount(), 1);
    });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('R15：dual-proxy --print-config 输出规则，agent-gateway help 透传', () => {
  const run = spawnSync(process.execPath, [
    dualBin, '--print-config',
    '--prefer-direct', 'api.deepseek.com,*.cn',
    '--prefer-proxy', 'api.openai.com'
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const view = JSON.parse(run.stdout);
  assert.deepEqual(view.preferDirect, ['api.deepseek.com', '*.cn']);
  assert.deepEqual(view.preferProxy, ['api.openai.com']);

  const help = spawnSync(process.execPath, [gatewayBin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--prefer-direct/);
  assert.match(help.stdout, /--prefer-proxy/);

  const gatewayConfig = spawnSync(process.execPath, [
    gatewayBin, '--print-config',
    '--prefer-direct', 'api.deepseek.com',
    '--prefer-proxy', 'api.openai.com'
  ], { encoding: 'utf8' });
  assert.equal(gatewayConfig.status, 0, gatewayConfig.stderr);
  const gatewayView = JSON.parse(gatewayConfig.stdout);
  assert.deepEqual(gatewayView.preferDirect, ['api.deepseek.com']);
  assert.deepEqual(gatewayView.preferProxy, ['api.openai.com']);
});
