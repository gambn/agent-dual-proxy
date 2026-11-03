import http from 'node:http';
import net from 'node:net';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 普通 HTTP 目标：回显方法与前缀，并把收到的关键标头回显在响应头里 */
export async function startTarget() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-target': 'yes',
        'x-echo-host': String(req.headers.host || ''),
        'x-echo-proxy-connection': String(req.headers['proxy-connection'] || ''),
        'x-echo-proxy-authorization': String(req.headers['proxy-authorization'] || ''),
        'x-echo-idempotency-key': String(req.headers['idempotency-key'] || ''),
        'x-echo-custom': String(req.headers['x-custom'] || '')
      });
      res.end('target:' + req.method + ':' + body);
    });
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 假上游代理：普通 HTTP 转发并加 x-via，CONNECT 建隧道 */
export async function startFakeProxy(tag = 'proxy') {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    let url;
    try { url = new URL(req.url); } catch (e) { res.writeHead(400); res.end('bad'); return; }
    const up = http.request({
      host: url.hostname,
      port: Number(url.port || 80),
      path: url.pathname + url.search,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: url.host })
    }, (upRes) => {
      res.writeHead(upRes.statusCode, Object.assign({}, upRes.headers, { 'x-via': tag }));
      upRes.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('proxy error'); });
    req.pipe(up);
  });

  server.on('connect', (req, socket, head) => {
    const [host, port] = String(req.url).split(':');
    const target = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      if (head && head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });

  const port = await listen(server);
  return { port, count: () => count, close: () => close(server) };
}

/** 需要 Basic 认证的假上游代理：普通 HTTP 与 CONNECT 都校验 Proxy-Authorization */
export async function startAuthProxy({ user = 'alice', password = 'secret', tag = 'auth' } = {}) {
  const expected = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
  let plainCount = 0;
  let connectCount = 0;
  const server = http.createServer((req, res) => {
    plainCount += 1;
    if (req.headers['proxy-authorization'] !== expected) {
      req.resume();
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      res.end('proxy auth required');
      return;
    }
    let url;
    try { url = new URL(req.url); } catch (e) { res.writeHead(400); res.end('bad'); return; }
    const headers = Object.assign({}, req.headers, { host: url.host });
    delete headers['proxy-authorization'];
    const up = http.request({
      host: url.hostname,
      port: Number(url.port || 80),
      path: url.pathname + url.search,
      method: req.method,
      headers
    }, (upRes) => {
      res.writeHead(upRes.statusCode, Object.assign({}, upRes.headers, { 'x-via': tag }));
      upRes.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('proxy error'); });
    req.pipe(up);
  });

  server.on('connect', (req, socket, head) => {
    connectCount += 1;
    if (req.headers['proxy-authorization'] !== expected) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    const [host, port] = String(req.url).split(':');
    const target = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      if (head && head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });

  const port = await listen(server);
  return {
    port,
    count: () => plainCount + connectCount,
    plainCount: () => plainCount,
    connectCount: () => connectCount,
    close: () => close(server)
  };
}

/** 同 startFakeProxy，命名更明确；带 count() */
export async function startCountingProxy(tag = 'proxy') {
  return startFakeProxy(tag);
}

/** 拿一个“确定没人听”的端口 */
export async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

/** 经代理端口发一个普通 HTTP 请求 */
export function httpVia(proxyPort, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: url,
      headers: Object.assign({ host: new URL(url).host }, headers)
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 经代理端口建 CONNECT 隧道，返回已连通的 socket */
export function tunnelVia(proxyPort, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200\b/.test(buf)) {
        reject(new Error('CONNECT failed: ' + buf.split('\r\n')[0]));
        return;
      }
      resolve(sock);
    };
    sock.on('connect', () => {
      sock.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\n' +
        'Host: ' + host + ':' + port + '\r\n\r\n');
    });
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

/** 回显 TCP 服务 */
export async function startEcho() {
  const server = net.createServer((sock) => sock.pipe(sock));
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 一个只接受 TCP、永不回话的“卡住”网关 */
export async function startSilent() {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    // 必须把数据读掉：否则对端关闭后本端 socket 不会走到 close，server.close() 会一直等
    sock.resume();
  });
  const port = await listen(server);
  return {
    port,
    close: async () => {
      for (const sock of sockets) sock.destroy();
      await close(server);
    }
  };
}

/** 慢速 HTTP 目标：延迟响应并统计请求数 */
export async function startSlowTarget(delayMs = 100) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    req.resume();
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('slow');
    }, delayMs));
  });
  const port = await listen(server);
  return { port, count: () => count, close: () => close(server) };
}

/** 回显 TCP 服务，仅监听 IPv6 回环 */
export async function startEcho6() {
  const server = net.createServer((sock) => sock.pipe(sock));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', resolve);
  });
  return { port: server.address().port, close: () => close(server) };
}

/** 写入部分响应后直接掐断的 HTTP 目标 */
export async function startBrokenTarget() {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 10);
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 假上游：CONNECT 时把 200 与 banner 放在同一个写里 */
export async function startBannerProxy(banner) {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.resume();
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n' + banner);
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 响应里带逐跳标头的 HTTP 目标 */
export async function startHopTarget() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'proxy-connection': 'keep-alive',
        'keep-alive': 'timeout=5',
        'x-custom': 'kept'
      });
      res.end('ok');
    });
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 接受 TCP 后立刻断开，制造“连接已建立、随后失败” */
export async function startResetProxy() {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.destroy();
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 固定状态码的 HTTP 目标 */
export async function startStatusTarget(statusCode) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(statusCode, { 'content-type': 'text/plain' });
      res.end('status:' + statusCode);
    });
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 只正常处理第一个请求，之后的请求收下但永不回响应头 */
export async function startFlakyProxy(tag = 'proxy') {
  let count = 0;
  let first = true;
  const server = http.createServer((req, res) => {
    count += 1;
    if (!first) {
      req.resume();
      return;
    }
    first = false;
    let url;
    try { url = new URL(req.url); } catch (e) { res.writeHead(400); res.end('bad'); return; }
    const up = http.request({
      host: url.hostname,
      port: Number(url.port || 80),
      path: url.pathname + url.search,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: url.host })
    }, (upRes) => {
      res.writeHead(upRes.statusCode, Object.assign({}, upRes.headers, { 'x-via': tag }));
      upRes.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('proxy error'); });
    req.pipe(up);
  });
  const port = await listen(server);
  return {
    port,
    count: () => count,
    close: async () => {
      server.closeAllConnections?.();
      await close(server);
    }
  };
}

/** 带方法/请求体的代理请求 */
export function requestVia(proxyPort, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method,
      path: url,
      headers: Object.assign({ host: new URL(url).host }, headers)
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
