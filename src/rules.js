/**
 * 目的地分流规则：按目标 host 决定先直连还是先走代理。
 *
 * 规则是显式意图，不是自动分类。它只在 hot 区调整顺序，不改变可达性，
 * 也不把冷却中的网关拉回来；未命中规则的 host 维持原行为。
 */

/** 逗号分隔的模式串 → 数组（去空白、去空项）；空值回空数组。 */
export function splitPatterns(value) {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 单模式匹配：大小写不敏感；含 `*` 按 glob 匹配（`*` 匹配任意字符段），
 * 否则要求整 host 相等。`*.cn` 不匹配 `cn` 或 `deepseek.cn` 本身；
 * 要覆盖 apex 必须显式写 `deepseek.cn`。
 */
export function matchPattern(host, pattern) {
  const p = String(pattern || '').trim().toLowerCase();
  if (!p) return false;
  const h = String(host || '').toLowerCase();
  if (!p.includes('*')) return h === p;
  const source = p
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + source + '$').test(h);
}

/**
 * 编译规则集 → `decide(host)` 返回 'direct' | 'proxy' | null。
 * 两份名单都命中时 preferDirect 先判（直连优先）。
 */
export function createRouteDecision({ preferDirect = [], preferProxy = [] } = {}) {
  const direct = preferDirect.filter(Boolean);
  const proxy = preferProxy.filter(Boolean);
  if (direct.length === 0 && proxy.length === 0) {
    return () => null;
  }
  return (host) => {
    for (const pattern of direct) {
      if (matchPattern(host, pattern)) return 'direct';
    }
    for (const pattern of proxy) {
      if (matchPattern(host, pattern)) return 'proxy';
    }
    return null;
  };
}
