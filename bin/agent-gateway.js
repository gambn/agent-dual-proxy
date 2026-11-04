#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDispatcher, IDENTITY_HEADER, IDENTITY_PATH } from '../src/server.js';
import { collectGateways, isLoopbackHost, resolveUpstream } from '../src/gateways.js';
import { assertNode } from '../src/engines.js';
import { AGENT_NAMES, resolveAgent, buildProxyEnv, proxyUrl } from '../src/agents.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const LAUNCHER_OPTS = [
  '--listen-host', '--listen-port', '--port-fallback', '--upstream-host', '--upstream-port', '--upstream-url',
  '--gateway', '--health-url', '--health-interval-ms', '--timeout-ms', '--response-timeout-ms',
  '--fast-fail-ms', '--cooldown-ms', '--pref-ttl-ms'
];
const FLAGS = [
  '--no-verify-tls', '--retry-non-idempotent-after-send',
  '--retry-non-idempotent-with-idempotency-key'
];

function usage() {
  process.stdout.write([
    'agent-gateway ' + pkg.version + ' —— 给主流 CLI agent 套一层双路代理',
    '',
    'Usage:',
    '  agent-gateway run [options] <agent> [agent-args...]',
    '  agent-gateway run [options] -- <cmd> [args...]',
    '  agent-gateway env [options]        # 打印可 source 的导出语句',
    '',
    'Agents: ' + AGENT_NAMES.join(', '),
    '',
    'Options:',
    '  --listen-host <host>        default 127.0.0.1',
    '  --listen-port <port>        default 7898',
    '  --port-fallback <n>         on EADDRINUSE try port+n, default 10 (0 disables)',
    '  --upstream-host <host>      default 127.0.0.1',
    '  --upstream-port <port>      default 7897',
    '  --upstream-url <url>        full upstream URL, may include user:pass',
    '  --gateway <host:port>       extra candidate gateway, repeatable',
    '  --health-url <url>          verify the channel with this URL, default off',
    '  --health-interval-ms <ms>   default 60000, 0 disables',
    '  --timeout-ms <ms>           per-attempt timeout, default 5000',
    '  --response-timeout-ms <ms>  header wait for plain HTTP, default 60000',
    '  --fast-fail-ms <ms>         timeout for the known path, default 2000',
    '  --cooldown-ms <ms>          failed gateway rest, default 30000',
    '  --pref-ttl-ms <ms>          per-host preference TTL, default 60000',
    '  --no-verify-tls             skip the TLS reachability probe on 443',
    '  --retry-non-idempotent-after-send  replay POST/PATCH after the body may have',
    '                              been sent (dangerous; default off)',
    '  --retry-non-idempotent-with-idempotency-key',
    '                              replay POST/PATCH after send when Idempotency-Key is present',
    '  -h, --help',
    '  -v, --version',
    ''
  ].join('\n'));
}

/** 参数错误：由顶层以退出码 2 结束。 */
export class UsageError extends Error {}

/** 解析整数并校验范围；失败抛 UsageError。 */
function integer(label, raw, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError('invalid value for ' + label + ': ' + raw + ' (expected integer ' + min + '..' + max + ')');
  }
  return value;
}

