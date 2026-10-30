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

/** 普通 HTTP 目标：回显方法与前缀 */
export async function startTarget() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-target': 'yes' });
      res.end('target:' + req.method + ':' + body);
    });
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/** 假上游代理：普通 HTTP 转发并加 x-via，CONNECT 建隧道 */
export async function startFakeProxy(tag = 'proxy') {
  const server = http.createServer((req, res) => {
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
  return { port, close: () => close(server) };
}

/** 拿一个“确定没人听”的端口 */
export async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

/** 经代理端口发一个普通 HTTP 请求 */
export function httpVia(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: url,
      headers: { host: new URL(url).host }
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

