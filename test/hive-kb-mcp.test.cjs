'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('hive-kb-1 normalizes outline-mcp root URLs to /mcp endpoint', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-kb-test-'));
  try {
    const hive = new HiveManager(() => tmpDir);
    hive.ensureHive();

    const kbSources = [
      { type: 'folder', value: 'C:\\Users\\dylan\\Documents\\Docs' },
      { type: 'outline-mcp', value: 'https://docs.bloomfieldhomes.org/' },
      { type: 'outline-mcp', value: 'https://kb.example.com/mcp' },
      { type: 'custom-mcp', value: 'https://custom-mcp.example.com/sse' }
    ];

    await hive.ensureAgent(
      {
        id: 'worker-test-1',
        name: 'Test Worker',
        provider: 'claude',
        cwd: tmpDir
      },
      {
        knowledgeBaseSources: kbSources
      }
    );

    const settingsPath = path.join(hive.root(), 'agents', 'worker-test-1', 'settings.json');
    assert.equal(fs.existsSync(settingsPath), true, 'settings.json should be written');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    const mcp = settings.mcpServers;
    assert.ok(mcp, 'mcpServers should be present');

    // hive-kb-1 should be normalized to https://docs.bloomfieldhomes.org/mcp
    assert.deepEqual(mcp['hive-kb-1'], {
      type: 'http',
      url: 'https://docs.bloomfieldhomes.org/mcp'
    });

    // hive-kb-2 should preserve /mcp without duplicating
    assert.deepEqual(mcp['hive-kb-2'], {
      type: 'http',
      url: 'https://kb.example.com/mcp'
    });

    // hive-kb-3 custom-mcp should preserve exact URL
    assert.deepEqual(mcp['hive-kb-3'], {
      type: 'http',
      url: 'https://custom-mcp.example.com/sse'
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