function parseArgs(argv, env = process.env) {
  const opts = {
    listenHost: env.LISTEN_HOST || '127.0.0.1',
    listenPort: integer('LISTEN_PORT', env.LISTEN_PORT ?? 7898, 1, 65535),
    portFallback: integer('PORT_FALLBACK', env.PORT_FALLBACK ?? 10, 0, 100),
    upstreamHost: env.UPSTREAM_HOST || '127.0.0.1',
    upstreamPort: integer('UPSTREAM_PORT', env.UPSTREAM_PORT ?? 7897, 1, 65535),
    upstreamUrl: env.UPSTREAM_URL || '',
    attemptTimeoutMs: integer('ATTEMPT_TIMEOUT_MS', env.ATTEMPT_TIMEOUT_MS ?? 5000, 100, 60000),
    responseTimeoutMs: integer('RESPONSE_TIMEOUT_MS', env.RESPONSE_TIMEOUT_MS ?? 60000, 100, 600000),
    prefTtlMs: integer('PREF_TTL_MS', env.PREF_TTL_MS ?? 60000, 0, 3600000),
    gateways: env.GATEWAY ? [env.GATEWAY] : [],
    healthUrl: env.HEALTH_URL || '',
    healthIntervalMs: integer('HEALTH_INTERVAL_MS', env.HEALTH_INTERVAL_MS ?? 60000, 0, 3600000),
    fastFailTimeoutMs: integer('FAST_FAIL_MS', env.FAST_FAIL_MS ?? 2000, 100, 60000),
    cooldownMs: integer('COOLDOWN_MS', env.COOLDOWN_MS ?? 30000, 0, 600000),
    retryNonIdempotentAfterSend: env.RETRY_NON_IDEMPOTENT_AFTER_SEND === '1',
    retryNonIdempotentWithIdempotencyKey: env.RETRY_NON_IDEMPOTENT_WITH_IDEMPOTENCY_KEY === '1',
    verifyTls: env.VERIFY_TLS !== '0'
  };
  const rest = [];
  let explicit = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      explicit = true;
      break;
    }
    if (!arg.startsWith('-')) {
      rest.push(...argv.slice(i));
      break;
    }
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new UsageError('missing value for ' + arg);
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(pkg.version + '\n');
      process.exit(0);
    }
    if (FLAGS.includes(arg)) {
      if (arg === '--no-verify-tls') opts.verifyTls = false;
      else if (arg === '--retry-non-idempotent-after-send') opts.retryNonIdempotentAfterSend = true;
      else if (arg === '--retry-non-idempotent-with-idempotency-key') opts.retryNonIdempotentWithIdempotencyKey = true;
      continue;
    }
    if (!LAUNCHER_OPTS.includes(arg)) {
      // 不认识的开关当作目标 agent 的参数（例如 claude 自己的 --resume）
      rest.push(...argv.slice(i));
      break;
    }
    const value = next();
    if (arg === '--listen-host') opts.listenHost = value;
    else if (arg === '--listen-port') opts.listenPort = integer(arg, value, 1, 65535);
    else if (arg === '--port-fallback') opts.portFallback = integer(arg, value, 0, 100);
    else if (arg === '--upstream-host') opts.upstreamHost = value;
    else if (arg === '--upstream-port') opts.upstreamPort = integer(arg, value, 1, 65535);
    else if (arg === '--upstream-url') opts.upstreamUrl = value;
    else if (arg === '--gateway') opts.gateways.push(value);
    else if (arg === '--health-url') opts.healthUrl = value;
    else if (arg === '--health-interval-ms') opts.healthIntervalMs = integer(arg, value, 0, 3600000);
    else if (arg === '--timeout-ms') opts.attemptTimeoutMs = integer(arg, value, 100, 60000);
    else if (arg === '--response-timeout-ms') opts.responseTimeoutMs = integer(arg, value, 100, 600000);
    else if (arg === '--fast-fail-ms') opts.fastFailTimeoutMs = integer(arg, value, 100, 60000);
    else if (arg === '--cooldown-ms') opts.cooldownMs = integer(arg, value, 0, 600000);
    else if (arg === '--pref-ttl-ms') opts.prefTtlMs = integer(arg, value, 0, 3600000);
  }

  return { opts, rest, explicit };
}

/**
 * 监听端口上是谁：free（没人听）、ours（本代理）、other（别的程序）。
 *
 * 只有 ours 才复用。别的程序占着端口时直接报错，不能把 agent 指向
 * 一个根本不是代理的端口。
 */
