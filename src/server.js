import http from 'node:http';
import { connectDirect, connectViaProxy, probeTls, probeHttp, LEFTOVER } from './paths.js';
import { createPref } from './pref.js';
import { buildCandidates } from './gateways.js';
import { hasIdempotencyKey, isIdempotent, shouldRetryAfterSend } from './retry-policy.js';

const DEFAULT_LOG = (msg) => process.stderr.write('[dual-proxy] ' + msg + '\n');

/** 合并配置：显式传入的 undefined 不应覆盖默认值。 */
export function mergeOptions(defaults, options) {
  const merged = Object.assign({}, defaults);
  for (const [key, value] of Object.entries(options || {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'
]);

/** 统一 host 形态：去掉 IPv6 方括号、转小写、去掉 FQDN 末尾的点。 */
function normalizeHost(host) {
  return String(host || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

/** 按 RFC 9110 去掉逐跳标头（含 Connection 里点名的字段）。 */
function stripHopByHop(headers) {
  const dropped = new Set(HOP_BY_HOP);
  for (const token of String(headers.connection || '').toLowerCase().split(',')) {
    const name = token.trim();
    if (name) dropped.add(name);
  }
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!dropped.has(name.toLowerCase())) clean[name] = value;
  }
  return clean;
}

/** 请求方向：清洗后再把 Host 设成目标主机。 */
function sanitizeHeaders(headers, targetHost) {
  return Object.assign(stripHopByHop(headers), { host: targetHost });
}

/** 解析健康检查地址；只接受 http/https。 */
function parseHealthUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const secure = url.protocol === 'https:';
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (secure ? 443 : 80)),
    path: (url.pathname || '/') + (url.search || ''),
    secure
  };
}

/**
 * 启动一个双路代理：在上游网关列表里自动选一条能到达目标的路，失败立刻换。
 *
 * 角色分工：
 *   - CONNECT（HTTPS）：按偏好/健康检查的顺序试候选网关，443 上先做 TLS 探测再开隧道。
 *   - 普通 HTTP：同样按顺序试，失败换路。
 *   - 健康检查：定期用 healthUrl 验证“到应用层”的通道，优先使用验证通过的网关。
 * 只在这一层选路，不向客户端暴露换路过程；全部不通才回 502。
 *
 * @param {object} options
 * @param {string} [options.listenHost='127.0.0.1']
 * @param {number} [options.listenPort=7898]
 * @param {string} [options.upstreamHost='127.0.0.1']
 * @param {number} [options.upstreamPort=7897]
 * @param {(string|object)[]} [options.gateways] 额外网关，`host:port` 或 {host, port}
 * @param {string} [options.healthUrl] 健康检查地址；为空则不做后台验证
 * @param {number} [options.healthIntervalMs=60000] 健康检查间隔；0 关闭
 * @param {number} [options.healthTimeoutMs] 健康检查单次超时，默认同 attemptTimeoutMs
 * @param {number} [options.attemptTimeoutMs=5000]
 * @param {number} [options.prefTtlMs=60000]
 * @param {boolean} [options.verifyTls=true]
 * @param {function} [options.log]
 */
