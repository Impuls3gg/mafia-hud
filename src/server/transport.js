const { WebSocket, WebSocketServer } = require('ws');
const { isIPv4 } = require('node:net');

const MAX_MESSAGE = 1024 * 1024;
const MAX_BUFFERED = 8 * MAX_MESSAGE;
const MAX_CONNECTIONS = 80;
const MAX_PER_ADDRESS = 24;

function localHost(host) {
  if (host === 'localhost' || host === '[::1]') return true;
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true; // клиент OBS или другой небраузерный клиент всё равно предъявляет ключ
  try {
    const url = new URL(origin);
    return url.host === request.headers.host?.toLowerCase() &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && localHost(url.hostname)));
  } catch {
    return false;
  }
}

function send(socket, text, done) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFERED) {
    socket.terminate();
    return false;
  }
  socket.send(text, done);
  return true;
}

function attachTransport(server, addressFor, onConnection) {
  const connected = new Map();
  const sockets = new WebSocketServer({
    noServer: true, maxPayload: MAX_MESSAGE, maxFragments: 256, closeTimeout: 1000, perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    const address = addressFor(request);
    const count = connected.get(address) || 0;
    if (!/^\/ws(?:\?|$)/.test(request.url) || !sameOrigin(request) ||
        sockets.clients.size >= MAX_CONNECTIONS || count >= MAX_PER_ADDRESS) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      client.on('error', () => {});
      client.alive = true;
      connected.set(address, count + 1);
      client.on('close', () => {
        const remaining = connected.get(address) - 1;
        if (remaining) connected.set(address, remaining);
        else connected.delete(address);
      });
      client.on('pong', () => { client.alive = true; });
      onConnection(client, request);
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        socket.alive = false;
        socket.ping();
      }
    }
  }, 30000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
}

module.exports = { attachTransport, send };
