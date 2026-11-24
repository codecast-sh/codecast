// A stranded handoff: a session finished a change and handed it over for
// review (`cast task handoff --status done`), and days later nothing says it
// reached the default branch. The task still sits in review, no commit naming
// it landed (tasks.landed), no run of the line merged it, and no pull request
// the handoff names is merged.
//
// This is where work goes missing: the session that wrote it is killed days
// after the handoff, and its branch or worktree outlives everyone's attention.
// Only `in_review` counts. A task someone moved to done is that person's claim
// the work landed, and on prod those claims held (every done task sampled had
// its files on main); counting them buried the real cases in false alarms.
//
// Only the newest handoff is judged. A task handed off twice is two rounds of
// work, and a landing or merged pull request from the first round says nothing
// about the second. What landed before the handoff counts only when the handoff
// names its commit or came within the hour: a session pushes, then hands off.
//
// Pure, so the Convex reader and its tests share one rule.

import { parsePrRef } from "./prRefs";

export const STRANDED_AFTER_DAYS = 3;
const DAY_MS = 86_400_000;
const PUSH_THEN_HANDOFF_MS = 3_600_000;

export type PrState = "open" | "closed" | "merged";
export type HandoffPrRef = { repository?: string; number: number };

/** One row of `cast task stranded`. */
export type StrandedRow = {
  short_id: string;
  title: string;
  assignee: string | null;
  handed_off_at: number;
  handed_off_by: string | null;
  branches: string[];
  prs: Array<HandoffPrRef & { state: PrState | null }>;
};

/** `cast task stranded`'s answer. `capped_at` is set when more tasks sit in
 *  review than one read takes: only that many, the least recently touched,
 *  were judged. */
export type StrandedList = { rows: StrandedRow[]; capped_at: number | null };

/** The pull requests a handoff names: its `PR:` line (read by the caller, so
 *  every reader of that line is one), a GitHub pull URL in the evidence, or
 *  "PR #N". A bare "#N" in the evidence is not read: evidence cites other
 *  pull requests that way ("after #4398"). */
export function handoffPrRefs(text: string, prLine?: string | null): HandoffPrRef[] {
  const refs = new Map<string, HandoffPrRef>();
  const add = (ref: { repository?: string; number?: number } | null) => {
    if (ref?.number == null) return;
    if (!ref.repository && [...refs.values()].some((r) => r.number === ref.number)) return;
    refs.set(`${ref.repository ?? ""}#${ref.number}`, ref.repository ? { repository: ref.repository, number: ref.number } : { number: ref.number });
  };
  add(parsePrRef(prLine));
  for (const m of text.matchAll(/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pulls?\/\d+/g)) add(parsePrRef(m[0]));
  for (const m of text.matchAll(/\bPR #(\d+)\b/g)) add({ number: Number(m[1]) });
  return [...refs.values()];
}

// A remote's default branch is where the work goes, not where it waits.
const DEFAULT_BRANCH = /^(?:origin|upstream)\/(?:main|master)$/;

/** The branches a handoff names ("Branch codecast/w1b", "on branch x/y"). A
 *  name starts with a letter and holds a slash, so a tally like 24/24 is not
 *  one, and origin/main is the default branch, not a branch the work sits on. */
export function handoffBranches(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[Bb]ranch:?\s+`?([A-Za-z][\w.-]*\/[\w./-]*\w)`?/g)) if (!DEFAULT_BRANCH.test(m[1])) out.add(m[1]);
  return [...out];
}

export type StrandedFacts = {
  status: string;
  execution_status?: string | null;
  /** The newest `Handoff:` review comment. */
  handoff: { at: number; text: string; conversation_id?: string } | null;
  /** When the change guide was written, if the task has one. */
  guide_at: number | null;
  files_changed: number;
  /** The task's landings: a default-branch commit naming it (tasks.landed), a run's merge. */
  landings: ReadonlyArray<{ at: number; sha?: string }>;
  /** The pull requests the handoff names, with the state the server holds (none when it holds no row or can't tell). */
  prs: ReadonlyArray<HandoffPrRef & { state?: PrState }>;
  /** Pull requests that name the task themselves (their ct- ids), with when each merged. */
  linked_prs: ReadonlyArray<HandoffPrRef & { state: PrState; merged_at?: number }>;
};

export type Stranded = {
  handed_off_at: number;
  handed_off_by?: string;
  branches: string[];
  prs: Array<HandoffPrRef & { state?: PrState }>;
};

export function strandedHandoff(f: StrandedFacts, now: number, afterDays = STRANDED_AFTER_DAYS): Stranded | null {
  if (f.status !== "in_review") return null;
  if (f.execution_status !== "done" && f.execution_status !== "done_with_concerns") return null;
  const h = f.handoff;
  if (!h || now - h.at < afterDays * DAY_MS) return null;
  const withHandoff = (at: number | null | undefined) => at != null && at >= h.at - PUSH_THEN_HANDOFF_MS;
  if (f.landings.some((l) => withHandoff(l.at) || (!!l.sha && h.text.includes(l.sha.slice(0, 7))))) return null;
  if (f.prs.some((p) => p.state === "merged")) return null;
  if (f.linked_prs.some((p) => p.state === "merged" && withHandoff(p.merged_at))) return null;
  const openLinked = f.linked_prs.filter((p) => p.state === "open" && !f.prs.some((n) => n.number === p.number));
  const prs = [...f.prs, ...openLinked];
  const branches = handoffBranches(h.text);
  // No code in this round: research, an operations run, a report. Nothing to land.
  if (!withHandoff(f.guide_at) && !f.files_changed && !prs.length && !branches.length) return null;
  return { handed_off_at: h.at, handed_off_by: h.conversation_id, branches, prs };
}
