import net from 'node:net';
import tls from 'node:tls';

/** 挂在隧道 socket 上：CONNECT 200 之后同包到达的早期数据。 */
export const LEFTOVER = Symbol('agent-dual-proxy.leftover');

/** 隧道 socket 的通用参数：让死连接更快被发现，小包不被攒着发。 */
function tune(sock) {
  try {
    sock.setKeepAlive(true, 30000);
    sock.setNoDelay(true);
  } catch (e) {
    /* ignore */
  }
}

function timeoutError(message) {
  const err = new Error(message);
  err.code = 'ETIMEDOUT';
  return err;
}

/**
 * 直连目标，返回带 phase 的结果：成功 {sock, phase:null}，失败 {sock:null, phase}。
 * phase 只用于冷却分类；连接失败统一记 direct-connect。
 */
export function connectDirectDetailed(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    // 兜底监听：超时/销毁后底层若再冒 error，不能变成未捕获异常
    sock.on('error', () => {});
    let settled = false;
    const done = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('error', onError);
      if (!value) sock.destroy();
      resolve(value
        ? { sock: value, phase: null, error: null }
        : { sock: null, phase: 'direct-connect', error: error || null });
    };
    const timer = setTimeout(() => done(null, timeoutError('direct connect timeout')), timeoutMs);
    const onError = (err) => done(null, err);
    sock.once('connect', () => {
      tune(sock);
      done(sock);
    });
    sock.once('error', onError);
  });
}

/** 兼容旧调用：只回 socket/null。TLS 由 probeTls 或客户端自己完成。 */
export async function connectDirect(host, port, timeoutMs) {
  const result = await connectDirectDetailed(host, port, timeoutMs);
  return result.sock;
}

/**
 * 经上游 HTTP 代理建 CONNECT 隧道，返回带 phase 的结果。
 *
 * phase 区分：
 *   proxy-connect  —— 到代理的 TCP/DNS/建连失败
 *   proxy-auth     —— 代理返回 407
 *   proxy-response —— 代理 accepted 但没有回响应头/响应头非法
 *   proxy-reset    —— 代理在响应头前 reset
 *   target-connect —— 代理回了非 200（目标 CONNECT 失败）
 */
export function connectViaProxyDetailed(upstream, host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port });
    sock.on('error', () => {});
    let settled = false;
    let connected = false;
    const done = (value, phase, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      if (!value) sock.destroy();
      resolve(value
        ? { sock: value, phase: null, error: null }
        : { sock: null, phase, error: error || null });
    };
    const timer = setTimeout(
      () => done(null, connected ? 'proxy-response' : 'proxy-connect', timeoutError('proxy connect timeout')),
      timeoutMs
    );
    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 16384) done(null, 'proxy-response', new Error('proxy response too large'));
        return;
      }
      const statusLine = head.slice(0, head.indexOf('\r\n'));
      const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(statusLine);
      if (!match) {
        done(null, 'proxy-response', new Error('invalid proxy response'));
        return;
      }
      const status = Number(match[1]);
      if (status === 200) {
        // 200 之后同包到达的隧道数据（服务端先发言的 banner）留给调用方转交。
        // 不能 unshift：socket 处于 flowing 模式，此刻没有 data 监听，数据会被丢掉。
        const leftover = head.slice(end + 4);
        if (leftover) sock[LEFTOVER] = Buffer.from(leftover, 'latin1');
        tune(sock);
        done(sock);
        return;
      }
      if (status === 407) {
        done(null, 'proxy-auth', Object.assign(new Error('proxy authentication required'), {
          code: 'EPROXYAUTH',
          status
        }));
        return;
      }
      done(null, 'target-connect', Object.assign(new Error('proxy CONNECT failed: ' + status), {
        code: 'ECONNECTFAILED',
        status
      }));
    };
    const onError = (err) => {
      const phase = connected
        ? (err && err.code === 'ECONNRESET' ? 'proxy-reset' : 'proxy-response')
        : 'proxy-connect';
      done(null, phase, err);
    };
    sock.on('connect', () => { connected = true; });
    sock.on('data', onData);
    sock.on('error', onError);
    sock.write(
      'CONNECT ' + host + ':' + port + ' HTTP/1.1\r\n' +
      'Host: ' + host + ':' + port + '\r\n' +
      (upstream.auth ? 'Proxy-Authorization: ' + upstream.auth + '\r\n' : '') +
      'Proxy-Connection: keep-alive\r\n\r\n'
    );
  });
}

