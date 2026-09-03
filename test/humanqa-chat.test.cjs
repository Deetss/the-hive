'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('appendHumanQAThread matches questions with newline and backtick-n differences', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-qa-test-'));
  try {
    const hive = new HiveManager(() => tmpDir);
    hive.ensureHive();

    const taskWithBacktickN = {
      id: 'task-test-1',
      title: 'Test Task',
      status: 'doing',
      humanQA: [
        {
          q: '**UAT: header**`npn1. Step one`n2. Step two',
          askedAt: new Date().toISOString()
        }
      ]
    };
    hive.writeTasks([taskWithBacktickN]);

    // Agent sends standard markdown with \N\n
    const res = hive.appendHumanQAThread(
      'task-test-1',
      '**UAT: header**\n\n1. Step one\n2. Step two',
      { from: 'agent', text: 'Looks great to me!', ts: new Date().toISOString() }
    );

    assert.equal(res.ok, true, 'should match and append thread message despite newline escaping difference');
    const tasks = hive.tasks().tasks;
    assert.equal(tasks[0].humanQA[0].thread.length, 1);
    assert.equal(tasks[0].humanQA[0].thread[0].text, 'Looks great to me!');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('routeOnce handles humanQA-chat act with aliases and body field', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-qa-test-'));
  try {
    const hive = new HiveManager(() => tmpDir);
    hive.ensureHive();

    const task = {
      id: 'task-test-3',
      title: 'Test Task 3',
      status: 'doing',
      humanQA: [
        {
          q: 'Please review implementation',
          askedAt: new Date().toISOString()
        }
      ]
    };
    hive.writeTasks([task]);

    // Create an agent outbox directory under hive.root()
    const agentOutbox = path.join(hive.root(), 'agents', 'god', 'outbox');
    fs.mkdirSync(agentOutbox, { recursive: true });

    // Drop message with act: humanqa-chat and body instead of text
    const msg = {
      act: 'humanqa-chat',
      taskId: 'task-test-3',
      body: 'Agent reply via body field'
    };
    fs.writeFileSync(path.join(agentOutbox, 'reply-1.json'), JSON.stringify(msg));

    const routed = hive.routeOnce();
    assert.equal(routed, 1, 'routeOnce should route 1 control message');

    const tasks = hive.tasks().tasks;
    assert.equal(tasks[0].humanQA[0].thread.length, 1);
    assert.equal(tasks[0].humanQA[0].thread[0].text, 'Agent reply via body field');
    assert.equal(tasks[0].humanQA[0].thread[0].from, 'agent');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
