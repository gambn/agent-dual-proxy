import net from 'node:net';
import tls from 'node:tls';

/** 隧道 socket 的通用参数：让死连接更快被发现，小包不被攒着发。 */
function tune(sock) {
  try {
    sock.setKeepAlive(true, 30000);
    sock.setNoDelay(true);
  } catch (e) {
    /* ignore */
  }
}

/**
 * 直连目标，成功回 socket，失败/超时回 null。
 * 只做 TCP 连接，不做 TLS——TLS 由 probeTls 或客户端自己完成。
 */
export function connectDirect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('error', onError);
      if (!value) sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const onError = () => done(null);
    sock.once('connect', () => {
      tune(sock);
      done(sock);
    });
    sock.once('error', onError);
  });
}

/**
 * 经上游 HTTP 代理建 CONNECT 隧道，成功回 socket，失败/超时回 null。
 * 返回的 socket 处于隧道中，可直接写目标协议（TLS 由调用方/客户端完成）。
 */
export function connectViaProxy(upstream, host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      if (!value) sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      if (head.indexOf('\r\n\r\n') === -1) {
        if (head.length > 16384) done(null);
        return;
      }
      const statusLine = head.slice(0, head.indexOf('\r\n'));
      if (/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        tune(sock);
        done(sock);
      } else {
        done(null);
      }
    };
    const onError = () => done(null);
    sock.on('data', onData);
    sock.on('error', onError);
    sock.write(
      'CONNECT ' + host + ':' + port + ' HTTP/1.1\r\n' +
      'Host: ' + host + ':' + port + '\r\n' +
      'Proxy-Connection: keep-alive\r\n\r\n'
    );
  });
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
      client = tls.connect({ socket: sock, servername, rejectUnauthorized: false });
      client.once('secureConnect', () => finish(client));
      client.once('error', () => finish(null));
    } catch (e) {
      finish(null);
    }
  });
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
      'Host: ' + host + '\r\n' +
      'User-Agent: agent-dual-proxy\r\n' +
      'Connection: close\r\n\r\n'
    );
  });
}
