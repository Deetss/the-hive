'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('full e2e chat flow: human chats, outbox routes, reply appends', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-chat-e2e-'));
  try {
    const hive = new HiveManager(() => tmpDir);
    hive.ensureHive();

    const task = {
      id: 'task-chat-e2',
      title: 'E2E Chat Test Task',
      status: 'doing',
      assignee: 'god',
      humanQA: [
        {
          q: '**UAT Question**`nplease verify chat routing`.',
          askedAt: new Date().toISOString()
        }
      ]
    };
    hive.writeTasks([task]);

    // 1. Human chats
    const humanRes = hive.appendHumanQAThread(
      'task-chat-e2',
      '**UAT Question**\nFplease verify chat routing.',
      { from: 'human', text: 'How does this look?', ts: new Date().toISOString() }
    );
    assert.equal(humanRes.ok, true);

    // 2. Agent drops outbox file
    const agentOutbox = path.join(hive.root(), 'agents', 'god', 'outbox');
    fs.mkdirSync(agentOutbox, { recursive: true });

    const outboxMsg = {
      act: 'humanQA-chat',
      taskId: 'task-chat-e2',
      question: '**UAT Question**\n\nplease verify chat routing.',
      text: 'Looks great, ready to ship!'
    };
    fs.writeFileSync(path.join(agentOutbox, 'reply-e2e.json'), JSON.stringify(outboxMsg));

    // 3. Router runs
    const routed = hive.routeOnce();
    assert.equal(routed, 1, 'should route 1 control message');

    // 4. Verify final thread
    const updated = hive.tasks().tasks;
    const thread = updated[0].humanQA[0].thread;
    assert.equal(thread.length, 2);
    assert.equal(thread[0].from, 'human');
    assert.equal(thread[1].from, 'agent');
    assert.equal(thread[1].text, 'Looks great, ready to ship!');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
