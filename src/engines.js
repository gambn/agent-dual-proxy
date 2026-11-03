/** Node 版本门槛：只用到内置 http/net/tls，跟随当前维护中的 LTS 主版本。 */
export const MIN_NODE = '22.0.0';

function parts(version) {
  return String(version)
    .split('-')[0]
    .split('.')
    .map((value) => Number.parseInt(value, 10) || 0);
}

/** 版本比较；只比较 major.minor.patch。 */
export function nodeAtLeast(version, min = MIN_NODE) {
  const [a, b, c] = parts(version);
  const [x, y, z] = parts(min);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

/** 低于门槛时抛出可读错误，避免在运行期报出看不懂的语法/API 错误。 */
export function assertNode(version = process.versions.node) {
  if (!nodeAtLeast(version)) {
    throw new Error('agent-dual-proxy requires Node >= ' + MIN_NODE + ' (current ' + version + ')');
  }
}
