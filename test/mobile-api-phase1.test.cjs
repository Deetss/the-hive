const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('mobile API auth middleware & endpoints logic', async (t) => {
  const secret = crypto.randomBytes(16).toString('hex');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-mobile-api-test-'));
  const hiveDir = path.join(tempDir, 'hive');
  fs.mkdirSync(hiveDir, { recursive: true });

  // Seed sample data
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
      { id: 'task-1', title: 'Task 1', status: 'doing' },
      { id: 'task-2', title: 'Task 2', status: 'todo' },
      { id: 'task-3', title: 'Task 3', status: 'done' }
    ]
  }), 'utf8');

  const isMobileAuthed = (req) => {
    const authHeader = req.headers['authorization'];
    let token = '';
    if (typeof authHeader === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      token = match ? match[1].trim() : authHeader.trim();
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

  const handleMobileApiRequest = (req, res, pathname, url) => {
    if (!pathname.startsWith('/api/')) return false;

    if (!isMobileAuthed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }

    const method = req.method?.toUpperCase() ?? 'GET';
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }

    const hiveRoot = hiveDir;

    if (pathname === '/api/health') {
      const uptimeSec = Math.floor(process.uptime());
      const payload = {
        ok: true,
        machine: os.hostname(),
        version: '0.6.21',
        uptimeSec,
        hiveRoot: tempDir
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return true;
    }

    if (pathname === '/api/fleet') {
      let fleetData = { ts: Date.now(), agents: [] };
      if (hiveRoot && fs.existsSync(path.join(hiveRoot, 'fleet.json'))) {
        try {
          fleetData = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'fleet.json'), 'utf8'));
        } catch {
          fleetData = { ts: Date.now(), agents: [] };
        }
      }
      const agents = Array.isArray(fleetData.agents) ? fleetData.agents : [];
      const activeCount = agents.filter((a) => !a.onHold && !a.archived).length;
      const totalUsd = agents.reduce((sum, a) => sum + (typeof a.usd === 'number' ? a.usd : 0), 0);
      const payload = {
        ts: typeof fleetData.ts === 'number' ? fleetData.ts : Date.now(),
        agents,
        totals: {
          activeCount,
          totalUsd: Number(totalUsd.toFixed(4))
        }
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return true;
    }

    if (pathname === '/api/board') {
      let content = '';
      let updatedAt = new Date().toISOString();
      if (hiveRoot && fs.existsSync(path.join(hiveRoot, 'board.md'))) {
        try {
          const p = path.join(hiveRoot, 'board.md');
          content = fs.readFileSync(p, 'utf8');
          updatedAt = fs.statSync(p).mtime.toISOString();
        } catch {
          content = '';
        }
      }
      const payload = {
        ok: true,
        content,
        updatedAt
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return true;
    }

    if (pathname === '/api/tasks') {
      let tasks = [];
      if (hiveRoot && fs.existsSync(path.join(hiveRoot, 'tasks.json'))) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8'));
          if (Array.isArray(raw.tasks)) tasks = raw.tasks;
        } catch {
          tasks = [];
        }
      }
      const statusParam = url.searchParams.get('status');
      if (statusParam) {
        const allowed = new Set(statusParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
        if (allowed.size > 0) {
          tasks = tasks.filter((t) => t && typeof t.status === 'string' && allowed.has(t.status.toLowerCase()));
        }
      }
      const payload = {
        tasks
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return true;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (handleMobileApiRequest(req, res, pathname, url)) return;
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const request = (method, p, headers = {}) => {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: p,
        method,
        headers
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
      req.end();
    });
  };

  // Test 1: 401 when no auth
  const unauthRes = await request('GET', '/api/health');
  assert.strictEqual(unauthRes.status, 401);
  assert.deepStrictEqual(unauthRes.body, { error: 'unauthorized' });

  // Test 2: 401 with bad secret
  const badAuthRes = await request('GET', '/api/health', { authorization: 'Bearer invalid-token' });
  assert.strictEqual(badAuthRes.status, 401);

  // Test 3: GET /api/health with Bearer token
  const healthRes = await request('GET', '/api/health', { authorization: `Bearer ${secret}` });
  assert.strictEqual(healthRes.status, 200);
  assert.strictEqual(healthRes.body.ok, true);
  assert.strictEqual(healthRes.body.version, '0.6.21');
  assert.strictEqual(typeof healthRes.body.uptimeSec, 'number');

  // Test 4: GET /api/fleet with X-Hive-Secret
  const fleetRes = await request('GET', '/api/fleet', { 'x-hive-secret': secret });
  assert.strictEqual(fleetRes.status, 200);
  assert.strictEqual(fleetRes.body.agents.length, 3);
  assert.strictEqual(fleetRes.body.totals.activeCount, 2);
  assert.strictEqual(fleetRes.body.totals.totalUsd, 13.75);

  // Test 5: GET /api/board
  const boardRes = await request('GET', '/api/board', { authorization: `Bearer ${secret}` });
  assert.strictEqual(boardRes.status, 200);
  assert.strictEqual(boardRes.body.ok, true);
  assert.strictEqual(boardRes.body.content.includes('# Hive Board'), true);

  // Test 6: GET /api/tasks unfiltered
  const tasksRes = await request('GET', '/api/tasks', { authorization: `Bearer ${secret}` });
  assert.strictEqual(tasksRes.status, 200);
  assert.strictEqual(tasksRes.body.tasks.length, 3);

  // Test 7: GET /api/tasks with ?status=doing
  const tasksDoingRes = await request('GET', '/api/tasks?status=doing', { authorization: `Bearer ${secret}` });
  assert.strictEqual(tasksDoingRes.status, 200);
  assert.strictEqual(tasksDoingRes.body.tasks.length, 1);
  assert.strictEqual(tasksDoingRes.body.tasks[0].id, 'task-1');

  // Test 8: Method not allowed on POST
  const postRes = await request('POST', '/api/health', { authorization: `Bearer ${secret}` });
  assert.strictEqual(postRes.status, 405);

  // Test 9: 404 on unknown /api route
  const notFoundRes = await request('GET', '/api/unknown', { authorization: `Bearer ${secret}` });
  assert.strictEqual(notFoundRes.status, 404);

  server.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
