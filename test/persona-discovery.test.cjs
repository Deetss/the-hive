'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parsePersonaFrontmatter } = loadTs('src/shared/agentPersona.ts');
const { detectInstalledPersonas, readPersonaBody } = loadTs('src/main/personas.ts');

test('parsePersonaFrontmatter correctly parses YAML frontmatter and body', () => {
  const sample = `---
name: test-agent
description: A helpful test agent for verification
tools: ["Read", "Write", "Bash"]
color: cyan
---

<role>
You are a test agent.
</role>`;

  const parsed = parsePersonaFrontmatter(sample);
  assert.equal(parsed.meta.name, 'test-agent');
  assert.equal(parsed.meta.description, 'A helpful test agent for verification');
  assert.equal(parsed.meta.tools, '["Read", "Write", "Bash"]');
  assert.equal(parsed.meta.color, 'cyan');
  assert.equal(parsed.body, '<role>\nYou are a test agent.\n</role>');
});

test('parsePersonaFrontmatter handles files without frontmatter', () => {
  const sample = 'Plain instructions without any frontmatter.';
  const parsed = parsePersonaFrontmatter(sample);
  assert.deepEqual(parsed.meta, {});
  assert.equal(parsed.body, 'Plain instructions without any frontmatter.');
});

test('detectInstalledPersonas finds installed GSD and Claude subagents', () => {
  const personas = detectInstalledPersonas();
  assert.ok(Array.isArray(personas), 'detectInstalledPersonas should return an array');
  assert.ok(personas.length > 0, 'should detect installed personas in user home');
  const gsdMappers = personas.filter(p => p.name === 'gsd-codebase-mapper');
  if (gsdMappers.length > 0) {
    assert.equal(gsdMappers[0].isGsd, true);
    assert.ok(gsdMappers[0].description.length > 0);
  }
});

test('readPersonaBody returns instructions for known persona', () => {
  const body = readPersonaBody('gsd-codebase-mapper');
  if (body) {
    assert.ok(body.includes('GSD codebase mapper') || body.includes('role>'), 'body contains instructions');
    assert.ok(!body.startsWith('---'), 'frontmatter must be stripped');
  }
});
