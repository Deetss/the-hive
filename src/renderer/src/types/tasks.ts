/** The human's answer text plus at most one attached image (data URL). Written
 *  in place of a plain string `a` only when an image is attached, so every
 *  older answer on disk keeps parsing as a string. */
export interface HumanQAAnswer {
  text: string;
  images?: string[];
}

export interface HumanQA {
  q: string;
  /** Default 'question'. 'action' = human must DO something (sets doneAt when complete).
   *  'review' = human must approve a doc (sets approved). 'decision' = agent needs a
   *  freeform text answer (which option? / yes please) — ASK ME shows a text box, not
   *  PASS/FAIL, and answering moves a blocked card back to 'doing' without closing it. */
  kind?: 'question' | 'action' | 'review' | 'decision';
  a?: string | HumanQAAnswer;
  askedAt?: string;
  answeredAt?: string;
  /** Set when the human dismisses the ask from the ASK ME board WITHOUT answering —
   *  the question stays on the card (history is preserved) but openQuestion() stops
   *  returning it, so the card leaves ASK ME. */
  dismissedAt?: string;
  /** action entries: ISO timestamp when the human completed the action. */
  doneAt?: string;
  /** review entries: path to the document or report to review. */
  docPath?: string;
  /** review entries: true = approved, false = changes requested. undefined = pending. */
  approved?: boolean;
  /** "Chat about this": a back-and-forth between the human and the assigned agent
   *  on this item, additive to the PASS/FAIL/comment decision. */
  thread?: HumanQAThreadMsg[];
}

export interface HumanQAThreadMsg {
  from: 'human' | 'agent';
  text: string;
  ts: string;
  /** At most one attached image (a data URL), human side only. */
  images?: string[];
}

export interface OpenHumanQAItem {
  taskId: string;
  taskTitle: string;
  assignee: string | null;
  question: string;
  priority?: 'urgent' | 'normal' | 'backlog';
  askedAt: string;
  /** Carried from the qa entry so ASK ME can pick the answer UI: 'decision' gets a
   *  text box, anything else keeps the PASS/FAIL UAT flow. */
  kind?: HumanQA['kind'];
  /** The chat thread for this item, carried through so ASK ME can render it. */
  thread?: HumanQAThreadMsg[];
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  result?: string;
  /** Completion percent 0–100, shown as a bar on the card. Optional: a card
   *  without it renders no bar. */
  progress?: number;
  /** Timestamped progress notes written by the assigned agent during execution.
   *  Each entry is a milestone the agent recorded mid-task so the kanban board
   *  shows live progress. Agents should append entries (never overwrite) by
   *  reading tasks.json, pushing { step, ts }, and writing back. */
  progressLog?: ProgressEntry[];
  /** First-class human feedback: the god appends {q} when a card needs the human;
   *  the ASK ME view fills in {a}. Full history stays on the card. */
  humanQA?: HumanQA[];
}

/** A single timestamped progress note written by an agent during task execution. */
export interface ProgressEntry {
  step: string;
  ts: string;
}

export interface TaskSessionSnapshot {
  id: string;
  label: string;
  startedAt: number;
  endedAt: number;
  tasks: HiveTask[];
}

export interface ActiveTaskSession {
  id: string;
  label: string;
  startedAt: number;
}
