import { AgentRosterItem, type AgentRosterItemProps, type RosterVariant, type RowDragHandlers } from './AgentRosterItem';
import { type Agent } from '@/store/store';

export interface RosterListProps {
  agents: Agent[];
  variant?: RosterVariant;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  quotaById?: Record<string, boolean>;
  needsInputById?: Record<string, string>;
  profileNameById?: Record<string, string>;
  doingByAgent?: Record<string, string[]>;
  onRename?: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  onEditNote?: (id: string) => void;
  onNoteChange?: (id: string, note: string) => void;
  onTaskNoteClick?: (id: string) => void;
  onRespawn?: (id: string) => void;
  scale?: { portrait: number; portraitScale: number; name: number; note: number; group?: number };
  drag?: RowDragHandlers;
  draggable?: boolean;
}

/**
 * RosterList — renders a collection of agents using the unified AgentRosterItem component.
 */
export function RosterList({
  agents,
  variant = 'card',
  selectedId,
  onSelect,
  quotaById = {},
  needsInputById = {},
  profileNameById = {},
  doingByAgent = {},
  onRename,
  onEditNote,
  onNoteChange,
  onTaskNoteClick,
  onRespawn,
  scale,
  drag,
  draggable
}: RosterListProps) {
  return (
    <>
      {agents.map((agent) => (
        <AgentRosterItem
          key={agent.id}
          variant={variant}
          agent={agent}
          selected={selectedId === agent.id}
          active={selectedId === agent.id}
          onClick={() => onSelect?.(agent.id)}
          quotaLimited={quotaById[agent.id]}
          needsInput={needsInputById[agent.id]}
          profileLabel={agent.profileId ? profileNameById[agent.profileId] : undefined}
          doingCount={doingByAgent[agent.id]?.length ?? 0}
          onRename={onRename ? (name) => onRename(agent.id, name) : undefined}
          onEditNote={onEditNote ? () => onEditNote(agent.id) : undefined}
          onNoteChange={onNoteChange ? (note) => onNoteChange(agent.id, note) : undefined}
          onTaskNoteClick={onTaskNoteClick ? () => onTaskNoteClick(agent.id) : undefined}
          onRespawn={onRespawn}
          scale={scale}
          drag={drag}
          draggable={draggable}
        />
      ))}
    </>
  );
}