/** 兼容旧调用：只回 socket/null。 */
export async function connectViaProxy(upstream, host, port, timeoutMs) {
  const result = await connectViaProxyDetailed(upstream, host, port, timeoutMs);
  return result.sock;
}

/**
 * 对一条路做 TLS 握手探测：能完成握手才算“到得了”。
 *
 * 只测连通性，不校验证书（rejectUnauthorized: false）——探测的目的不是信任，
 * 而是判断这条路能不能承载 TLS。探测连接用完即毁，不会交给客户端。
 */
export async function probeTls(open, host, port, timeoutMs) {
  const sock = await open(host, port, timeoutMs);
  if (!sock) return false;

  const client = await tlsOver(sock, host, timeoutMs);
  if (client) {
    client.destroy();
    return true;
  }
  sock.destroy();
  return false;
}

/**
 * 带 phase 的 TLS 探测：打开失败沿用 open 的 phase；打开成功但握手失败记 tls。
 * 只给选路/冷却用，不改变 probeTls 的旧接口。
 */
export async function probeTlsDetailed(open, host, port, timeoutMs) {
  const opened = await open(host, port, timeoutMs);
  if (!opened || !opened.sock) {
    return { ok: false, phase: (opened && opened.phase) || 'direct-connect' };
  }
  const client = await tlsOver(opened.sock, host, timeoutMs);
  if (client) {
    client.destroy();
    return { ok: true, phase: null };
  }
  opened.sock.destroy();
  return { ok: false, phase: 'tls' };
}

/** 在一条路上完成 TLS 握手，返回已加密的 socket；失败回 null。 */
function tlsOver(sock, servername, timeoutMs) {
  return new Promise((resolve) => {
    let client;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!value && client) { try { client.destroy(); } catch (e) { /* ignore */ } }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const options = { socket: sock, rejectUnauthorized: false };
      // 目标是 IP 字面量时不要设 servername（Node 会报 DEP0123 并忽略）
      if (net.isIP(servername) === 0) options.servername = servername;
      client = tls.connect(options);
      client.once('secureConnect', () => finish(client));
      client.once('error', () => finish(null));
    } catch (e) {
      finish(null);
    }
  });
}

/** HTTP 请求行里的 Host：IPv6 加方括号，非默认端口带端口。 */
export function hostHeader(host, port, secure) {
  const name = net.isIP(host) === 6 ? '[' + host + ']' : host;
  const defaultPort = secure ? 443 : 80;
  return Number(port) === defaultPort ? name : name + ':' + port;
}

/**
 * 在一条路上发一个 HTTP 请求，只看响应状态码——用来验证“通道真的通到应用层”。
 *
 * 与 probeTls 一样不校验证书：这里判断的是可达性，不是信任。任何 < 500 的响应
 * 都算通道顺畅（401/403 说明端点活着，只是没带凭证）。失败/超时回 null。
 */
export async function probeHttp(open, host, port, path, secure, timeoutMs) {
  const sock = await open(host, port, timeoutMs);
  if (!sock) return null;

  let target = sock;
  if (secure) {
    target = await tlsOver(sock, host, timeoutMs);
    if (!target) { try { sock.destroy(); } catch (e) { /* ignore */ } return null; }
  }

  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeListener('data', onData);
      target.removeListener('error', onError);
      try { target.destroy(); } catch (e) { /* ignore */ }
      if (target !== sock) { try { sock.destroy(); } catch (e) { /* ignore */ } }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (match) { finish(Number(match[1])); return; }
      if (buf.length > 16384) finish(null);
    };
    const onError = () => finish(null);
    target.on('data', onData);
    target.on('error', onError);
    target.write(
      'GET ' + path + ' HTTP/1.1\r\n' +
      'Host: ' + hostHeader(host, port, secure) + '\r\n' +
      'User-Agent: agent-dual-proxy\r\n' +
      'Connection: close\r\n\r\n'
    );
  });
}
