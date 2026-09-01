/**
 * Resolves an agent identifier (e.g. 'god', 'jim-mthuwhtq') to a human-friendly display name.
 * 
 * Rules:
 * - Empty / undefined / null -> 'unassigned'
 * - 'god' -> 'BeeYoncé' (the Overmind)
 * - Look up in active agents list
 * - Look up in restorable agents list (archived/previous sessions)
 * - Fall back to capitalized prefix (e.g. 'jim' from 'jim-mthuwhtq' -> 'Jim') or raw ID
 */
export function getAgentDisplayName(
  id: string | null | undefined,
  agents: Array<{ id: string; name?: string; isOvermind?: boolean }> = [],
  restorableAgents: Array<{ id: string; name?: string }> = []
): string {
  if (!id) return 'unassigned';
  const trimmed = id.trim();
  if (trimmed === 'god' || trimmed.toLowerCase() === 'god') return 'BeeYoncé';
  if (trimmed === 'human' || trimmed.toLowerCase() === 'human') return 'Human';

  const found =
    agents.find((a) => a.id === trimmed || (trimmed === 'god' && a.isOvermind))?.name ??
    restorableAgents.find((a) => a.id === trimmed)?.name;
  if (found) return found;

  // If id is in format 'name-hash' (e.g. 'jim-mthuwhtq', 'pam-kdf92j'), make it readable
  if (trimmed.includes('-')) {
    const head = trimmed.split('-')[0];
    if (head && head.length > 1) {
      return head.charAt(0).toUpperCase() + head.slice(1);
    }
  }

  return trimmed;
}
