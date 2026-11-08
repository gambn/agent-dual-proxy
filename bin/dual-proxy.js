#!/usr/bin/env node
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../src/server.js';
import { collectGateways, isLoopbackHost, resolveUpstream } from '../src/gateways.js';
import { splitPatterns } from '../src/rules.js';
import { assertNode } from '../src/engines.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** 参数错误：打印一行并以退出码 2 结束。 */
export class UsageError extends Error {}

function usage() {
  process.stdout.write([
    'dual-proxy ' + pkg.version,
    '',
    'Usage: dual-proxy [options]',
    '',
    'Options:',
    '  --listen-host <host>    default 127.0.0.1',
    '  --listen-port <port>    default 7898',
    '  --port-fallback <n>     on EADDRINUSE try port+n, up to n ports, default 0',
    '  --print-config          print the effective config and exit (alias: --dry-run)',
    '  --upstream-host <host>  default 127.0.0.1',
    '  --upstream-port <port>  default 7897',
    '  --upstream-url <url>    full upstream URL, may include user:pass',
    '  --gateway <host:port>   extra candidate gateway, repeatable',
    '  --prefer-direct <patterns>  try direct first for these hosts (comma-separated, * glob)',
    '  --prefer-proxy <patterns>   try proxies first for these hosts (comma-separated, * glob)',
    '  --health-url <url>      verify the channel with this URL, default off',
    '  --health-interval-ms <ms>  default 60000, 0 disables',
    '  --fast-fail-ms <ms>     timeout for the known path, default 2000',
    '  --cooldown-ms <ms>      failed gateways rest this long, default 30000',
    '  --timeout-ms <ms>       per-attempt timeout, default 5000',
    '  --response-timeout-ms <ms>  header wait for plain HTTP, default 60000',
    '  --pref-ttl-ms <ms>      per-host preference TTL, default 60000',
    '  --no-verify-tls         skip the TLS reachability probe on 443',
    '  --retry-non-idempotent-after-send  replay POST/PATCH after the body may have',
    '                          been sent (dangerous; default off)',
    '  --retry-non-idempotent-with-idempotency-key',
    '                          replay POST/PATCH after send when Idempotency-Key is present',
    '  -h, --help              show this help',
    '  -v, --version           print version',
    '',
    'Env fallbacks: LISTEN_HOST / LISTEN_PORT / PORT_FALLBACK / UPSTREAM_HOST / UPSTREAM_PORT /',
    '               UPSTREAM_URL / GATEWAY / PREFER_DIRECT / PREFER_PROXY /',
    '               HEALTH_URL / HEALTH_INTERVAL_MS / FAST_FAIL_MS / COOLDOWN_MS /',
    '               ATTEMPT_TIMEOUT_MS / RESPONSE_TIMEOUT_MS /',
    '               PREF_TTL_MS / VERIFY_TLS=0 / RETRY_NON_IDEMPOTENT_AFTER_SEND=1 /',
    '               RETRY_NON_IDEMPOTENT_WITH_IDEMPOTENCY_KEY=1',
    ''
  ].join('\n'));
}

function envValue(env, name) {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** URL 展示用：去掉 userinfo、查询串与 hash，避免 print-config 泄漏凭证。 */
function redactUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol + '//' + url.host + url.pathname;
  } catch (err) {
    return '<invalid>';
  }
}

/** 解析整数并校验范围；失败抛 UsageError。 */
function integer(label, raw, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError('invalid value for ' + label + ': ' + raw + ' (expected integer ' + min + '..' + max + ')');
  }
  return value;
}

