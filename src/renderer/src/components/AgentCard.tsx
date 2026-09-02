import { AgentRosterItem, type AgentRosterItemProps } from './AgentRosterItem';

export type AgentCardProps = Omit<AgentRosterItemProps, 'variant'>;

/**
 * AgentCard — renders an agent in the bottom dock horizontal strip (or mobile stack).
 * Unified with the shared AgentRosterItem component (variant="card").
 */
export function AgentCard(props: AgentCardProps) {
  return <AgentRosterItem variant="card" {...props} />;
}
