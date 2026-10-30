/**
 * 按 host 记住上一次走通的路，避免每个请求都重新诊断。
 *
 * 只存 host（不带端口）——同一 host 的不同端口通常同属一个服务，
 * 共享偏好能少一次探测；TTL 到期自动失效。
 */
export function createPref(ttlMs, now) {
  const clock = now || Date.now;
  const map = new Map();

  return {
    get(host) {
      const entry = map.get(host);
      if (!entry) return null;
      if (clock() - entry.at > ttlMs) {
        map.delete(host);
        return null;
      }
      return entry.via;
    },
    set(host, via) {
      map.set(host, { via, at: clock() });
    },
    delete(host) {
      map.delete(host);
    },
    size() {
      return map.size;
    }
  };
}
