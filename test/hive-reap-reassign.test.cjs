'use strict';

/**
 * Regression for the reap-time gap: when an agent is reaped (its terminal
 * closes / dies), `setArchived` flags it but its `agents/<id>/` directory
 * (and inbox) is deliberately retained so history survives. Two things used
 * to fall through that gap:
 *
 * 1. `routeMessage` only bounced mail to god when the recipient's inbox dir
 *    was MISSING, not when the recipient was archived. A human's UAT answer
 *    addressed to a task's now-dead assignee would "deliver" into a mailbox
 *    nobody is polling anymore, and silently vanish.
 * 2. A task the reaped agent owned kept `assignee` pointing at the dead id
 *    forever, so its open ASK ME item stayed addressed to a ghost even
 *    though the "For You" tab has no per-agent filter and shows it either
 *    way.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

/** Build a floor with a god and an already-archived worker, without going
 *  through `ensureAgent` (which needs a live `electron.app` this suite
 *  doesn't run under) — just the registry + on-disk inbox dirs `deliver()`
 *  and `reassignAgentTasks` actually look at. */
function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reap-reassign-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();

  const registry = {
    godId: 'god-1',
    agents: {
      'god-1': { id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isOvermind: true, status: 'idle', lastSeen: Date.now() },
      'jim-1': { id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home, status: 'gone', lastSeen: Date.now(), archived: true }
    }
  };
  fs.writeFileSync(path.join(hive.root(), 'registry.json'), JSON.stringify(registry, null, 2));
  for (const id of ['god-1', 'jim-1']) {
    fs.mkdirSync(path.join(hive.agentDirectory(id), 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(hive.agentDirectory(id), 'outbox'), { recursive: true });
  }
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

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('mail to an archived agent bounces to god instead of rotting in a dead inbox', (t) => {
  const hive = floor(t);

  hive.send({
    to: 'jim-1', act: 'inform', subject: 'Answer to your question — needs-human', body: 'Option B'
  }, 'human');

  assert.equal(hive.inbox('jim-1').length, 0, 'nothing should reach the archived agent');

  const dropped = entries(hive, 'drop').filter((e) => e.reason === 'archived');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].to, 'jim-1');

  const bounced = hive.inbox('god-1');
  assert.equal(bounced.length, 1);
  assert.match(bounced[0].subject, /^\[undeliverable: "jim-1" is archived\/reaped/);
  assert.equal(bounced[0].body, 'Option B', 'the bounce carries the original body');
});

test('reassignAgentTasks moves open cards to god and skips done ones', (t) => {
  const hive = floor(t);
  hive.writeTasks([
    card('needs-human', {
      status: 'blocked',
      assignee: 'jim-1',
      humanQA: [{ q: 'Which option?', askedAt: '2026-09-03T08:00:00.000Z' }]
    }),
    card('still-open', { status: 'doing', assignee: 'jim-1' }),
    card('already-closed', { status: 'done', assignee: 'jim-1' }),
    card('someone-elses', { status: 'doing', assignee: 'god-1' })
  ]);

  const reassigned = hive.reassignAgentTasks('jim-1', 'god-1');

  assert.deepEqual(reassigned.sort(), ['needs-human', 'still-open']);
  const byId = Object.fromEntries(hive.tasks().tasks.map((task) => [task.id, task]));
  assert.equal(byId['needs-human'].assignee, 'god-1');
  assert.equal(byId['still-open'].assignee, 'god-1');
  assert.equal(byId['already-closed'].assignee, 'jim-1', 'a done card is left alone');
  assert.equal(byId['someone-elses'].assignee, 'god-1', 'unrelated cards keep their own assignee');
  // The open item itself survives the handoff untouched — the reassigned
  // task still carries its original open question for the human to answer.
  assert.equal(byId['needs-human'].humanQA[0].q, 'Which option?');
  assert.equal(byId['needs-human'].humanQA[0].a, undefined);
});

test('reassignAgentTasks is a no-op with nothing to hand off', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('unrelated', { status: 'doing', assignee: 'god-1' })]);

  assert.deepEqual(hive.reassignAgentTasks('jim-1', 'god-1'), []);
  assert.deepEqual(hive.reassignAgentTasks('jim-1', 'jim-1'), [], 'same from/to is a no-op');
  assert.equal(hive.tasks().tasks[0].assignee, 'god-1', 'the ledger is untouched');
});
