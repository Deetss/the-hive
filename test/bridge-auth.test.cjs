'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { timingSafeEqual } = require('node:crypto');

// Helper to simulate isBridgeAuthed logic
function isBridgeAuthedHelper(req, secret) {
  if (!secret) return false;

  let token = '';
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      if (parsed.searchParams.has('token') || parsed.searchParams.has('secret')) {
        token = (parsed.searchParams.get('token') ?? parsed.searchParams.get('secret') ?? '').trim();
      }
    } catch { /* ignore */ }
  }
  if (!token) {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      token = match ? match[1].trim() : authHeader.trim();
    }
  }
  if (!token && typeof req.headers['x-hive-secret'] === 'string') {
    token = req.headers['x-hive-secret'].trim();
  }
  if (!token && typeof req.headers['sec-websocket-protocol'] === 'string') {
    const parts = req.headers['sec-websocket-protocol'].split(',').map((s) => s.trim());
    for (const p of parts) {
      if (p.startsWith('token.')) {
        token = p.slice(6).trim();
        break;
      } else if (p.startsWith('bearer.')) {
        token = p.slice(7).trim();
        break;
      } else if (p && p.toLowerCase() !== 'bearer' && p.toLowerCase() !== 'token' && !p.includes('/')) {
        token = p;
        break;
      }
    }
  }

  if (!token) return false;

  const expectedBuf = Buffer.from(secret, 'utf8');
  const tokenBuf = Buffer.from(token, 'utf8');
  if (expectedBuf.length !== tokenBuf.length) {
    return false;
  }
  try {
    return timingSafeEqual(expectedBuf, tokenBuf);
  } catch {
    return false;
  }
}

test('/bridge WebSocket authentication suite', async (t) => {
  const secret = 'test-secret-32-chars-hex-token-123';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  const wss = new WebSocket.Server({
    server,
    path: '/bridge',
    perMessageDeflate: false,
    verifyClient: (info, callback) => {
      const authed = isBridgeAuthedHelper(info.req, secret);
      if (!authed) {
        callback(false, 401, 'Unauthorized');
        return;
      }
      callback(true);
    }
  });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', version: 1 }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  t.after(() => {
    wss.close();
    server.close();
  });

  await t.test('rejects unauthenticated connection with 401', async () => {
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
        ws.on('open', () => { ws.close(); resolve(); });
        ws.on('unexpected-response', (req, res) => {
          assert.equal(res.statusCode, 401);
          reject(new Error(`HTTP ${res.statusCode}`));
        });
        ws.on('error', (err) => reject(err));
      }),
      /HTTP 401/
    );
  });

  await t.test('rejects connection with invalid token in query param', async () => {
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=invalid-token`);
        ws.on('open', () => { ws.close(); resolve(); });
        ws.on('unexpected-response', (req, res) => {
          assert.equal(res.statusCode, 401);
          reject(new Error(`HTTP ${res.statusCode}`));
        });
        ws.on('error', (err) => reject(err));
      }),
      /HTTP 401/
    );
  });

  await t.test('accepts connection with valid token query param', async () => {
    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${encodeURIComponent(secret)}`);
      ws.on('message', (data) => {
        ws.close();
        resolve(JSON.parse(data.toString('utf8')));
      });
      ws.on('error', reject);
    });
    assert.deepEqual(msg, { type: 'hello', version: 1 });
  });

  await t.test('accepts connection with valid Authorization Bearer header', async () => {
    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
        headers: { Authorization: `Bearer ${secret}` }
      });
      ws.on('message', (data) => {
        ws.close();
        resolve(JSON.parse(data.toString('utf8')));
      });
      ws.on('error', reject);
    });
    assert.deepEqual(msg, { type: 'hello', version: 1 });
  });

  await t.test('accepts connection with valid x-hive-secret header', async () => {
    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
        headers: { 'x-hive-secret': secret }
      });
      ws.on('message', (data) => {
        ws.close();
        resolve(JSON.parse(data.toString('utf8')));
      });
      ws.on('error', reject);
    });
    assert.deepEqual(msg, { type: 'hello', version: 1 });
  });

  await t.test('accepts connection with valid Sec-WebSocket-Protocol token', async () => {
    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, [`token.${secret}`]);
      ws.on('message', (data) => {
        ws.close();
        resolve(JSON.parse(data.toString('utf8')));
      });
      ws.on('error', reject);
    });
    assert.deepEqual(msg, { type: 'hello', version: 1 });
  });
});
