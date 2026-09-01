'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parsePresence, HiveDiscovery } = loadTs('src/main/hiveDiscovery.ts');

test('parsePresence accepts a well-formed beacon and normalises it', () => {
  const p = parsePresence({
    hiveId: 'abc123', name: 'workstation', home: 'C:/hive', apiPort: 48003,
    agentCount: 4, version: '0.6.60', magic: 'ignored-here'
  });
  assert.deepEqual(p, {
    hiveId: 'abc123', name: 'workstation', home: 'C:/hive', apiPort: 48003,
    agentCount: 4, version: '0.6.60'
  });
});

test('parsePresence rejects a beacon with no hiveId or a bad port', () => {
  assert.equal(parsePresence({ apiPort: 48003 }), null);
  assert.equal(parsePresence({ hiveId: 'x', apiPort: 0 }), null);
  assert.equal(parsePresence({ hiveId: 'x', apiPort: 70000 }), null);
  assert.equal(parsePresence({ hiveId: 'x', apiPort: 'nope' }), null);
  assert.equal(parsePresence('not an object'), null);
  assert.equal(parsePresence(null), null);
});

test('parsePresence clamps agentCount and fills sane defaults', () => {
  const p = parsePresence({ hiveId: 'x', apiPort: 48003, agentCount: -5 });
  assert.equal(p.agentCount, 0);
  assert.equal(p.name, 'hive');
  assert.equal(p.version, '?');
  assert.equal(p.home, '');

  assert.equal(parsePresence({ hiveId: 'x', apiPort: 48003, agentCount: 1e9 }).agentCount, 9999);
  assert.equal(parsePresence({ hiveId: 'x', apiPort: 48003, agentCount: 3.9 }).agentCount, 3);
});

test('parsePresence truncates overlong strings', () => {
  const p = parsePresence({
    hiveId: 'h'.repeat(200), name: 'n'.repeat(200), home: 'p'.repeat(1000),
    apiPort: 48003, version: 'v'.repeat(100)
  });
  assert.equal(p.hiveId.length, 64);
  assert.equal(p.name.length, 80);
  assert.equal(p.home.length, 400);
  assert.equal(p.version.length, 32);
});

test('HiveDiscovery starts and stops without a bound socket leaking timers', () => {
  const d = new HiveDiscovery(() => ({
    hiveId: 'self', name: 'me', home: '/h', apiPort: 48003, agentCount: 0, version: '0.6.60'
  }));
  d.start();
  assert.deepEqual(d.list(), [], 'no peers before any beacon');
  d.stop();
  d.stop(); // idempotent
});
