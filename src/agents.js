/**
 * 主流 AGENT 的适配表与环境构造。
 *
 * 这些 CLI agent 没有共用的插件 API，唯一通杀的是 HTTP(S)_PROXY 环境变量，
 * 所以适配层只做两件事：起一个双路代理，把变量塞进子进程环境里再 exec。
 */
export const AGENTS = {
  claude: { bin: 'claude', note: 'Claude Code' },
  codex: { bin: 'codex', note: 'Codex CLI' },
  gemini: { bin: 'gemini', note: 'Gemini CLI' },
  pi: { bin: 'pi', note: 'pi' }
};

/** 按名字取适配项；不认识的返回 null，由 CLI 负责报错。 */
export function resolveAgent(name) {
  if (typeof name !== 'string') return null;
  return AGENTS[name.trim().toLowerCase()] || null;
}

export function proxyUrl({ listenHost = '127.0.0.1', listenPort }) {
  return 'http://' + listenHost + ':' + listenPort;
}

/** 回环地址一律直连：agent 自己的本地端口（hook、LSP、语言服务器）不能被代理吞掉。 */
const LOCAL_BYPASS = 'localhost,127.0.0.1,::1,0.0.0.0';

/** 生成子进程环境：四份大小写变量 + 本地绕过，其余原样继承。 */
export function buildProxyEnv(url, base = process.env) {
  return {
    ...base,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: LOCAL_BYPASS,
    no_proxy: LOCAL_BYPASS
  };
}