/** 解析 CLI 参数；args 不含 node 与脚本路径。 */
export function parseArgs(args, env = {}) {
  const opts = {
    listenHost: envValue(env, 'LISTEN_HOST') || '127.0.0.1',
    listenPort: integer('LISTEN_PORT', envValue(env, 'LISTEN_PORT') ?? 7898, 1, 65535),
    portFallback: integer('PORT_FALLBACK', envValue(env, 'PORT_FALLBACK') ?? 0, 0, 100),
    upstreamHost: envValue(env, 'UPSTREAM_HOST') || '127.0.0.1',
    upstreamPort: integer('UPSTREAM_PORT', envValue(env, 'UPSTREAM_PORT') ?? 7897, 1, 65535),
    upstreamUrl: envValue(env, 'UPSTREAM_URL') || '',
    attemptTimeoutMs: integer('ATTEMPT_TIMEOUT_MS', envValue(env, 'ATTEMPT_TIMEOUT_MS') ?? 5000, 100, 60000),
    responseTimeoutMs: integer('RESPONSE_TIMEOUT_MS', envValue(env, 'RESPONSE_TIMEOUT_MS') ?? 60000, 100, 600000),
    prefTtlMs: integer('PREF_TTL_MS', envValue(env, 'PREF_TTL_MS') ?? 60000, 0, 3600000),
    gateways: envValue(env, 'GATEWAY') ? [envValue(env, 'GATEWAY')] : [],
    preferDirect: splitPatterns(envValue(env, 'PREFER_DIRECT')),
    preferProxy: splitPatterns(envValue(env, 'PREFER_PROXY')),
    healthUrl: env.HEALTH_URL ?? '',
    healthIntervalMs: integer('HEALTH_INTERVAL_MS', envValue(env, 'HEALTH_INTERVAL_MS') ?? 60000, 0, 3600000),
    fastFailTimeoutMs: integer('FAST_FAIL_MS', envValue(env, 'FAST_FAIL_MS') ?? 2000, 100, 60000),
    cooldownMs: integer('COOLDOWN_MS', envValue(env, 'COOLDOWN_MS') ?? 30000, 0, 600000),
    retryNonIdempotentAfterSend: env.RETRY_NON_IDEMPOTENT_AFTER_SEND === '1',
    retryNonIdempotentWithIdempotencyKey: env.RETRY_NON_IDEMPOTENT_WITH_IDEMPOTENCY_KEY === '1',
    verifyTls: env.VERIFY_TLS !== '0'
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (i >= args.length) throw new UsageError('missing value for ' + arg);
      return args[i];
    };
    switch (arg) {
      case '--listen-host': opts.listenHost = next(); break;
      case '--listen-port': opts.listenPort = integer(arg, next(), 1, 65535); break;
      case '--port-fallback': opts.portFallback = integer(arg, next(), 0, 100); break;
      case '--print-config':
      case '--dry-run': opts.printConfig = true; break;
      case '--upstream-host': opts.upstreamHost = next(); break;
      case '--upstream-port': opts.upstreamPort = integer(arg, next(), 1, 65535); break;
      case '--upstream-url': opts.upstreamUrl = next(); break;
      case '--gateway': opts.gateways.push(next()); break;
      case '--prefer-direct': opts.preferDirect.push(...splitPatterns(next())); break;
      case '--prefer-proxy': opts.preferProxy.push(...splitPatterns(next())); break;
      case '--health-url': opts.healthUrl = next(); break;
      case '--health-interval-ms': opts.healthIntervalMs = integer(arg, next(), 0, 3600000); break;
      case '--fast-fail-ms': opts.fastFailTimeoutMs = integer(arg, next(), 100, 60000); break;
      case '--cooldown-ms': opts.cooldownMs = integer(arg, next(), 0, 600000); break;
      case '--timeout-ms': opts.attemptTimeoutMs = integer(arg, next(), 100, 60000); break;
      case '--response-timeout-ms': opts.responseTimeoutMs = integer(arg, next(), 100, 600000); break;
      case '--pref-ttl-ms': opts.prefTtlMs = integer(arg, next(), 0, 3600000); break;
      case '--no-verify-tls': opts.verifyTls = false; break;
      case '--retry-non-idempotent-after-send': opts.retryNonIdempotentAfterSend = true; break;
      case '--retry-non-idempotent-with-idempotency-key': opts.retryNonIdempotentWithIdempotencyKey = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      case '-v':
      case '--version': opts.version = true; break;
      default: throw new UsageError('unknown option: ' + arg);
    }
  }

  if (opts.upstreamUrl) {
    // upstreamUrl 是显式的第一个候选：非法值 fail fast，由 resolveUpstream 给出脱敏原因。
    try {
      resolveUpstream(opts);
    } catch (err) {
      throw new UsageError(err && err.message ? err.message : 'invalid upstreamUrl (userinfo redacted)');
    }
  }
  // --gateway/GATEWAY 与 gateways 配置一样，交给 collectGateways 做 warning + skip；
  // 非法额外候选不应阻止启动或悄悄回退。
  return opts;
}

