/** 网关候选：把配置与启动环境里的代理地址归一化成 {host, port}。 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const ENV_NAMES = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY'];

/** 解析 `host:port`、`http://host:port` 或 `https://host:port/`，失败回 null。 */
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
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * 汇总候选网关：配置的上游、额外网关、启动环境里的代理，去重并排除自身监听端口。
 * `direct` 不在这里，由调用方补在最后。
 */
export function collectGateways({ upstream, extra = [], env = {}, self } = {}) {
  const list = [];
  const add = (gateway) => {
    if (!gateway) return;
    const host = String(gateway.host || '');
    const port = Number(gateway.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const isSelf = self !== undefined && self !== null && port === Number(self.port) &&
      LOOPBACK.has(host) && LOOPBACK.has(String(self.host || ''));
    if (isSelf) return;
    if (list.some((item) => item.host === host && item.port === port)) return;
    list.push({ host, port });
  };

  if (upstream) add(upstream);
  for (const item of extra) {
    add(typeof item === 'string' ? parseGateway(item) : item);
  }
  for (const name of ENV_NAMES) {
    if (env[name] !== undefined && env[name] !== null && String(env[name]).trim()) add(parseGateway(env[name]));
  }
  return list;
}

/** 归一化成候选列表（最后一条 direct），供 dispatcher 使用。 */
export function buildCandidates(upstream, gateways = []) {
  return collectGateways({ upstream, extra: gateways })
    .map((gateway) => ({ host: gateway.host, port: gateway.port, id: gateway.host + ':' + gateway.port }))
    .concat({ id: 'direct', direct: true });
}
