/**
 * 主流 AGENT 的适配表与环境构造。
 *
 * 这些 CLI agent 没有共用的插件 API，唯一通杀的是 HTTP(S)_PROXY 环境变量，
 * 所以适配层只做两件事：起一个双路代理，把变量塞进子进程环境里再 exec。
 */
export const AGENTS = {
  claude: { bin: 'claude', note: 'Claude Code' },
  codex: { bin: 'codex', note: 'OpenAI Codex CLI' },
  gemini: { bin: 'gemini', note: 'Gemini CLI' },
  pi: { bin: 'pi', note: 'pi' },
  aider: { bin: 'aider', note: 'Aider' },
  opencode: { bin: 'opencode', note: 'OpenCode' },
  qwen: { bin: 'qwen', note: 'Qwen Code' },
  cursor: { bin: 'cursor-agent', note: 'Cursor CLI' },
  droid: { bin: 'droid', note: 'Factory Droid' },
  amp: { bin: 'amp', note: 'Amp' },
  crush: { bin: 'crush', note: 'Charm Crush' },
  goose: { bin: 'goose', note: 'Goose' },
  copilot: { bin: 'copilot', note: 'GitHub Copilot CLI' }
};

/** 适配表里的短名，供用法/报错文本使用。 */
export const AGENT_NAMES = Object.keys(AGENTS);

/** 按名字取适配项；不认识的返回 null，由 CLI 负责报错。 */
export function resolveAgent(name) {
  if (typeof name !== 'string') return null;
  return AGENTS[name.trim().toLowerCase()] || null;
}

export function proxyUrl({ listenHost = '127.0.0.1', listenPort }) {
  const loopback = listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost;
  const host = loopback.includes(':') && !loopback.startsWith('[') ? '[' + loopback + ']' : loopback;
  return 'http://' + host + ':' + listenPort;
}

/** 回环地址一律直连：agent 自己的本地端口（hook、LSP、语言服务器）不能被代理吞掉。 */
const LOCAL_BYPASS = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];

/**
 * 生成子进程环境：代理变量大小写各一份，其余原样继承。
 *
 * ALL_PROXY 也指向本代理：启动环境里的 socks ALL_PROXY 会让客户端绕过
 * HTTP(S)_PROXY，双路选路就白做了。NO_PROXY 是合并而不是覆盖，避免丢掉
 * 用户原有的内网直连段。
 */
export function buildProxyEnv(url, base = process.env) {
  const env = { ...base };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    env[key] = url;
  }
  const noProxy = [...LOCAL_BYPASS];
  for (const item of String(base.NO_PROXY ?? base.no_proxy ?? '').split(',')) {
    const value = item.trim();
    if (value && !noProxy.includes(value)) noProxy.push(value);
  }
  env.NO_PROXY = noProxy.join(',');
  env.no_proxy = env.NO_PROXY;
  return env;
}