export function probeListener(host, port, timeoutMs = 1500) {
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({
      host: probeHost,
      port,
      path: IDENTITY_PATH,
      timeout: timeoutMs,
      agent: false
    }, (res) => {
      res.resume();
      done(res.statusCode === 200 && res.headers[IDENTITY_HEADER] === '1' ? 'ours' : 'other');
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', (err) => done(err && err.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

/**
 * 逐端口选择监听位置：
 * - ours：复用现有本代理；
 * - other：其他程序占用，交给调用方报错；
 * - free 但 start 抛 EADDRINUSE：多半是 TIME-WAIT，继续尝试下一个。
 */
export async function selectListener({ host, port, fallback, probe = probeListener, start }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= fallback; attempt += 1) {
    const candidate = port + attempt;
    if (candidate > 65535) break;
    const kind = await probe(host, candidate);
    if (kind === 'ours') return { kind: 'ours', port: candidate };
    if (kind === 'other') return { kind: 'other', port: candidate };
    try {
      return { kind: 'started', port: candidate, server: await start(candidate) };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('no usable listen port between ' + port + ' and ' + (port + fallback));
}

async function serve(opts) {
  const upstream = resolveUpstream(opts);
  if (!isLoopbackHost(opts.listenHost)) {
    process.stderr.write('warning: listening on ' + opts.listenHost + '; this proxy has no authentication\n');
  }
  // 启动环境里的 HTTP(S)_PROXY/ALL_PROXY 也是候选；self 排除自己。
  const gateways = collectGateways({
    upstream,
    extra: opts.gateways,
    env: process.env,
    self: { host: opts.listenHost, port: opts.listenPort },
    onInvalid: (subject, reason) => process.stderr.write('warning: ' + subject + ': ' + reason + '\n')
  });

  const selection = await selectListener({
    host: opts.listenHost,
    port: opts.listenPort,
    fallback: opts.portFallback,
    start: async (port) => {
      const dispatcher = createDispatcher(Object.assign({}, opts, {
        listenHost: opts.listenHost,
        listenPort: port,
        portFallback: 0,
        upstreamHost: upstream.host,
        upstreamPort: upstream.port,
        upstreamAuth: upstream.auth,
        gateways,
        log: (msg) => process.stderr.write('[agent-gateway] ' + msg + '\n')
      }));
      const addr = await dispatcher.listen();
      return { dispatcher, addr };
    }
  });

  if (selection.kind === 'other') {
    throw new Error('listen port ' + selection.port + ' is already in use by something that is not '
      + 'agent-dual-proxy; stop it or choose another --listen-port');
  }
  if (selection.kind === 'ours') {
    const url = proxyUrl({ listenHost: opts.listenHost, listenPort: selection.port });
    process.stderr.write('[agent-gateway] reusing agent-dual-proxy on ' + url + '\n');
    return { url, close: async () => {} };
  }
  const { dispatcher, addr } = selection.server;
  dispatcher.startHealth();
  const bound = proxyUrl({ listenHost: addr.address, listenPort: addr.port });
  process.stderr.write('[agent-gateway] listening on ' + bound + '\n');
  return { url: bound, close: () => dispatcher.stopHealth() || dispatcher.close() };
}

async function run(argv) {
  const { opts, rest, explicit } = parseArgs(argv);
  let target;
  if (rest.length === 0) {
    usage();
    process.exit(2);
  }
  // `run claude ...` 走适配表；`run -- cmd ...` 走裸命令
  const adapter = explicit ? null : resolveAgent(rest[0]);
  if (adapter) {
    target = { bin: adapter.bin, args: rest.slice(1) };
  } else if (explicit) {
    target = { bin: rest[0], args: rest.slice(1) };
  } else {
    process.stderr.write('[agent-gateway] unknown agent: ' + rest[0]
      + '\n  known: ' + AGENT_NAMES.join(', ')
      + '\n  or: agent-gateway run -- <cmd> [args...]\n');
    process.exit(2);
  }

  const bridge = await serve(opts);
  const child = spawn(target.bin, target.args, {
    stdio: 'inherit',
    env: buildProxyEnv(bridge.url)
  });

  const stop = async (code) => {
    await bridge.close();
    process.exit(code);
  };
  child.on('error', (err) => {
    process.stderr.write('[agent-gateway] failed to start ' + target.bin + ': ' + err.message + '\n');
    stop(127);
  });
  child.on('exit', (code, signal) => stop(code === null ? 128 + (signal ? 1 : 0) : code));

  // 让 agent 自己收尾，等它的 exit 事件再关代理，避免留下孤儿进程
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try { child.kill(signal); } catch (e) { /* ignore */ }
    });
  }
}

async function printEnv(argv) {
  const { opts } = parseArgs(argv);
  // 以当前 shell 环境为底：NO_PROXY 会把用户原有的直连段一起带出去
  const env = buildProxyEnv(proxyUrl(opts));
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  process.stdout.write(keys.map((key) => 'export ' + key + '=' + env[key]).join('\n') + '\n');
}

async function main() {
  try {
    assertNode();
    const [command, ...rest] = process.argv.slice(2);
    if (command === '-h' || command === '--help' || command === undefined) {
      usage();
    } else if (command === '-v' || command === '--version') {
      process.stdout.write(pkg.version + '\n');
    } else if (command === 'run') {
      await run(rest);
    } else if (command === 'env') {
      await printEnv(rest);
    } else {
      process.stderr.write('[agent-gateway] unknown command: ' + command + '\n');
      usage();
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}

/** 入口判断：npm 通过符号链接调用时，argv[1] 与真实路径不同，必须 realpath 比较。 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err) {
    return false;
  }
}

if (isMain()) {
  main();
}
