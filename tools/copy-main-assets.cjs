'use strict';

const { copyFileSync, mkdirSync, readdirSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

function copyDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

const ROOT = join(__dirname, '..');
const MAIN_ASSETS = [
  ['src/main/slack-trigger.cjs', 'out/main/slack-trigger.cjs'],
  // Knowledge Graph core (pure-JS, no native deps) — required by knowledge.ts.
  ['src/main/kg-core.cjs', 'out/main/kg-core.cjs'],
];

// Copy mobile PWA static files so they land in out/mobile/ inside the ASAR.
copyDir(join(ROOT, 'src/mobile'), join(ROOT, 'out/mobile'));
console.log('[copy-main-assets] src/mobile -> out/mobile');

for (const [fromRel, toRel] of MAIN_ASSETS) {
  const from = join(ROOT, fromRel);
  const to = join(ROOT, toRel);

  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);

  const copied = statSync(to);
  if (!copied.isFile() || copied.size === 0) {
    throw new Error(`Failed to copy required main-process asset: ${fromRel} -> ${toRel}`);
  }
  console.log(`[copy-main-assets] ${fromRel} -> ${toRel}`);
}
