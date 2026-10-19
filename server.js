const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8765);
const PAIRING_PIN = process.env.PAIRING_PIN || '';
const HOST_TOKEN = process.env.HOST_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = '/data';
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!PAIRING_PIN || !HOST_TOKEN) {
  throw new Error('PAIRING_PIN and HOST_TOKEN must be set. Run start.ps1 to create them.');
}

const defaults = {
  enabled: true,
  mouse: true,
  keyboard: true,
  scroll: true,
  click: true,
  tapClick: true,
};
let settings = { ...defaults };
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  for (const key of Object.keys(defaults)) {
    if (typeof saved[key] === 'boolean') settings[key] = saved[key];
  }
} catch {
  // A first run starts with every control enabled.
}

let hostSocket = null;
let hostAddresses = [];
const peers = new Set();
const badPinAttempts = new Map();
const qrCache = new Map();
const specialKeys = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
  'Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Insert', 'PrintScreen', 'ScrollLock',
  'Pause', 'NumLock', 'ContextMenu', ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);
const literalKeys = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);
const settingKeys = Object.keys(defaults);

function isSupportedKey(key) {
  return typeof key === 'string' && (specialKeys.has(key) || /^[a-z0-9]$/i.test(key) || literalKeys.has(key));
}

function equalSecret(candidate, expected) {
  if (typeof candidate !== 'string') return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function saveSettings() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.error('Could not save settings:', error.message);
  }
}

function send(socket, value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function statusMessage() {
  let controllers = 0;
  for (const peer of peers) if (peer.authenticated && peer.clientType === 'remote') controllers++;
  return {
    type: 'status',
    hostConnected: Boolean(hostSocket && hostSocket.readyState === WebSocket.OPEN),
    controllers,
    settings,
  };
}

function broadcastStatus() {
  const message = statusMessage();
  for (const peer of peers) if (peer.authenticated) send(peer.socket, message);
}

function sendToHost(packet) {
  if (hostSocket?.readyState === WebSocket.OPEN) send(hostSocket, packet);
}

function getAttemptState(ip) {
  const now = Date.now();
  const state = badPinAttempts.get(ip) || { count: 0, since: now };
  if (now - state.since > 5 * 60 * 1000) {
    state.count = 0;
    state.since = now;
  }
  badPinAttempts.set(ip, state);
  return state;
}

function safeAddress(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  if (/^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/.test(ip)) return ip;
  return null;
}

function validatedInput(packet) {
  if (!packet || packet.type !== 'input' || !settings.enabled) return null;
  const action = packet.action;
  if (action === 'reset') return { type: 'input', action: 'reset' };

  if (action === 'move' && settings.mouse) {
    const dx = Number(packet.dx);
    const dy = Number(packet.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return { type: 'input', action, dx: Math.max(-1000, Math.min(1000, Math.round(dx))), dy: Math.max(-1000, Math.min(1000, Math.round(dy))) };
  }

  if (action === 'button' && settings.mouse && settings.click) {
    if (!['left', 'right', 'middle'].includes(packet.button) || !['down', 'up'].includes(packet.state)) return null;
    return { type: 'input', action, button: packet.button, state: packet.state };
  }

  if (action === 'wheel' && settings.mouse && settings.scroll) {
    const delta = Number(packet.delta);
    if (!Number.isFinite(delta)) return null;
    return { type: 'input', action, delta: Math.max(-2000, Math.min(2000, Math.round(delta))) };
  }

  if (action === 'key' && settings.keyboard) {
    if (!isSupportedKey(packet.key) || !['down', 'up'].includes(packet.state)) return null;
    return { type: 'input', action, key: packet.key, state: packet.state };
  }

  if (action === 'text' && settings.keyboard && typeof packet.text === 'string') {
    return { type: 'input', action, text: packet.text.slice(0, 1200) };
  }

  return null;
}

function updateSettings(changes) {
  if (!changes || typeof changes !== 'object') return;
  let changed = false;
  for (const key of settingKeys) {
    if (typeof changes[key] === 'boolean' && settings[key] !== changes[key]) {
      settings[key] = changes[key];
      changed = true;
    }
  }
  if (!settings.enabled || !settings.mouse || !settings.click || !settings.keyboard) sendToHost({ type: 'input', action: 'reset' });
  if (changed) saveSettings();
  broadcastStatus();
}

function contentType(file) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  })[path.extname(file)] || 'application/octet-stream';
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }

  if (pathname === '/api/status') {
    const ip = req.socket.remoteAddress || 'unknown';
    const attempts = getAttemptState(ip);
    if (attempts.count >= 8) return sendJson(res, 429, { error: 'Too many attempts. Wait five minutes.' });
    if (!equalSecret(url.searchParams.get('pin'), PAIRING_PIN)) {
      attempts.count++;
      return sendJson(res, 401, { error: 'Pairing code required.' });
    }
    attempts.count = 0;
    const urls = await Promise.all(hostAddresses.map(async (ip) => {
      const link = 'http://' + ip + ':' + PORT + '/remote.html?v=10&pin=' + encodeURIComponent(PAIRING_PIN);
      let qr = qrCache.get(link);
      if (!qr) {
        try {
          qr = await QRCode.toDataURL(link, { width: 220, margin: 1, color: { dark: '#14201a', light: '#f6f5ed' } });
          qrCache.set(link, qr);
        } catch {
          qr = null;
        }
      }
      return { ip, link, qr };
    }));
    return sendJson(res, 200, { ...statusMessage(), urls });
  }

  let filePath;
  if (pathname === '/' || pathname === '/index.html') filePath = path.join(PUBLIC_DIR, 'index.html');
  else if (pathname === '/remote' || pathname === '/remote.html') filePath = path.join(PUBLIC_DIR, 'remote.html');
  else filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html') && filePath !== path.join(PUBLIC_DIR, 'remote.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': ['.html', '.css', '.js'].includes(path.extname(filePath)) ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self' data:; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(contents);
  });
});

const wsServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/ws' && pathname !== '/host') return socket.destroy();

  const origin = req.headers.origin;
  if (pathname === '/ws' && origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return socket.destroy();
    } catch {
      return socket.destroy();
    }
  }

  wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req, pathname));
});

wsServer.on('connection', (socket, req, pathname) => {
  socket._socket?.setNoDelay(true);
  const peer = { socket, path: pathname, authenticated: false, clientType: 'remote' };
  peers.add(peer);

  socket.on('message', (raw) => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return; }

    if (pathname === '/host') {
      if (!peer.authenticated) {
        if (packet.type !== 'hello' || !equalSecret(packet.token, HOST_TOKEN)) return socket.close(1008, 'Host key rejected');
        peer.authenticated = true;
        peer.clientType = 'host';
        if (hostSocket && hostSocket !== socket && hostSocket.readyState === WebSocket.OPEN) {
          send(hostSocket, { type: 'input', action: 'reset' });
          hostSocket.close(1012, 'A new bridge connected');
        }
        hostSocket = socket;
        hostAddresses = Array.isArray(packet.addresses) ? [...new Set(packet.addresses.map(safeAddress).filter(Boolean))] : [];
        send(socket, { type: 'ready' });
        broadcastStatus();
        return;
      }
      return;
    }

    if (!peer.authenticated) {
      if (packet.type !== 'pair') return socket.close(1008, 'Pairing code required');
      const ip = req.socket.remoteAddress || 'unknown';
      const attempts = getAttemptState(ip);
      if (attempts.count >= 8) return socket.close(1008, 'Too many attempts. Wait five minutes.');
      if (!equalSecret(packet.pin, PAIRING_PIN)) {
        attempts.count++;
        return socket.close(1008, 'Pairing code did not match');
      }
      attempts.count = 0;
      peer.authenticated = true;
      peer.clientType = packet.client === 'dashboard' ? 'dashboard' : 'remote';
      send(socket, { type: 'paired', ...statusMessage() });
      broadcastStatus();
      return;
    }

    if (packet.type === 'settings') return updateSettings(packet.settings);
    const input = validatedInput(packet);
    if (input) sendToHost(input);
  });

  socket.on('close', () => {
    peers.delete(peer);
    if (peer.clientType === 'host' && hostSocket === socket) {
      hostSocket = null;
      hostAddresses = [];
      sendToHost({ type: 'input', action: 'reset' });
    }
    if (peer.authenticated && peer.clientType === 'remote') sendToHost({ type: 'input', action: 'reset' });
    broadcastStatus();
  });
  socket.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pocket Pointer listening on port ${PORT}`);
});
