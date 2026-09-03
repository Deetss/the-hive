/**
 * The inbox-wake nudge — the text queued for an agent that has unread hive mail,
 * and the predicate the message queue uses to keep only one of them pending.
 *
 * The nudge is QUEUED the moment fresh mail is seen but TYPED only once the agent
 * is idle and off cooldown, and it survives a renderer reload in the persisted
 * queue. By the time it lands, the agent has often already drained that mail and
 * filed it under `inbox/.done/` — so the nudge arrives against an inbox the agent
 * itself just emptied.
 */

/** The fixed head of every nudge; the ids that follow differ per nudge. */
const NUDGE_HEAD = 'You have new hive inbox message(s)';

/** Total characters of message content a nudge will inline before it starts
 *  truncating — keeps the notification bounded regardless of how much mail
 *  is pending or how long any one message runs. */
const MAX_INLINE_CHARS = 4000;

/** The fields of a pending inbox message a nudge needs to inline its content.
 *  Deliberately narrower than the full `HiveMessage` (main-only type) so this
 *  shared module stays free of a main-process dependency. */
export interface InboxMessageSummary {
  id: string;
  from: string;
  subject: string;
  body: string;
}

/** Render each message's content as `--- [id] from X — subject ---\nbody`,
 *  stopping (and truncating the message that crosses it) at MAX_INLINE_CHARS
 *  so one oversized message can't crowd out the rest or balloon the nudge. */
function inlineContent(messages: InboxMessageSummary[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const m of messages) {
    if (used >= MAX_INLINE_CHARS) break;
    const header = `--- [${m.id}] from ${m.from} — ${m.subject || '(no subject)'} ---`;
    const budget = MAX_INLINE_CHARS - used - header.length - 1;
    const rawBody = m.body ?? '';
    const body = rawBody.length > budget
      ? `${rawBody.slice(0, Math.max(0, budget))}…[truncated — read the file in inbox/ for the rest]`
      : rawBody;
    const entry = `${header}\n${body}`;
    parts.push(entry);
    used += entry.length + 2;
  }
  return parts.join('\n\n');
}

/**
 * Build the nudge, naming AND inlining the messages that prompted it.
 *
 * The ids are diagnostic, NOT a work list: they let an agent tell "I already
 * handled this last turn" (the id sits in `inbox/.done/`) from "the harness woke
 * me for nothing", which is the distinction it otherwise cannot make and burns a
 * round-trip guessing at. The pending inbox stays authoritative — an agent that
 * has a nudge suppressed by the one-pending rule below still finds its mail by
 * reading the directory, so the text must never invite it to stop at the ids.
 *
 * The content itself is inlined (capped at MAX_INLINE_CHARS total) so an agent
 * can act on straightforward mail without a round-trip of tool calls just to
 * read its own inbox files; a message that got truncated, or arrived after this
 * nudge was built, still needs the file read.
 */
export function inboxNudgeText(messages: InboxMessageSummary[]): string {
  const ids = messages.map((m) => m.id).filter(Boolean);
  const named = ids.length ? ` — at least: ${ids.join(', ')}` : '';
  const content = inlineContent(messages);
  const contentBlock = content ? `\n\n${content}\n` : '';
  return `${NUDGE_HEAD}${named}.${contentBlock}\nRead your inbox, act on what is pending there, and move handled ones to inbox/.done/. Your inbox directory is authoritative: work everything still pending in it, and if a named id is already in inbox/.done/ you handled it on an earlier turn and can ignore that one. Act autonomously; only message god if you genuinely need a decision.`;
}

/**
 * Is this queued text an inbox-wake nudge?
 *
 * Matches the fixed head only, since every nudge carries different ids — the
 * point is to recognise the COMMAND, not one instance of it. Mirrors
 * `isCompactionCommand`, and the queue's one-pending rule leans on it the same way.
 */
export function isInboxNudge(text: string): boolean {
  return text.trim().startsWith(NUDGE_HEAD);
}
