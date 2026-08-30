const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('mobile API Phase 1-4 full suite', async (t) => {
  const secret = crypto.randomBytes(16).toString('hex');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-mobile-api-full-test-'));
  const hiveDir = path.join(tempDir, 'hive');
  const srcMobileDir = path.join(tempDir, 'src', 'mobile');
  fs.mkdirSync(hiveDir, { recursive: true });
  fs.mkdirSync(srcMobileDir, { recursive: true });

  // Seed sample mobile PWA files
  fs.writeFileSync(path.join(srcMobileDir, 'index.html'), '<!DOCTYPE html><html><head><title>PWA</title></head><body>Live PWA</body></html>', 'utf8');
  fs.writeFileSync(path.join(srcMobileDir, 'manifest.json'), JSON.stringify({ name: 'TheHive Remote', short_name: 'TheHive' }), 'utf8');
  fs.writeFileSync(path.join(srcMobileDir, 'sw.js'), '// Service Worker\nself.addEventListener("fetch", () => {});', 'utf8');

  // Seed sample hive data
  fs.writeFileSync(path.join(hiveDir, 'board.md'), '# Hive Board\nStatus: active\n', 'utf8');
  fs.writeFileSync(path.join(hiveDir, 'fleet.json'), JSON.stringify({
    ts: 1788116522656,
    agents: [
      { id: 'god', name: 'Abathur', usd: 10.5, onHold: false, archived: false },
      { id: 'pam', name: 'Pam', usd: 2.25, onHold: false, archived: false },
      { id: 'old', name: 'Old', usd: 1.0, onHold: false, archived: true }
    ]
  }), 'utf8');
  fs.writeFileSync(path.join(hiveDir, 'tasks.json'), JSON.stringify({
    tasks: [
      {
        id: 'task-1',
        title: 'Task 1',
        status: 'doing',
        assignee: 'pam',
        humanQA: [
          { q: 'Should we enable feature X?', askedAt: '2026-08-30T10:00:00Z' }
        ]
      },
      { id: 'task-2', title: 'Task 2', status: 'todo' },
      { id: 'task-3', title: 'Task 3', status: 'done' }
    ]
  }), 'utf8');

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
      req.on('error', reject);
    });
  }

  function atomicWriteJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  const isMobileAuthed = (req, url) => {
    let token = '';
    if (url && url.searchParams.has('token')) {
      token = (url.searchParams.get('token') || '').trim();
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
    if (!token) return false;
    const expectedBuf = Buffer.from(secret, 'utf8');
    const tokenBuf = Buffer.from(token, 'utf8');
    if (expectedBuf.length !== tokenBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, tokenBuf);
  };

  function mimeTypeFor(ext) {
    const map = {
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png'
    };
    return map[ext] || 'application/octet-stream';
  }

  function resolveMobileStaticFile(subPath) {
    let cleanSub = subPath.replace(/^\/+/, '');
    if (!cleanSub || cleanSub === 'mobile' || cleanSub === 'mobile/') cleanSub = 'index.html';
    if (cleanSub.startsWith('mobile/')) cleanSub = cleanSub.slice('mobile/'.length);
    if (!cleanSub) cleanSub = 'index.html';

    const candidates = [
      path.join(srcMobileDir, cleanSub)
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { filePath: candidate, mime: mimeTypeFor(path.extname(candidate)) };
      }
    }
    return null;
  }

  const sseClients = new Set();

  const handleMobileApiRequest = async (req, res, pathname, url) => {
    if (!pathname.startsWith('/api/')) return false;

    if (!isMobileAuthed(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }

    const method = req.method?.toUpperCase() ?? 'GET';
    const hiveRoot = hiveDir;

    if (pathname === '/api/events') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      sseClients.add(res);
      res.write(`event: fleet\ndata: {"ok":true}\n\n`);
      res.write(`event: tasks\ndata: {"tasks":[]}\n\n`);
      res.write(`event: board\ndata: {"content":""}\n\n`);
      res.write(`event: ask_me\ndata: {"items":[]}\n\n`);
      res.on('close', () => { sseClients.delete(res); });
      return true;
    }

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, machine: os.hostname(), version: '0.6.22', uptimeSec: 10, hiveRoot: tempDir }));
      return true;
    }

    if (pathname === '/api/agents/spawn') {
      const body = await readJsonBody(req);
      const name = body.name || 'worker';
      const requestId = `req-${Date.now()}-${name}`;
      const spawnDir = path.join(hiveRoot, 'spawn-requests');
      atomicWriteJson(path.join(spawnDir, `${requestId}.json`), { id: requestId, name, objective: body.objective, cwd: tempDir });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, requestId, status: 'queued' }));
      return true;
    }

    const stopMatch = /^\/api\/agents\/([^/]+)\/stop\/?$/.exec(pathname);
    if (stopMatch) {
      const agentId = decodeURIComponent(stopMatch[1]);
      const body = await readJsonBody(req);
      const stopMsgId = `${Date.now()}-stop`;
      const inboxDir = path.join(hiveRoot, 'agents', agentId, 'inbox');
      atomicWriteJson(path.join(inboxDir, `${stopMsgId}.json`), {
        id: stopMsgId,
        from: 'human',
        to: agentId,
        act: 'stop',
        subject: 'Stop requested from mobile',
        body: body.reason || 'Stopped from Android'
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, agentId, status: 'stop-requested' }));
      return true;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method?.toUpperCase() ?? 'GET';

    if (pathname === '/mobile' || pathname === '/mobile/' || pathname.startsWith('/mobile/')) {
      const subPath = pathname === '/mobile' || pathname === '/mobile/' ? 'index.html' : pathname.replace(/^\/mobile\/?/, '');
      const resolved = resolveMobileStaticFile(subPath);
      if (resolved) {
        const content = fs.readFileSync(resolved.filePath);
        res.writeHead(200, {
          'Content-Type': resolved.mime,
          'Cache-Control': 'no-cache',
          'Content-Length': content.byteLength
        });
        if (method === 'HEAD') res.end();
        else res.end(content);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    if (pathname.startsWith('/api/')) {
      void handleMobileApiRequest(req, res, pathname, url);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const request = (method, p, headers = {}, bodyObj = null) => {
    return new Promise((resolve, reject) => {
      const payloadStr = bodyObj ? JSON.stringify(bodyObj) : null;
      const finalHeaders = { ...headers };
      if (payloadStr) {
        finalHeaders['content-type'] = 'application/json';
        finalHeaders['content-length'] = Buffer.byteLength(payloadStr);
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: p,
        method,
        headers: finalHeaders
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(body); } catch { parsed = body; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });
      req.on('error', reject);
      if (payloadStr) req.write(payloadStr);
      req.end();
    });
  };

  const authHeader = { authorization: `Bearer ${secret}` };

  // Deliverable 1 Tests (PWA static serving)
  const mobileHtmlRes = await request('GET', '/mobile');
  assert.strictEqual(mobileHtmlRes.status, 200);
  assert.strictEqual(mobileHtmlRes.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(mobileHtmlRes.body.includes('Live PWA'), true);

  const manifestRes = await request('GET', '/mobile/manifest.json');
  assert.strictEqual(manifestRes.status, 200);
  assert.strictEqual(manifestRes.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(manifestRes.body.name, 'TheHive Remote');

  const swRes = await request('GET', '/mobile/sw.js');
  assert.strictEqual(swRes.status, 200);
  assert.strictEqual(swRes.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.strictEqual(swRes.body.includes('Service Worker'), true);

  const iconRes = await request('GET', '/mobile/icon-192.png');
  assert.strictEqual(iconRes.status, 404);

  // Deliverable 2 Tests (SSE stream with ?token=)
  const sseReqPromise = new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/events?token=${secret}`,
      method: 'GET'
    }, (res) => {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/event-stream');
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('event: ask_me')) {
          req.destroy();
          resolve(data);
        }
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNRESET') resolve('aborted');
      else reject(err);
    });
    req.end();
  });
  const sseData = await sseReqPromise;
  assert.strictEqual(sseData.includes('event: fleet'), true);

  // Deliverable 3 Tests (spawn & stop)
  const spawnRes = await request('POST', '/api/agents/spawn', authHeader, {
    name: 'researcher',
    objective: 'Survey codebase'
  });
  assert.strictEqual(spawnRes.status, 200);
  assert.strictEqual(spawnRes.body.ok, true);
  assert.strictEqual(spawnRes.body.status, 'queued');

  const spawnFiles = fs.readdirSync(path.join(hiveDir, 'spawn-requests'));
  assert.strictEqual(spawnFiles.length, 1);
  const spawnContent = JSON.parse(fs.readFileSync(path.join(hiveDir, 'spawn-requests', spawnFiles[0]), 'utf8'));
  assert.strictEqual(spawnContent.name, 'researcher');
  assert.strictEqual(spawnContent.objective, 'Survey codebase');

  const stopRes = await request('POST', '/api/agents/pam/stop', authHeader, { reason: 'User finished' });
  assert.strictEqual(stopRes.status, 200);
  assert.strictEqual(stopRes.body.ok, true);
  assert.strictEqual(stopRes.body.status, 'stop-requested');

  const pamInbox = fs.readdirSync(path.join(hiveDir, 'agents', 'pam', 'inbox'));
  assert.strictEqual(pamInbox.length, 1);
  const stopMsg = JSON.parse(fs.readFileSync(path.join(hiveDir, 'agents', 'pam', 'inbox', pamInbox[0]), 'utf8'));
  assert.strictEqual(stopMsg.act, 'stop');
  assert.strictEqual(stopMsg.body, 'User finished');

  server.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