export function createDispatcher(options) {
  const opts = mergeOptions({
    listenHost: '127.0.0.1',
    listenPort: 7898,
    upstreamHost: '127.0.0.1',
    upstreamPort: 7897,
    gateways: [],
    healthUrl: '',
    healthIntervalMs: 60000,
    fastFailTimeoutMs: 2000,
    cooldownMs: 30000,
    retryNonIdempotentAfterSend: false,
    retryNonIdempotentWithIdempotencyKey: false,
    attemptTimeoutMs: 5000,
    responseTimeoutMs: 60000,
    prefTtlMs: 60000,
    prefMaxSize: 1000,
    shutdownTimeoutMs: 1500,
    verifyTls: true,
    log: DEFAULT_LOG
  }, options);

  const log = opts.log;
  const pref = createPref(opts.prefTtlMs, undefined, opts.prefMaxSize);
  const candidates = buildCandidates(
    Object.assign(
      { host: opts.upstreamHost, port: opts.upstreamPort },
      opts.upstreamAuth ? { auth: opts.upstreamAuth } : {}
    ),
    opts.gateways,
    { host: opts.listenHost, port: opts.listenPort },
    (subject, reason) => log('gateway warning: ' + subject + ': ' + reason)
  );
  const publicCandidates = candidates.map((gateway) => (gateway.direct
    ? { id: gateway.id, direct: true }
    : { id: gateway.id, host: gateway.host, port: gateway.port }));
  const health = parseHealthUrl(opts.healthUrl);
  const healthTimeoutMs = opts.healthTimeoutMs || opts.attemptTimeoutMs;

  let preferred = null;
  let healthTimer = null;
  let lastKickAt = 0;
  /** 网关冷却：失败过的候选在一段时间内排到最后，避免每个新 host 都先撞它一次。 */
  const cooldowns = new Map();

  function isCooling(id) {
    const until = cooldowns.get(id);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      cooldowns.delete(id);
      return false;
    }
    return true;
  }

  function cool(id) {
    if (opts.cooldownMs > 0) cooldowns.set(id, Date.now() + opts.cooldownMs);
  }

  function warm(id) {
    cooldowns.delete(id);
  }

  /** 一条路成功/失败时的统一记账：偏好、冷却、健康复检。 */
  function noteSuccess(host, gateway) {
    pref.set(host, gateway.id);
    warm(gateway.id);
  }

  function noteFailure(gateway) {
    cool(gateway.id);
    kickHealth();
  }

  const openVia = (gateway, host, port, timeoutMs = opts.attemptTimeoutMs) => (gateway.direct
    ? connectDirect(host, port, timeoutMs)
    : connectViaProxy(gateway, host, port, timeoutMs));

  /** 候选顺序：健康选中的网关 → 该 host 上次走通的网关 → 其余；冷却中的一律排最后。 */
  function order(host) {
    const hot = [];
    const cold = [];
    for (const gateway of candidates) (isCooling(gateway.id) ? cold : hot).push(gateway);
    const move = (list, id) => {
      const index = list.findIndex((gateway) => gateway.id === id);
      if (index > 0) list.unshift(list.splice(index, 1)[0]);
    };
    if (preferred) move(hot, preferred);
    const cached = pref.get(host);
    if (cached) move(hot, cached);
    return hot.concat(cold);
  }

  /**
   * 依次试候选网关，返回第一个能承载 TLS（443 时）且连通的隧道。
   * 已有已知路径（缓存或健康首选）时，第一条只给 fastFailTimeoutMs —— 它挂了要快点换。
   */
  async function openTunnel(host, port) {
    const known = pref.get(host) || preferred;
    const list = order(host);
    for (let i = 0; i < list.length; i += 1) {
      const gateway = list[i];
      const timeout = i === 0 && known && opts.fastFailTimeoutMs < opts.attemptTimeoutMs
        ? opts.fastFailTimeoutMs
        : opts.attemptTimeoutMs;
      if (port === 443 && opts.verifyTls) {
        const ok = await probeTls(
          (h, p) => openVia(gateway, h, p, timeout), host, port, timeout
        );
        if (!ok) {
          log(host + ':' + port + ' ' + gateway.id + ' TLS probe failed');
          noteFailure(gateway);
          continue;
        }
      }
      const sock = await openVia(gateway, host, port, timeout);
      if (sock) {
        noteSuccess(host, gateway);
        log(host + ':' + port + ' -> ' + gateway.id);
        return sock;
      }
      log(host + ':' + port + ' ' + gateway.id + ' failed');
      noteFailure(gateway);
    }
    log(host + ':' + port + ' all gateways failed');
    return null;
  }

  const MAX_BODY = 8 * 1024 * 1024;   // 超过就不缓冲，也不重试

  /** 所有在途 socket（入站与隧道出站），关闭时用于强制收尾。 */
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };

  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch (e) {
      res.writeHead(400);
      res.end('bad request target');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400);
      res.end('only http:// is proxied here; use CONNECT for https');
      return;
    }

    const host = normalizeHost(target.hostname);
    const port = Number(target.port || 80);
    const headers = sanitizeHeaders(req.headers, target.host);
    const idempotencyKey = hasIdempotencyKey(req.headers);

    // 先缓冲请求体：失败换路时要能重放（模型调用多是 JSON POST）
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { overflow = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        res.writeHead(413);
        res.end('request body too large to retry');
        return;
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;

      // 两段超时：建连用 attempt/fast-fail，等响应头用 responseTimeoutMs；
      // 响应体开始流之后不再计时（长回答可能很慢）。
      // sent 以“到网关/目标的 TCP 连接是否建立”为界，用于决定失败后能否重放。
      const attemptVia = (gateway, connectTimeoutMs) => new Promise((resolve) => {
        const attemptHeaders = gateway.direct || !gateway.auth
          ? headers
          : Object.assign({}, headers, { 'proxy-authorization': gateway.auth });
        const reqOpts = gateway.direct
          ? { host, port, method: req.method, path: target.pathname + target.search, headers: attemptHeaders }
          : { host: gateway.host, port: gateway.port, method: req.method, path: req.url, headers: attemptHeaders };

        let sent = false;
        let connectTimer;
        let headerTimer;
        const clearTimers = () => {
          clearTimeout(connectTimer);
          clearTimeout(headerTimer);
        };
        const fail = (message) => {
          const err = new Error(message);
          err.code = 'ETIMEDOUT';
          clearTimers();
          resolve({ err, sent });
          upstreamReq.destroy(err);
        };

        const upstreamReq = http.request(reqOpts, (up) => {
          clearTimers();
          if (!gateway.direct && up.statusCode === 407) {
            up.resume();
            up.destroy();
            resolve({ err: Object.assign(new Error('proxy authentication required'), { code: 'EPROXYAUTH' }), sent: true });
            return;
          }
          resolve({ up });
        });
        connectTimer = setTimeout(() => fail('gateway connect timeout'), connectTimeoutMs);
        upstreamReq.on('socket', (socket) => {
          const markSent = () => {
            sent = true;
            clearTimeout(connectTimer);
            headerTimer = setTimeout(() => fail('gateway response timeout'), opts.responseTimeoutMs);
          };
          if (socket.connecting) socket.once('connect', markSent);
          else markSent();
        });
        upstreamReq.on('error', (err) => {
          clearTimers();
          resolve({ err, sent });
        });
        upstreamReq.end(body);
      });

      const known = pref.get(host) || preferred;
      const list = order(host);
      (async () => {
        try {
          for (let i = 0; i < list.length; i += 1) {
            const gateway = list[i];
            const timeout = i === 0 && known && opts.fastFailTimeoutMs < opts.attemptTimeoutMs
              ? opts.fastFailTimeoutMs
              : opts.attemptTimeoutMs;
            const r = await attemptVia(gateway, timeout);
            if (r.err) {
              log(host + ' ' + gateway.id + ' failed: ' + (r.err.code || r.err.message));
              noteFailure(gateway);
              // 407 是代理在转发前拒绝，目标没收到请求：无论方法是否幂等都应换下一条。
              if (r.err.code === 'EPROXYAUTH') continue;
              if (!shouldRetryAfterSend({
                method: req.method,
                sent: r.sent,
                retryNonIdempotentAfterSend: opts.retryNonIdempotentAfterSend,
                retryNonIdempotentWithIdempotencyKey: opts.retryNonIdempotentWithIdempotencyKey,
                idempotencyKey
              })) {
                log(host + ' ' + gateway.id + ' failed after send: ' +
                  (r.err.code || r.err.message) + '; not replayed (' + req.method + ')');
                res.writeHead(502);
                res.end('non-idempotent request may have been delivered; not replayed');
                return;
              }
              if (idempotencyKey && !isIdempotent(req.method) &&
                opts.retryNonIdempotentWithIdempotencyKey && !opts.retryNonIdempotentAfterSend) {
                log(host + ' ' + gateway.id + ' failed after send: ' +
                  (r.err.code || r.err.message) + '; retrying (' + req.method + ', idempotency key)');
              }
              continue;
            }
            noteSuccess(host, gateway);
            const up = r.up;
            up.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
            res.on('close', () => {
              if (!res.writableEnded) { try { up.destroy(); } catch (e) { /* ignore */ } }
            });
            res.writeHead(up.statusCode, stripHopByHop(up.headers));
            up.pipe(res);
            return;
          }
          res.writeHead(502);
          res.end('all gateways failed');
        } catch (err) {
          log(host + ' handler error: ' + (err && err.message));
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('proxy error');
          } else {
            try { res.destroy(); } catch (e) { /* ignore */ }
          }
        }
      })();
    });
  });

  // 持久兜底：listen 之后 server 级 error 不能再变成未捕获异常；初始 EADDRINUSE 由 listen() 的
  // 一次性监听负责 reject，这里只记录。
  server.on('error', (err) => log('server error: ' + (err && err.message ? err.message : String(err))));

  server.on('connection', track);

  server.on('connect', async (req, clientSocket, head) => {
    const url = String(req.url);
    const idx = url.lastIndexOf(':');
    const host = normalizeHost(idx === -1 ? url : url.slice(0, idx));
    const port = Number(idx === -1 ? 443 : url.slice(idx + 1)) || 443;

    clientSocket.on('error', () => {});
    try {
      const sock = await openTunnel(host, port);
      if (!sock) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      track(sock);
      const leftover = sock[LEFTOVER];
      if (leftover && leftover.length) clientSocket.write(leftover);
      if (head && head.length) sock.write(head);
      sock.pipe(clientSocket);
      clientSocket.pipe(sock);
      sock.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => sock.destroy());
    } catch (err) {
      log('connect handler error: ' + (err && err.message));
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) { /* ignore */ }
    }
  });

  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ }
  });

  /** 用健康检查地址验证通道：返回第一个 <500 的网关结果，全部失败回 null。 */
  async function checkHealth() {
    if (!health) return null;
    for (const gateway of order(health.host)) {
      const started = Date.now();
      const status = await probeHttp(
        (h, p) => openVia(gateway, h, p),
        health.host, health.port, health.path, health.secure, healthTimeoutMs
      );
      if (typeof status === 'number' && status < 500) {
        return { id: gateway.id, status, ms: Date.now() - started };
      }
    }
    return null;
  }

  /**
   * 验证一次通道；通过就设为全局首选并解除它的冷却，失败就清掉首选让请求重新扫描。
   * 周期检查与失败踢动可能撞在一起，用重入锁保证同一时刻只有一次探测。
   */
  let healthRunning = false;
  async function runHealth() {
    if (healthRunning) return;
    healthRunning = true;
    try {
      let result = null;
      try {
        result = await checkHealth();
      } catch (e) {
        result = null;
      }
      if (result) {
        if (preferred !== result.id) {
          log('health: model channel -> ' + result.id + ' (' + result.status + ', ' + result.ms + 'ms)');
        }
        preferred = result.id;
        pref.set(health.host, result.id);
        warm(result.id);
      } else {
        if (preferred !== null) log('health: no gateway reached ' + health.host + ':' + health.port);
        preferred = null;
        pref.delete(health.host);
      }
    } finally {
      healthRunning = false;
    }
  }

  /** 某条路刚失败时踢一次健康检查，不必等下一个周期；1 秒内只踢一次。 */
  function kickHealth() {
    if (!health || !opts.healthIntervalMs) return;
    const now = Date.now();
    if (now - lastKickAt < 1000) return;
    lastKickAt = now;
    const timer = setTimeout(runHealth, 0);
    if (timer.unref) timer.unref();
  }

  function startHealth() {
    if (!health || !opts.healthIntervalMs) return;
    runHealth();
    healthTimer = setInterval(runHealth, opts.healthIntervalMs);
    if (healthTimer.unref) healthTimer.unref();
  }

  function stopHealth() {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  return {
    server,
    pref,
    candidates: publicCandidates,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('error', onError);
          reject(err);
        };
        server.once('error', onError);
        server.listen(opts.listenPort, opts.listenHost, () => {
          server.removeListener('error', onError);
          resolve(server.address());
        });
      });
    },
    close() {
      stopHealth();
      return new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          for (const socket of sockets) {
            try { socket.destroy(); } catch (e) { /* ignore */ }
          }
          sockets.clear();
          finish();
        }, opts.shutdownTimeoutMs);
        if (timer.unref) timer.unref();
        server.close(() => finish());
      });
    },
    checkHealth,
    runHealth,
    startHealth,
    stopHealth,
    getPreferred: () => preferred,
    isCooling
  };
}
