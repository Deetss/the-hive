/**
 * Subagent persona definitions (GSD skills and custom Claude Code subagents).
 *
 * Subagents defined in ~/.claude/agents/*.md or ~/.agents/agents/*.md are YAML-frontmattered
 * markdown files that provide specialized system prompt personas for tasks like codebase
 * mapping, planning, execution, bug triage, and review.
 */

export interface DetectedPersona {
  /** The identifier used to reference the persona (e.g. "gsd-codebase-mapper") */
  name: string;
  /** Human-readable description/role of what this agent does */
  description: string;
  /** Allowed/recommended tool list if specified */
  tools?: string[];
  /** Color theme or accent */
  color?: string;
  /** True if this is a GSD-core agent definition */
  isGsd: boolean;
  /** Absolute path to the source markdown file */
  path: string;
}

export interface ParsedPersonaFile {
  meta: Record<string, string>;
  body: string;
}

/**
 * Parses markdown file with YAML frontmatter.
 */
export function parsePersonaFrontmatter(content: string): ParsedPersonaFile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content.trim() };
  }
  const yamlLines = match[1].split(/\r?\n/);
  const meta: Record<string, string> = {};
  for (const line of yamlLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return { meta, body: match[2].trim() };
}
