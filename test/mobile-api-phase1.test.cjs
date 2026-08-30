const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('mobile API Phase 1+2 complete tests', async (t) => {
  const secret = crypto.randomBytes(16).toString('hex');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-mobile-api-phase1-2-test-'));
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

  const handleMobileApiRequest = async (req, res, pathname, url) => {
    if (!pathname.startsWith('/api/')) return false;

    if (!isMobileAuthed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }

    const method = req.method?.toUpperCase() ?? 'GET';
    const hiveRoot = hiveDir;

    if (pathname === '/api/health') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, machine: os.hostname(), version: '0.6.21', uptimeSec: Math.floor(process.uptime()), hiveRoot: tempDir }));
      return true;
    }

    if (pathname === '/api/fleet') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      let fleetData = { ts: Date.now(), agents: [] };
      if (hiveRoot && fs.existsSync(path.join(hiveRoot, 'fleet.json'))) {
        try { fleetData = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'fleet.json'), 'utf8')); } catch {}
      }
      const agents = Array.isArray(fleetData.agents) ? fleetData.agents : [];
      const activeCount = agents.filter((a) => !a.onHold && !a.archived).length;
      const totalUsd = agents.reduce((sum, a) => sum + (typeof a.usd === 'number' ? a.usd : 0), 0);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ts: fleetData.ts || Date.now(), agents, totals: { activeCount, totalUsd: Number(totalUsd.toFixed(4)) } }));
      return true;
    }

    if (pathname === '/api/board') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      let content = '';
      let updatedAt = new Date().toISOString();
      if (hiveRoot && fs.existsSync(path.join(hiveRoot, 'board.md'))) {
        try {
          const p = path.join(hiveRoot, 'board.md');
          content = fs.readFileSync(p, 'utf8');
          updatedAt = fs.statSync(p).mtime.toISOString();
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, content, updatedAt }));
      return true;
    }

    if (pathname === '/api/tasks') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      let tasks = [];
      if (hiveRoot && fs.existsSync(path.join(hiveRoot, 'tasks.json'))) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8'));
          if (Array.isArray(raw.tasks)) tasks = raw.tasks;
        } catch {}
      }
      const statusParam = url.searchParams.get('status');
      if (statusParam) {
        const allowed = new Set(statusParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
        if (allowed.size > 0) {
          tasks = tasks.filter((t) => t && typeof t.status === 'string' && allowed.has(t.status.toLowerCase()));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ tasks }));
      return true;
    }

    if (pathname === '/api/ask-me') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      let tasks = [];
      if (hiveRoot && fs.existsSync(path.join(hiveRoot, 'tasks.json'))) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8'));
          if (Array.isArray(raw.tasks)) tasks = raw.tasks;
        } catch {}
      }
      const items = [];
      for (const task of tasks) {
        if (task && Array.isArray(task.humanQA)) {
          task.humanQA.forEach((qa, index) => {
            if (qa && typeof qa === 'object' && (qa.a === undefined || qa.a === null || qa.a === '')) {
              items.push({
                type: 'task_qa',
                taskId: task.id || '',
                taskTitle: task.title || '',
                assignee: task.assignee || null,
                index,
                question: qa.q || '',
                askedAt: qa.askedAt || null
              });
            }
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ unresolvedCount: items.length, items }));
      return true;
    }

    const qaAnswerMatch = /^\/api\/tasks\/([^/]+)\/qa\/(\d+)\/answer\/?$/.exec(pathname);
    if (qaAnswerMatch) {
      if (method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      const taskId = decodeURIComponent(qaAnswerMatch[1]);
      const qaIndex = parseInt(qaAnswerMatch[2], 10);
      const body = await readJsonBody(req);
      const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
      if (!answer) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Missing answer' }));
        return true;
      }
      const tasksFilePath = path.join(hiveRoot, 'tasks.json');
      const tasksJson = JSON.parse(fs.readFileSync(tasksFilePath, 'utf8'));
      const task = (tasksJson.tasks || []).find((t) => t && t.id === taskId);
      if (!task || !Array.isArray(task.humanQA) || !task.humanQA[qaIndex]) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Task or humanQA not found' }));
        return true;
      }
      task.humanQA[qaIndex].a = answer;
      task.humanQA[qaIndex].answeredAt = new Date().toISOString();
      atomicWriteJson(tasksFilePath, tasksJson);

      const godInboxDir = path.join(hiveRoot, 'agents', 'god', 'inbox');
      const nowIso = new Date().toISOString();
      const msgId = `${nowIso.replace(/[:.]/g, '-')}-qa-answered`;
      atomicWriteJson(path.join(godInboxDir, `${msgId}.json`), {
        id: msgId,
        from: 'human',
        to: 'god',
        act: 'inform',
        subject: `HUMAN ANSWER on task "${task.title || taskId}"`,
        body: `Q: ${task.humanQA[qaIndex].q || ''}\nA: ${answer}`,
        created_at: nowIso
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, taskId, index: qaIndex }));
      return true;
    }

    if (pathname === '/api/messages/send') {
      if (method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      const body = await readJsonBody(req);
      const to = typeof body?.to === 'string' ? body.to.trim() : '';
      if (!to) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Missing to' }));
        return true;
      }
      const nowIso = new Date().toISOString();
      const msgId = `${nowIso.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
      const inboxDir = path.join(hiveRoot, 'agents', to, 'inbox');
      atomicWriteJson(path.join(inboxDir, `${msgId}.json`), {
        id: msgId,
        from: 'human',
        to,
        act: body.act || 'inform',
        subject: body.subject || 'Message from human',
        body: body.body || '',
        created_at: nowIso
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, messageId: msgId, routedTo: to }));
      return true;
    }

    const taskPatchMatch = /^\/api\/tasks\/([^/]+)\/?$/.exec(pathname);
    if (taskPatchMatch) {
      if (method !== 'PATCH') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return true;
      }
      const taskId = decodeURIComponent(taskPatchMatch[1]);
      const patch = await readJsonBody(req);
      const tasksFilePath = path.join(hiveRoot, 'tasks.json');
      const tasksJson = JSON.parse(fs.readFileSync(tasksFilePath, 'utf8'));
      const taskIndex = (tasksJson.tasks || []).findIndex((t) => t && t.id === taskId);
      if (taskIndex === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return true;
      }
      tasksJson.tasks[taskIndex] = { ...tasksJson.tasks[taskIndex], ...patch, id: taskId };
      atomicWriteJson(tasksFilePath, tasksJson);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, taskId }));
      return true;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) {
      void handleMobileApiRequest(req, res, pathname, url);
      return;
    }
    if (pathname === '/mobile' || pathname === '/mobile/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>Mobile API ready. PWA loading...</body></html>');
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

  // Test GET /api/health
  const healthRes = await request('GET', '/api/health', authHeader);
  assert.strictEqual(healthRes.status, 200);
  assert.strictEqual(healthRes.body.ok, true);

  // Test GET /api/ask-me
  const askMeRes = await request('GET', '/api/ask-me', authHeader);
  assert.strictEqual(askMeRes.status, 200);
  assert.strictEqual(askMeRes.body.unresolvedCount, 1);
  assert.strictEqual(askMeRes.body.items[0].taskId, 'task-1');
  assert.strictEqual(askMeRes.body.items[0].question, 'Should we enable feature X?');

  // Test POST /api/tasks/:id/qa/:index/answer
  const answerRes = await request('POST', '/api/tasks/task-1/qa/0/answer', authHeader, { answer: 'Yes, enable feature X!' });
  assert.strictEqual(answerRes.status, 200);
  assert.strictEqual(answerRes.body.ok, true);

  // Verify ask-me is now 0 unresolved
  const askMeAfterRes = await request('GET', '/api/ask-me', authHeader);
  assert.strictEqual(askMeAfterRes.body.unresolvedCount, 0);

  // Verify god inbox received notification
  const godInbox = fs.readdirSync(path.join(hiveDir, 'agents', 'god', 'inbox'));
  assert.strictEqual(godInbox.length, 1);
  const godMsg = JSON.parse(fs.readFileSync(path.join(hiveDir, 'agents', 'god', 'inbox', godInbox[0]), 'utf8'));
  assert.strictEqual(godMsg.from, 'human');
  assert.strictEqual(godMsg.body.includes('Yes, enable feature X!'), true);

  // Test POST /api/messages/send
  const sendRes = await request('POST', '/api/messages/send', authHeader, { to: 'pam', subject: 'Great job', body: 'Keep it up!' });
  assert.strictEqual(sendRes.status, 200);
  assert.strictEqual(sendRes.body.ok, true);
  assert.strictEqual(sendRes.body.routedTo, 'pam');

  // Verify pam inbox received message
  const pamInbox = fs.readdirSync(path.join(hiveDir, 'agents', 'pam', 'inbox'));
  assert.strictEqual(pamInbox.length, 1);
  const pamMsg = JSON.parse(fs.readFileSync(path.join(hiveDir, 'agents', 'pam', 'inbox', pamInbox[0]), 'utf8'));
  assert.strictEqual(pamMsg.subject, 'Great job');

  // Test PATCH /api/tasks/:id
  const patchRes = await request('PATCH', '/api/tasks/task-2', authHeader, { status: 'doing', notes: 'In progress by mobile user' });
  assert.strictEqual(patchRes.status, 200);
  assert.strictEqual(patchRes.body.ok, true);

  // Verify task-2 status in tasks.json
  const tasksAfterPatch = JSON.parse(fs.readFileSync(path.join(hiveDir, 'tasks.json'), 'utf8'));
  const task2 = tasksAfterPatch.tasks.find((t) => t.id === 'task-2');
  assert.strictEqual(task2.status, 'doing');
  assert.strictEqual(task2.notes, 'In progress by mobile user');

  // Test GET /mobile
  const mobileRes = await request('GET', '/mobile');
  assert.strictEqual(mobileRes.status, 200);
  assert.strictEqual(mobileRes.body.includes('Mobile API ready'), true);

  server.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
