'use strict';

/**
 * Regression for the ORIGINAL for-you-reap-handling UAT failure: it turned
 * out not to be a reap at all. The task card was hand-written with
 * `assignee: "worker-for-you-reap"` before the real worker ever spawned, and
 * the real worker came up as `worker-for-you-reap-handling` — a different
 * id that was never written back onto the card. `reassignAgentTasks` only
 * fires on a reap event, so a card born with the wrong assignee sat pointed
 * at an id that never existed in the registry, forever. The FOR YOU tab's
 * name lookup then fell back to a guessed, misleading label instead of
 * flagging the mismatch.
 *
 * `reassignOrphanedTasks` catches the broader case: any open card whose
 * assignee is not a real registry entry — reaped, mistyped, or otherwise —
 * gets hard back to god.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-orphaned-assignee-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();

  const registry = {
    godId: 'god-1',
    agents: {
      'god-1': { id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isOvermind: true, status: 'idle', lastSeen: Date.now() },
      'dwight-1': { id: 'dwight-1', name: 'Dwight', provider: 'claude', cwd: home, status: 'idle', lastSeen: Date.now() }
    }
  };
  fs.writeFileSync(path.join(hive.root(), 'registry.json'), JSON.stringify(registry, null, 2));
  return hive;
}

function card(id, extra = {}) {
  return {
    id,
    title: id,
    status: 'todo',
    dependsOn: [],
    priority: 3,
    createdAt: '2026-09-03T08:00:00.000Z',
    ...extra
  };
}

test('reassignOrphanedTasks hands a never-existed assignee to god', (t) => {
  const hive = floor(t);
  hive.writeTasks([
    card('needs-human', {
      status: 'blocked',
      assignee: 'worker-for-you-reap', // guessed id, never actually registered
      humanQA: [{ q: 'Which option?', askedAt: '2026-09-03T08:00:00.000Z' }]
    }),
    card('already-closed', { status: 'done', assignee: 'worker-never-existed' }),
    card('real-worker', { status: 'doing', assignee: 'dwight-1' }),
    card('unassigned', { status: 'todo' })
  ]);

  const reassigned = hive.reassignOrphanedTasks('god-1');

  assert.deepEqual(reassigned, ['needs-human']);
  const byId = Object.fromEntries(hive.tasks().tasks.map((task) => [task.id, task]));
  assert.equal(byId['needs-human'].assignee, 'god-1');
  assert.equal(byId['already-closed'].assignee, 'worker-never-existed', 'a done card is left alone');
  assert.equal(byId['real-worker'].assignee, 'dwight-1', 'a real, registered assignee is left alone');
  assert.equal(byId['unassigned'].assignee, undefined, 'no assignee is not an orphan');
  // The open question survives the handoff untouched.
  assert.equal(byId['needs-human'].humanQA[0].q, 'Which option?');
});

test('reassignOrphanedTasks is a no-op with nothing to hand off', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('fine', { status: 'doing', assignee: 'dwight-1' })]);

  assert.deepEqual(hive.reassignOrphanedTasks('god-1'), []);
  assert.deepEqual(hive.reassignOrphanedTasks(''), [], 'no toId is a no-op');
  assert.equal(hive.tasks().tasks[0].assignee, 'dwight-1', 'the ledger is untouched');
});
