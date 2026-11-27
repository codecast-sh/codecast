// Priority change cards (plan pl-1131): behind a person's `priority_cards`
// experiment, a priorities pass run writes everything it writes without the
// experiment except its merges (sd-5035), and proposes those on one decision
// card. Until a merge is accepted nothing of it happens: the absorbed
// priority keeps its milestones and sessions. A merge the person declines
// (leaves unticked, or dismisses) is never proposed again. The card is
// stored on the decision row (session_decisions.priority_card): it is the
// proposal's one home. The decision is a silent multi-select whose option i
// is change i, so every client that answers a multi decision answers this
// one; the web draws it from this payload. Answering writes the picked
// merges against the priorities as they stand then (convex
// lib/priorityCardApply). The kinds below other than "merge" are not put on
// a card today.
// PURE isomorphic data — no Node or DOM APIs.

/** What one row of the card changes. Each kind has its own icon and, where it does not explain itself, a one-word prefix. */
export type PriorityChangeKind =
  // A priority
  | "move" // to: the slot it lands in; from: the slot it holds now
  | "rename" // from/to: titles
  | "new_priority" // to: the slot it lands in
  | "done"
  | "reopen"
  | "serves" // from/to: the goals' titles; null = none
  | "merge" // from: the absorbed priority's title; target: the absorbed short id
  // A milestone
  | "new_milestone" // to: its title
  | "rename_milestone" // from/to: titles
  | "milestone_done"
  | "milestone_reopen"
  | "to_critical"
  | "to_polish"
  | "drop_milestone";

/** Something said (a line the person typed) or something that happened (a call's action item, a task closed, a pull request merged). */
export type PriorityEvidence =
  | {
      kind: "quote";
      /** Verbatim: found in the run's input, or the evidence is dropped. */
      text: string;
      /** The session it was typed in: its short id and title, and when. */
      session: string;
      session_title: string;
      at: number;
    }
  | {
      kind: "event";
      /** Plain words: "Action item on “Broker email quality”: Jason works on the change request flow". */
      text: string;
      /** A call ("cl-244"), task ("ct-9") or pull request ("owner/repo#12") the line opens, when there is one. */
      ref?: string;
      at?: number;
    };

export type PriorityChange = {
  /** Stable within the card: "c1", "c2", … ; option i of the decision is changes[i]. */
  id: string;
  kind: PriorityChangeKind;
  /** The priority it changes: an existing short id ("pri-12"), or the plan's "new-N" for a priority this card creates. */
  priority: string;
  /** The milestone it changes: an existing key ("s3"), or the plan's key for one this card adds. */
  step_key?: string;
  /** A milestone of a new priority: unticking the new priority unticks it (it cannot land alone). */
  parent?: string;
  /** For merge: the short id of the priority absorbed. */
  target?: string;
  from?: string | number | null;
  to?: string | number | null;
  /** The existing milestone the row names, drawn as a chip: its title as it is now and its state mark. */
  milestone?: { title: string; state: "open" | "done" };
  evidence: PriorityEvidence[];
};

/** One priority on the card as it stands today, with the ids of its changes in order (priority-level first, then milestones). */
export type PriorityCardGroup = {
  priority: string;
  /** Its place among the person's active priorities now; null for a new one or one not active. */
  rank: number | null;
  title: string;
  changes: string[];
};

/** Share of what the person typed in the run's window, by the priority each session sits on after the run. */
export type PriorityWordsRow = { priority: string | null; rank: number | null; title: string; share: number };

export type PriorityCard = {
  v: 1;
  workspace: string;
  /** The run that proposed it (priority_pass_runs). */
  run_id: string;
  run: {
    at: number;
    window: { from: number; to: number };
    sessions: number;
    calls: number;
    cost_usd: number;
    /** Runs of this pass since the previous card, this one included (1 = the run right after the last card). */
    runs_since_last_card: number;
    /** Runs today, this one included. */
    runs_today: number;
  };
  groups: PriorityCardGroup[];
  changes: PriorityChange[];
  words: PriorityWordsRow[];
  /** Changes ticked when the card opens (all of them for now). */
  suggested: string[];
  /** Set once the person answered (a dismissal is "accept none"): the change ids written, those ticked that no longer applied to the priorities as they stood, and the words they wrote (saved as a correction the next pass reads). */
  outcome?: { accepted: string[]; skipped: string[]; at: number; text?: string };
};

/** The option text a client without the rich card shows for one change (the phone's multi-select, the CLI). */
export const CHANGE_PREFIX: Record<PriorityChangeKind, string | null> = {
  move: "Moved",
  rename: "Rename",
  new_priority: null,
  done: "Done",
  reopen: "Reopen",
  serves: "Serves",
  merge: "Merge",
  new_milestone: "New milestone",
  rename_milestone: "Rename",
  milestone_done: "Done",
  milestone_reopen: "Reopen",
  to_critical: "Critical",
  to_polish: "Polish",
  drop_milestone: "Drop",
};

/** The name an icon's hover shows. */
export const CHANGE_NAME: Record<PriorityChangeKind, string> = {
  move: "Moved",
  rename: "Rename",
  new_priority: "New priority",
  done: "Priority done",
  reopen: "Reopened",
  serves: "Serves another goal",
  merge: "Merged",
  new_milestone: "New milestone",
  rename_milestone: "Rename",
  milestone_done: "Milestone done",
  milestone_reopen: "Reopened",
  to_critical: "Moved to critical",
  to_polish: "Moved to polish",
  drop_milestone: "Dropped",
};

/** A row's plain text: the prefix (when its kind has one), then what changed. */
export function changeLine(c: PriorityChange, titleOf: (priority: string) => string): string {
  const prefix = CHANGE_PREFIX[c.kind];
  const ms = c.milestone?.title ?? "";
  const body = (() => {
    switch (c.kind) {
      case "move": return `to #${c.to} from #${c.from}`;
      case "rename": return `${c.to}`;
      case "new_priority": return c.to == null ? `New priority: ${titleOf(c.priority)}` : `New priority at #${c.to}: ${titleOf(c.priority)}`;
      case "done": case "reopen": return titleOf(c.priority);
      case "serves": return c.to ? `${c.to}` : "no goal";
      case "merge": return `absorbs ${c.from}`;
      case "new_milestone": return `${c.to}`;
      case "rename_milestone": return `${c.from} → ${c.to}`;
      default: return ms;
    }
  })();
  return prefix ? `${prefix}: ${body}` : body;
}

/** The experiment that turns the card on for one person (users.experiments). */
export const PRIORITY_CARDS_EXPERIMENT = "priority_cards";

/**
 * Whether a decision row is a priority card (the merges a pass run proposed,
 * waiting on their person).
 *
 * THE RULE: a priority card belongs to its person alone and is acted on only
 * through the card. Only its person (the row's user_id, in their own name)
 * answers or dismisses it; nobody passes, escalates, stacks, shares out or
 * reroutes it; no agent lists, reuses or cancels it; and no session-scoped
 * decision surface (the pending lift, a session's docked asks, other_open,
 * `cast decide ls`, the session's own decision list, its wait routing, a
 * run's gate or station reads, an approval rendering) treats it as the
 * question of the session it happens to sit in: it sits there only because a
 * decision row needs one. Every such surface, server, web and phone, tests
 * this predicate (convex lib/priorityCardAccess.ts holds the server's
 * refusals and read stripping; priorityCards.guard.test.ts lists every
 * server function that reads decisions by session or hands one off).
 */
export const isPriorityCard = (row: { priority_card?: unknown } | null | undefined): boolean => !!row?.priority_card;
