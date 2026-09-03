import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { DetectedPersona, parsePersonaFrontmatter } from '../shared/agentPersona';

export function getPersonaSearchDirs(projectDir?: string): string[] {
  const home = homedir();
  const dirs: string[] = [];

  if (projectDir && existsSync(projectDir)) {
    dirs.push(join(projectDir, '.claude', 'agents'));
    dirs.push(join(projectDir, '.agents', 'agents'));
  }

  dirs.push(join(home, '.claude', 'agents'));
  dirs.push(join(home, '.agents', 'agents'));

  return dirs.filter((d) => existsSync(d));
}

export function detectInstalledPersonas(projectDir?: string): DetectedPersona[] {
  const dirs = getPersonaSearchDirs(projectDir);
  const byName = new Map<string, DetectedPersona>();

  for (const d of dirs) {
    try {
      const files = readdirSync(d);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const fullPath = join(d, f);
        try {
          const content = readFileSync(fullPath, 'utf8');
          const { meta } = parsePersonaFrontmatter(content);
          const name = meta.name || f.replace(/\.md$/i, '');
          if (!byName.has(name)) {
            let tools: string[] | undefined;
            if (meta.tools) {
              if (meta.tools.startsWith('[') && meta.tools.endsWith(']')) {
                try {
                  tools = JSON.parse(meta.tools);
                } catch {
                  tools = meta.tools.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
                }
              } else {
                tools = meta.tools.split(',').map((s) => s.trim());
              }
            }
            byName.set(name, {
              name,
              description: meta.description || '',
              tools,
              color: meta.color,
              isGsd: name.startsWith('gsd-'),
              path: fullPath
            });
          }
        } catch {}
      }
    } catch {}
  }

  return Array.from(byName.values()).sort((a, b) => {
    if (a.isGsd && !b.isGsd) return -1;
    if (!a.isGsd && b.isGsd) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function readPersonaBody(name: string, projectDir?: string): string | null {
  const dirs = getPersonaSearchDirs(projectDir);
  const targetFile = name.endsWith('.md') ? name : `${name}.md`;

  for (const d of dirs) {
    const fullPath = join(d, targetFile);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf8');
        const { body } = parsePersonaFrontmatter(content);
        return body || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function resolveGsdModel(gsdAgent: string, projectDir?: string): string | undefined {
  if (!projectDir || !existsSync(join(projectDir, '.planning'))) return undefined;

  const home = homedir();
  const candidates = [
    join(projectDir, 'gsd-core', 'bin', 'gsd-tools.cjs'),
    join(projectDir, '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs'),
    join(home, '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs'),
    join(home, '.agents', 'gsd-core', 'bin', 'gsd-tools.cjs')
  ];

  for (const tool of candidates) {
    if (existsSync(tool)) {
      try {
        const out = execFileSync(
          process.execPath,
          [tool, 'resolve-model', gsdAgent, '--project-dir', projectDir],
          { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
        if (out && !out.includes('Error') && !out.includes('error')) {
          return out;
        }
      } catch {}
    }
  }
  return undefined;
}
