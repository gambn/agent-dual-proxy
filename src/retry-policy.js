/** 幂等集合按 RFC 9110 §9.2.2；方法名大小写不敏感，未知方法按非幂等。 */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']);
const IDEMPOTENCY_HEADERS = new Set(['idempotency-key', 'x-idempotency-key']);

export function isIdempotent(method) {
  return IDEMPOTENT.has(String(method || '').toUpperCase());
}

/**
 * 请求是否带了一个非空的幂等键。只看值是否存在，不校验格式，也不记录值。
 * 头名大小写不敏感；数组值里任意一个非空即算有键。
 */
export function hasIdempotencyKey(headers) {
  if (!headers || typeof headers !== 'object') return false;
  for (const [name, value] of Object.entries(headers)) {
    if (!IDEMPOTENCY_HEADERS.has(String(name).toLowerCase())) continue;
    if (Array.isArray(value)) {
      if (value.some((item) => String(item).trim())) return true;
    } else if (String(value === undefined || value === null ? '' : value).trim()) {
      return true;
    }
  }
  return false;
}

/**
 * 连接已建立（请求体可能已交给网关）之后失败时，是否允许换路重放。
 * sent=false 时请求体一定没交出去，任何方法都可以重放。
 *
 * 优先级：未发送 → 幂等方法 → 全局开关 → 显式幂等键。
 */
export function shouldRetryAfterSend({
  method,
  sent,
  retryNonIdempotentAfterSend = false,
  retryNonIdempotentWithIdempotencyKey = false,
  idempotencyKey = false
}) {
  if (!sent) return true;
  if (isIdempotent(method)) return true;
  if (retryNonIdempotentAfterSend) return true;
  return Boolean(retryNonIdempotentWithIdempotencyKey && idempotencyKey);
}
