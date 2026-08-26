'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { isSafeGitUrl } = loadTs('src/main/sync.ts');

test('command-executing git transports are rejected (ext::/fd:: = RCE)', () => {
  assert.equal(isSafeGitUrl("ext::sh -c 'touch /tmp/pwned'"), false);
  assert.equal(isSafeGitUrl('fd::17'), false);
  assert.equal(isSafeGitUrl('transport::anything'), false);
});

test('a dash-prefixed URL (argument injection) is rejected', () => {
  assert.equal(isSafeGitUrl('--upload-pack=/bin/sh'), false);
  assert.equal(isSafeGitUrl('-oProxyCommand=evil'), false);
});

test('empty / bare / schemeless values are rejected', () => {
  assert.equal(isSafeGitUrl(''), false);
  assert.equal(isSafeGitUrl('   '), false);
  assert.equal(isSafeGitUrl('not-a-url'), false);
});

test('ordinary remotes are accepted', () => {
  assert.equal(isSafeGitUrl('https://github.com/owner/repo.git'), true);
  assert.equal(isSafeGitUrl('ssh://git@example.com/owner/repo.git'), true);
  assert.equal(isSafeGitUrl('git://example.com/owner/repo.git'), true);
  assert.equal(isSafeGitUrl('git@github.com:owner/repo.git'), true);
  assert.equal(isSafeGitUrl('file:///srv/hives/x'), true);
  assert.equal(isSafeGitUrl('/srv/hives/x'), true);
  assert.equal(isSafeGitUrl('C:/Users/dylan/HarnessAgents-x'), true);
});
