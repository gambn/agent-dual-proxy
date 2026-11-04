/** 网关候选：把配置与启动环境里的代理地址归一化成 {host, port, auth?}。 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ENV_NAMES = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY'];

/** upstreamUrl 解析失败：消息里不含原始 URL 或 userinfo。 */
export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
    this.code = 'EUPSTREAMURL';
  }
}

/** 把 userinfo 编成 Proxy-Authorization 的 Basic 值；没有凭证回 null。 */
function basicAuth(url) {
  if (!url.username && !url.password) return null;
  try {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  } catch (e) {
    return null;
  }
}

/**
 * 解析 `host:port`、`http://host:port` 或带 userinfo 的 HTTP 代理 URL，失败回 null。
 * 0.7.0 只支持明文 HTTP CONNECT 代理；`https://` 一律拒绝，避免把 CONNECT 明文发给
 * 实际期望 TLS 的端口。
 */
export function parseGateway(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;

  let url;
  try {
    url = new URL(text.includes('://') ? text : 'http://' + text);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'http:') return null;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 80);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const auth = basicAuth(url);
  if ((url.username || url.password) && !auth) return null;
  return auth ? { host, port, auth } : { host, port };
}

/** 去掉 userinfo 的展示形式；只用于警告/错误，不用于连接。 */
export function redactGateway(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '<empty>';
  try {
    const url = new URL(text.includes('://') ? text : 'http://' + text);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) return '<invalid>';
    const shown = host.includes(':') ? '[' + host + ']' : host;
    return url.protocol + '//' + shown + (url.port ? ':' + url.port : '');
  } catch (e) {
    return '<invalid>';
  }
}

/** 拒绝原因：https/socks 与普通非法值分开，便于调用方给出可操作的提示。 */
function rejectReason(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (/^\s*https:\/\//i.test(text)) return 'https upstream proxy is not supported';
  if (/^\s*socks[45h]?[a-z]*:\/\//i.test(text)) {
    return 'socks upstream is not supported (only http:// proxies); skipped — expected when ALL_PROXY is set';
  }
  return 'invalid gateway';
}

/**
 * 汇总候选网关：配置的上游、额外网关、启动环境里的代理，去重并排除自身监听端口。
 * `direct` 不在这里，由调用方补在最后。
 *
 * 同一 host:port 只保留一条，但会合并凭证：无 auth + 有 auth → 补上；
 * 两边都有且不同 → 保留第一条并回调 warning（subject 已脱敏）。
 */
export function collectGateways({ upstream, extra = [], env = {}, self, onInvalid } = {}) {
  const list = [];
  // 同一个坏值常同时出现在大小写两份环境变量里（ALL_PROXY/all_proxy），只报一次
  const warned = new Set();
  const warn = (subject, reason) => {
    const key = subject + '\u0000' + reason;
    if (warned.has(key)) return;
    warned.add(key);
    if (typeof onInvalid === 'function') onInvalid(subject, reason);
  };
  const add = (gateway, raw) => {
    const fallback = gateway && gateway.host
      ? String(gateway.host) + ':' + String(gateway.port)
      : raw;
    if (!gateway) {
      warn(redactGateway(fallback), rejectReason(fallback));
      return;
    }
    const host = String(gateway.host || '');
    const port = Number(gateway.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      warn(redactGateway(fallback), 'invalid gateway');
      return;
    }
    const isSelf = self !== undefined && self !== null && port === Number(self.port) &&
      LOOPBACK.has(host) && LOOPBACK.has(String(self.host || ''));
    if (isSelf) return;

    const existing = list.find((item) => item.host === host && item.port === port);
    if (existing) {
      if (!existing.auth && gateway.auth) {
        existing.auth = gateway.auth;
      } else if (existing.auth && gateway.auth && existing.auth !== gateway.auth) {
        warn(host + ':' + port, 'conflicting proxy credentials; keeping first');
      }
      return;
    }
    list.push(gateway.auth ? { host, port, auth: gateway.auth } : { host, port });
  };

  if (upstream) add(typeof upstream === 'string' ? parseGateway(upstream) : upstream, upstream);
  for (const item of extra) {
    add(typeof item === 'string' ? parseGateway(item) : item, item);
  }
  for (const name of ENV_NAMES) {
    if (env[name] !== undefined && env[name] !== null && String(env[name]).trim()) {
      add(parseGateway(env[name]), env[name]);
    }
  }
  return list;
}

/**
 * 解析上游：upstreamUrl 非空时替换 host/port/auth；为空时沿用 host/port。
 * 非法值抛 UpstreamError（消息已脱敏），由 index/CLI 分别转成日志或退出码 2。
 */
export function resolveUpstream({ upstreamUrl, upstreamHost = '127.0.0.1', upstreamPort = 7897 } = {}) {
  const text = String(upstreamUrl === undefined || upstreamUrl === null ? '' : upstreamUrl).trim();
  if (text) {
    if (/^https:\/\//i.test(text)) {
      throw new UpstreamError('invalid upstreamUrl: https upstream proxy is not supported (userinfo redacted)');
    }
    const parsed = parseGateway(text);
    if (!parsed) throw new UpstreamError('invalid upstreamUrl (userinfo redacted)');
    return parsed;
  }
  const host = String(upstreamHost || '127.0.0.1');
  const port = Number(upstreamPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UpstreamError('invalid upstreamHost/upstreamPort');
  }
  return { host, port };
}

/** 这个 host 是不是回环地址（用于“非回环绑定”告警）。 */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').toLowerCase());
}

/** 归一化成候选列表（最后一条 direct），供 dispatcher 使用。 */
export function buildCandidates(upstream, gateways = [], self, onInvalid) {
  return collectGateways({ upstream, extra: gateways, self, onInvalid })
    .map((gateway) => Object.assign({ id: gateway.host + ':' + gateway.port }, gateway))
    .concat({ id: 'direct', direct: true });
}
