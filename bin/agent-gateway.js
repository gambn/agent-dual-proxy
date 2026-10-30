#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createDispatcher } from '../src/server.js';
import { resolveAgent, buildProxyEnv, proxyUrl } from '../src/agents.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const LAUNCHER_OPTS = [
  '--listen-host', '--listen-port', '--upstream-host', '--upstream-port',
  '--gateway', '--health-url', '--health-interval-ms', '--timeout-ms'
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
    'Agents: claude, codex, gemini, pi',
    '',
    'Options:',
    '  --listen-host <host>        default 127.0.0.1',
    '  --listen-port <port>        default 7898',
    '  --upstream-host <host>      default 127.0.0.1',
    '  --upstream-port <port>      default 7897',
    '  --gateway <host:port>       extra candidate gateway, repeatable',
    '  --health-url <url>          verify the channel with this URL, default off',
    '  --health-interval-ms <ms>   default 60000, 0 disables',
    '  --timeout-ms <ms>           per-attempt timeout, default 5000',
    '  -h, --help',
    '  -v, --version',
    ''
  ].join('\n'));
}

function parseArgs(argv, env = process.env) {
  const opts = {
    listenHost: env.LISTEN_HOST || '127.0.0.1',
    listenPort: Number(env.LISTEN_PORT || 7898),
    upstreamHost: env.UPSTREAM_HOST || '127.0.0.1',
    upstreamPort: Number(env.UPSTREAM_PORT || 7897),
    gateways: [],
    healthUrl: env.HEALTH_URL || '',
    healthIntervalMs: Number(env.HEALTH_INTERVAL_MS || 60000),
    attemptTimeoutMs: Number(env.ATTEMPT_TIMEOUT_MS || 5000)
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
    if (!arg.startsWith('--')) {
      rest.push(...argv.slice(i));
      break;
    }
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error('missing value for ' + arg);
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (!LAUNCHER_OPTS.includes(arg)) {
      // 不认识的开关当作目标 agent 的参数（例如 claude 自己的 --resume）
      rest.push(...argv.slice(i));
      break;
    }
    const value = next();
    if (arg === '--listen-host') opts.listenHost = value;
    else if (arg === '--listen-port') opts.listenPort = Number(value);
    else if (arg === '--upstream-host') opts.upstreamHost = value;
    else if (arg === '--upstream-port') opts.upstreamPort = Number(value);
    else if (arg === '--gateway') opts.gateways.push(value);
    else if (arg === '--health-url') opts.healthUrl = value;
    else if (arg === '--health-interval-ms') opts.healthIntervalMs = Number(value);
    else if (arg === '--timeout-ms') opts.attemptTimeoutMs = Number(value);
  }

  return { opts, rest, explicit };
}

/** 端口上已经有东西在听就复用，别抢端口。 */
// ponytail: 只判「有人在听」就复用，不验证它是不是本代理；跑错的监听会静默被当上游用。
function portInUse(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.listen(port, host, () => server.close(() => resolve(false)));
  });
}

async function serve(opts) {
  const url = proxyUrl(opts);
  if (await portInUse(opts.listenHost, opts.listenPort)) {
    process.stderr.write('[agent-gateway] reusing existing listener on ' + url + '\n');
    return { url, close: async () => {} };
  }
  const dispatcher = createDispatcher({
    listenHost: opts.listenHost,
    listenPort: opts.listenPort,
    upstreamHost: opts.upstreamHost,
    upstreamPort: opts.upstreamPort,
    gateways: opts.gateways,
    healthUrl: opts.healthUrl,
    healthIntervalMs: opts.healthIntervalMs,
    attemptTimeoutMs: opts.attemptTimeoutMs,
    log: (msg) => process.stderr.write('[agent-gateway] ' + msg + '\n')
  });
  await dispatcher.listen();
  dispatcher.startHealth();
  process.stderr.write('[agent-gateway] listening on ' + url + '\n');
  return { url, close: () => dispatcher.stopHealth() || dispatcher.close() };
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
      + '\n  known: claude, codex, gemini, pi\n  or: agent-gateway run -- <cmd> [args...]\n');
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
}

async function printEnv(argv) {
  const { opts } = parseArgs(argv);
  const env = buildProxyEnv(proxyUrl(opts), {});
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  process.stdout.write(keys.map((key) => 'export ' + key + '=' + env[key]).join('\n') + '\n');
}

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