async function main() {
  try {
    assertNode();
    const opts = parseArgs(process.argv.slice(2), process.env);
    if (opts.help) { usage(); return; }
    if (opts.version) { process.stdout.write(pkg.version + '\n'); return; }
    let upstream;
    try {
      upstream = resolveUpstream(opts);
    } catch (err) {
      throw new UsageError(err && err.message ? err.message : 'invalid upstreamUrl (userinfo redacted)');
    }
    if (!isLoopbackHost(opts.listenHost)) {
      process.stderr.write('warning: listening on ' + opts.listenHost + '; this proxy has no authentication\n');
    }

    const gateways = collectGateways({
      upstream,
      extra: opts.gateways,
      env: process.env,
      self: { host: opts.listenHost, port: opts.listenPort },
      onInvalid: (subject, reason) => process.stderr.write('warning: ' + subject + ': ' + reason + '\n')
    });
    if (opts.printConfig) {
      const view = {
        listen: { host: opts.listenHost, port: opts.listenPort, portFallback: opts.portFallback },
        upstream: { host: upstream.host, port: upstream.port, auth: Boolean(upstream.auth) },
        gateways: gateways.map((g) => ({ host: g.host, port: g.port, auth: Boolean(g.auth) })),
        preferDirect: opts.preferDirect,
        preferProxy: opts.preferProxy,
        direct: true,
        health: { url: redactUrl(opts.healthUrl), intervalMs: opts.healthIntervalMs },
        timeouts: {
          attemptMs: opts.attemptTimeoutMs,
          responseMs: opts.responseTimeoutMs,
          fastFailMs: opts.fastFailTimeoutMs
        },
        cooldownMs: opts.cooldownMs,
        prefTtlMs: opts.prefTtlMs,
        replay: {
          nonIdempotentAfterSend: opts.retryNonIdempotentAfterSend,
          idempotencyKey: opts.retryNonIdempotentWithIdempotencyKey
        },
        verifyTls: opts.verifyTls
      };
      process.stdout.write(JSON.stringify(view, null, 2) + '\n');
      return;
    }
    const dispatcher = createDispatcher(Object.assign({}, opts, {
      upstreamHost: upstream.host,
      upstreamPort: upstream.port,
      upstreamAuth: upstream.auth,
      gateways
    }));
    const addr = await dispatcher.listen();
    dispatcher.startHealth();
    process.stderr.write('[dual-proxy] listening on ' + addr.address + ':' + addr.port +
      ' gateways=' + gateways.map((g) => g.host + ':' + g.port).concat('direct').join(',') +
      (opts.healthUrl ? ' health=' + opts.healthUrl : '') + '\n');

    const shutdown = () => {
      dispatcher.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(err.message + '\n');
      process.exitCode = 2;
    } else {
      process.stderr.write('error: ' + (err && err.message ? err.message : String(err)) + '\n');
      process.exitCode = 1;
    }
  }
}

/** 入口判断：npm 通过符号链接调用时，argv[1] 与真实路径不同，必须 realpath 比较。 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) {
    return false;
  }
}

if (isMain()) {
  main();
}
