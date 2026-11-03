/**
 * 按 host 记住上一次走通的路，避免每个请求都重新诊断。
 *
 * 只存 host（不带端口）——同一 host 的不同端口通常同属一个服务，
 * 共享偏好能少一次探测；TTL 到期自动失效。
 */
export function createPref(ttlMs, now, maxSize = 1000) {
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
      // 访问即刷新顺序，淘汰时先丢最久没用过的
      map.delete(host);
      map.set(host, entry);
      return entry.via;
    },
    set(host, via) {
      if (map.has(host)) {
        map.delete(host);
      } else if (maxSize > 0 && map.size >= maxSize) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
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
