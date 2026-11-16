import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';

/** 本地身份端点：发现时用来跳过兄弟代理实例。 */
export const IDENTITY_PATH = '/__agent_dual_proxy__';
export const IDENTITY_HEADER = 'x-agent-dual-proxy';
export const DEFAULT_DISCOVERY_LIMIT = 64;
export const DEFAULT_DISCOVERY_MAX = 8;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 800;
export const DEFAULT_DISCOVERY_CONCURRENCY = 8;

function hostPort(host, port) {
  const name = net.isIP(host) === 6 ? '[' + host + ']' : host;
  return name + ':' + port;
}

function parseV4(hex) {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  const bytes = [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255];
  const address = bytes.join('.');
  if (address === '127.0.0.1') return { host: '127.0.0.1', wildcard: false };
  if (address === '0.0.0.0') return { host: '127.0.0.1', wildcard: true };
  return null;
}

function parseV6(hex) {
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const bytes = [];
  for (let word = 0; word < 4; word += 1) {
    const value = Number.parseInt(hex.slice(word * 8, word * 8 + 8), 16);
    bytes.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
  }
  if (bytes.every((byte) => byte === 0)) return { host: '::1', wildcard: true };
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return { host: '::1', wildcard: false };
  }
  return null;
}

/**
 * 解析 /proc/net/tcp 或 /proc/net/tcp6，只返回 LISTEN 且绑定在回环/通配地址的端口。
 * family 为 'tcp' 或 'tcp6'。
 */
export function parseProcNet(text, family = 'tcp') {
  const result = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== '0A') continue;
    const local = fields[1];
    const split = local.lastIndexOf(':');
    if (split <= 0) continue;
    const port = Number.parseInt(local.slice(split + 1), 16);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const parsed = family === 'tcp6'
      ? parseV6(local.slice(0, split))
      : parseV4(local.slice(0, split));
    if (!parsed) continue;
    result.push({ host: parsed.host, port, wildcard: parsed.wildcard });
  }
  return result;
}

/** 目标 host 是否回环/私网：按目标失败发现只对公网 80/443 生效。 */
export function isPrivateTarget(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!value) return true;
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') ||
      value.endsWith('.internal') || value.endsWith('.lan') || value.endsWith('.home.arpa')) {
    return true;
  }
  const family = net.isIP(value);
  if (family === 4) {
    const parts = value.split('.').map(Number);
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (family === 6) {
    if (value === '::1' || value === '::') return true;
    if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value)) return true;
    return false;
  }
  return false;
}

/** 对一个端口做行为探测：HTTPS 用 CONNECT 2xx，HTTP 用 absolute-form GET <500 且非 407。 */
export function probeProxy({ proxyHost, proxyPort, targetHost, targetPort, secure, timeoutMs, connect = net.connect }) {
  return new Promise((resolve) => {
    const sock = connect({ host: proxyHost, port: proxyPort });
    let settled = false;
    let buffer = '';
    const finish = (ok, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (e) { /* ignore */ }
      resolve({ ok, status: status === undefined ? null : status });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('error', () => finish(false));
    sock.on('connect', () => {
      const target = hostPort(targetHost, targetPort);
      const request = secure
        ? 'CONNECT ' + target + ' HTTP/1.1\r\n' +
          'Host: ' + target + '\r\n' +
          'Proxy-Connection: keep-alive\r\n\r\n'
        : 'GET http://' + target + '/ HTTP/1.1\r\n' +
          'Host: ' + target + '\r\n' +
          'Connection: close\r\n\r\n';
      try { sock.write(request); } catch (e) { finish(false); }
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(buffer);
      if (!match) {
        if (buffer.length > 16384) finish(false);
        return;
      }
      const status = Number(match[1]);
      // HTTP 目标：401/403/404/3xx 都说明代理已到应用层；407 是代理认证，5xx 是坏路。
      const ok = secure ? status >= 200 && status < 300 : status < 500 && status !== 407;
      finish(ok, status);
    });
  });
}

/** 通过身份端点判断端口是不是本插件的兄弟实例；是则跳过，避免串链。 */
export function checkIdentity(proxyHost, proxyPort, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      path: IDENTITY_PATH,
      method: 'GET',
      headers: { host: hostPort(proxyHost, proxyPort), connection: 'close' },
      timeout: timeoutMs
    }, (res) => {
      const isSibling = String(res.headers[IDENTITY_HEADER] || '') === '1';
      res.resume();
      res.on('end', () => { finish(isSibling); req.destroy(); });
      res.on('error', () => finish(false));
    });
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

/**
 * 发现本机回环/通配 LISTEN 端口，并按行为探测筛选可用的 HTTP 代理。
 * 只读 /proc，仅 Linux；其他平台返回空结果。
 */
export async function discoverLocalProxies({
  targetHost,
  targetPort,
  secure,
  excludePorts = new Set(),
  limit = DEFAULT_DISCOVERY_LIMIT,
  maxResults = DEFAULT_DISCOVERY_MAX,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  concurrency = DEFAULT_DISCOVERY_CONCURRENCY,
  readFile = fs.readFile
} = {}) {
  if (!targetHost || !targetPort) return { scanned: 0, results: [] };

  let tcp = '';
  let tcp6 = '';
  try { tcp = await readFile('/proc/net/tcp', 'utf8'); } catch (e) { /* non-Linux or unreadable */ }
  try { tcp6 = await readFile('/proc/net/tcp6', 'utf8'); } catch (e) { /* non-Linux or unreadable */ }
  if (!tcp && !tcp6) return { scanned: 0, results: [] };

  const entries = parseProcNet(tcp, 'tcp').concat(parseProcNet(tcp6, 'tcp6'));
  const seen = new Set();
  const ports = [];
  for (const entry of entries) {
    const key = entry.host + ':' + entry.port;
    if (seen.has(key) || excludePorts.has(entry.port)) continue;
    seen.add(key);
    ports.push(entry);
    if (ports.length >= limit) break;
  }
  ports.sort((a, b) => a.port - b.port);

  const results = [];
  let index = 0;
  const worker = async () => {
    while (results.length < maxResults) {
      const current = index;
      index += 1;
      if (current >= ports.length) return;
      const candidate = ports[current];
      const probe = await probeProxy({
        proxyHost: candidate.host,
        proxyPort: candidate.port,
        targetHost,
        targetPort,
        secure,
        timeoutMs
      });
      if (!probe.ok) continue;
      if (await checkIdentity(candidate.host, candidate.port, timeoutMs)) continue;
      results.push({ host: candidate.host, port: candidate.port, source: 'discovered' });
    }
  };
  const workers = Math.min(Math.max(1, concurrency), ports.length);
  await Promise.all(Array.from({ length: workers }, worker));
  results.sort((a, b) => a.port - b.port);
  return { scanned: ports.length, results: results.slice(0, maxResults) };
}
