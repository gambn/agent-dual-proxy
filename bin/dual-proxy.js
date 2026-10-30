#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createDispatcher } from '../src/server.js';
import { collectGateways } from '../src/gateways.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

function usage() {
  process.stdout.write([
    'dual-proxy ' + pkg.version,
    '',
    'Usage: dual-proxy [options]',
    '',
    'Options:',
    '  --listen-host <host>    default 127.0.0.1',
    '  --listen-port <port>    default 7898',
    '  --upstream-host <host>  default 127.0.0.1',
    '  --upstream-port <port>  default 7897',
    '  --gateway <host:port>   extra candidate gateway, repeatable',
    '  --health-url <url>      verify the channel with this URL, default off',
    '  --health-interval-ms <ms>  default 60000, 0 disables',
    '  --fast-fail-ms <ms>     timeout for the known path, default 2000',
    '  --cooldown-ms <ms>      failed gateways rest this long, default 30000',
    '  --timeout-ms <ms>       per-attempt timeout, default 5000',
    '  --pref-ttl-ms <ms>      per-host preference TTL, default 60000',
    '  --no-verify-tls         skip the TLS reachability probe on 443',
    '  -h, --help              show this help',
    '  -v, --version           print version',
    '',
    'Env fallbacks: LISTEN_HOST / LISTEN_PORT / UPSTREAM_HOST / UPSTREAM_PORT /',
    '               GATEWAY / HEALTH_URL / HEALTH_INTERVAL_MS / FAST_FAIL_MS /',
    '               COOLDOWN_MS / ATTEMPT_TIMEOUT_MS / PREF_TTL_MS / VERIFY_TLS=0',
    ''
  ].join('\n'));
}

function parseArgs(argv, env) {
  const opts = {
    listenHost: env.LISTEN_HOST || '127.0.0.1',
    listenPort: Number(env.LISTEN_PORT || 7898),
    upstreamHost: env.UPSTREAM_HOST || '127.0.0.1',
    upstreamPort: Number(env.UPSTREAM_PORT || 7897),
    attemptTimeoutMs: Number(env.ATTEMPT_TIMEOUT_MS || 5000),
    prefTtlMs: Number(env.PREF_TTL_MS || 60000),
    gateways: env.GATEWAY ? [env.GATEWAY] : [],
    healthUrl: env.HEALTH_URL || '',
    healthIntervalMs: Number(env.HEALTH_INTERVAL_MS || 60000),
    fastFailTimeoutMs: Number(env.FAST_FAIL_MS || 2000),
    cooldownMs: Number(env.COOLDOWN_MS || 30000),
    verifyTls: env.VERIFY_TLS !== '0'
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error('missing value for ' + arg);
      return argv[i];
    };
    switch (arg) {
      case '--listen-host': opts.listenHost = next(); break;
      case '--listen-port': opts.listenPort = Number(next()); break;
      case '--upstream-host': opts.upstreamHost = next(); break;
      case '--upstream-port': opts.upstreamPort = Number(next()); break;
      case '--gateway': opts.gateways.push(next()); break;
      case '--health-url': opts.healthUrl = next(); break;
      case '--health-interval-ms': opts.healthIntervalMs = Number(next()); break;
      case '--fast-fail-ms': opts.fastFailTimeoutMs = Number(next()); break;
      case '--cooldown-ms': opts.cooldownMs = Number(next()); break;
      case '--timeout-ms': opts.attemptTimeoutMs = Number(next()); break;
      case '--pref-ttl-ms': opts.prefTtlMs = Number(next()); break;
      case '--no-verify-tls': opts.verifyTls = false; break;
      case '-h':
      case '--help': opts.help = true; break;
      case '-v':
      case '--version': opts.version = true; break;
      default: throw new Error('unknown option: ' + arg);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv, process.env);
  } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exitCode = 2;
    return;
  }
  if (opts.help) { usage(); return; }
  if (opts.version) { process.stdout.write(pkg.version + '\n'); return; }

  const gateways = collectGateways({
    upstream: { host: opts.upstreamHost, port: opts.upstreamPort },
    extra: opts.gateways,
    env: process.env,
    self: { host: opts.listenHost, port: opts.listenPort }
  });
  const dispatcher = createDispatcher(Object.assign({}, opts, { gateways }));
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
}

main();
