// What /priorities draws (components/priorities), derived on read from the
// store's priority rows (their links and plans come from convex
// priorities.list), the history answer (typing per day) and the inbox's live
// session states. Nothing here is stored: each milestone's state, the ten
// days of typing.
import type { PriorityHistory, PriorityLinkedSession, PriorityPlanRef, PriorityRow, PrioritySessionState, PriorityStep } from "@codecast/shared/contracts/priorities";
import { milestoneStateOf, orderSessions, type MilestoneState, type MilestoneStateKind } from "@codecast/shared/contracts/priorityDerive";
import type { SessionStatus } from "./sessionStatus";
import type { DrawnMark } from "../store/inboxMark";

export const LIST_DAYS = 10;
const DAY = 86_400_000;

/** "2026-11-25" for a timestamp, in the viewer's local calendar. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last `n` local days, oldest first, today last. */
export function lastDays(n: number, now: number): string[] {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => localDayKey(d.getTime() - (n - 1 - i) * DAY));
}

/** A history series re-keyed onto `days`. */
export function alignCounts(history: PriorityHistory | undefined, days: readonly string[], counts: readonly number[] | undefined): number[] {
  if (!history || !counts) return days.map(() => 0);
  return days.map((d) => {
    const i = history.days.indexOf(d);
    return i === -1 ? 0 : counts[i] ?? 0;
  });
}

/** "just now", "12m", "3h", "2d". */
export function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * A drawn mark in the milestone vocabulary, for a session that does not ask:
 * working › dormant › idle (a stashed one counts toward no milestone:
 * buildModels). A mark outside it (done, stashed, error) reads as
 * idle; starting is working; a dismissed row is closed. A needs-you glyph
 * where the inbox does not count it as needing the viewer waits on someone
 * else: sleeping.
 */
function stateOfMark(s: SessionStatus): PrioritySessionState {
  switch (s) {
    case "working": case "starting": return "working";
    case "dormant": case "needs_you": return "dormant";
    case "killed": return "killed";
    default: return "idle";
  }
}

export const STATE_WORD: Record<PrioritySessionState, string> = {
  needs_you: "Needs you", working: "Working", dormant: "Sleeping", idle: "Idle", done: "Done", killed: "Closed",
};

/** A milestone's state mark in words (its tooltip, the legend). */
export const MILESTONE_STATE_WORD: Record<Exclude<MilestoneStateKind, "none">, string> = {
  needs_you: STATE_WORD.needs_you, start: "New session", working: STATE_WORD.working, dormant: STATE_WORD.dormant, idle: STATE_WORD.idle, done: "Done",
};

/**
 * A milestone reads Needs you exactly when one of its sessions sits where its
 * inbox counts it as needing you: Questions, Needs You, or a pinned card
 * waiting on the viewer. Otherwise it takes the most urgent of its live
 * sessions' drawn marks (working › dormant › idle). Marks outside that
 * vocabulary (done, error) read as idle: a done session's results wait to be
 * read, so it still counts as someone on it. A stashed session counts as
 * nobody on it: a milestone whose only live sessions are stashed offers a New
 * session to its owner. Rows always draw the inbox's own mark.
 *
 * `live` answers what the inbox draws (hooks/usePriorityModels liveMarkOf
 * over store/inboxMark inboxMarkOf), or undefined when it draws nothing: then
 * the server's state stands, a needs_you there read as idle whoever owns it
 * (nothing asks through a session the inbox does not draw, and it is not
 * asleep either). A session riding its role's lead opens at the
 * lead (`target`), where the answer is.
 */
const lineOf = (s: PriorityLinkedSession, live: (conversationId: string) => DrawnMark | undefined): SessionLine => {
  const drawn = live(s.conversation_id);
  if (drawn) return { ...s, state: drawn.asks ? "needs_you" : stateOfMark(drawn.mark), mark: drawn.mark, target: drawn.target, href: `/conversation/${drawn.target}` };
  return { ...s, state: s.state === "needs_you" ? "idle" : s.state, target: s.conversation_id, href: `/conversation/${s.conversation_id}` };
};

/**
 * A linked session as the list draws it: its state in the milestone
 * vocabulary, the mark its inbox draws when it draws one (its row shows that
 * mark), and the conversation it opens (`target`: its own, or the lead it
 * rides, where the answer is; `href` is web's route to it).
 */
export type SessionLine = PriorityLinkedSession & { target: string; href: string; mark?: SessionStatus };

/** The mark a session's row draws (both apps): its inbox's mark (Done's check, the stash tray, an error), else its own state's. */
export const sessionRowMark = (s: Pick<SessionLine, "mark" | "state">): SessionStatus => s.mark ?? s.state;

export type MilestoneModel = {
  key: string;
  tier: PriorityStep["tier"];
  done: boolean;
  step: PriorityStep;
  /** Its state mark (shared/contracts/priorityDerive milestoneStateOf). */
  state: MilestoneState<SessionLine>;
  /** Best first (orderSessions). */
  sessions: SessionLine[];
  /** Linked sessions the row did not carry. */
  more: number;
  /** Still open, every task it names done (the server's looks_done). */
  looksDone: boolean;
  /** A correction on it waits for the next pass. */
  correctionPending: boolean;
  plan: PriorityPlanRef | null;
  partOf: PriorityPlanRef[];
  tasks: string[];
  /** "owner/repo#N" refs. */
  prs: string[];
};

export type PriorityModel = {
  row: PriorityRow;
  milestones: MilestoneModel[];
  plan: PriorityPlanRef | null;
  /** Messages typed into it per shown day. */
  counts: number[];
};

/**
 * Every priority's model. `live` answers what its inbox draws for a session
 * (by conversation id); the server's state stands for the rest.
 */
export function buildModels(
  rows: readonly PriorityRow[],
  history: PriorityHistory | undefined,
  live: (conversationId: string) => DrawnMark | undefined,
  days: readonly string[],
): PriorityModel[] {
  const lanes = new Map((history?.lanes ?? []).map((l) => [l.short_id ?? l.key, l]));
  return rows.map((row) => {
    const links = new Map((row.links ?? []).map((l) => [l.key, l]));
    // Starting work is the owner's, and only on a priority still in play.
    const canStart = row.mine && row.status === "active";
    // Reads never return a dropped milestone; a row cached before that rule is held to it here.
    const milestones = row.steps.filter((step) => !step.dropped).map((step): MilestoneModel => {
      const l = links.get(step.key);
      const sessions = orderSessions((l?.sessions ?? []).map((s) => lineOf(s, live)));
      return {
        key: step.key,
        tier: step.tier,
        done: step.done,
        step,
        // A stashed session is set aside: nobody is on the milestone through it.
        state: milestoneStateOf({ done: step.done, sessions: sessions.filter((x) => x.mark !== "stashed") }, { canStart }),
        sessions,
        more: l?.sessions_more ?? 0,
        looksDone: !!l?.looks_done && !step.done,
        correctionPending: !!l?.correction_pending,
        plan: l?.plan ?? null,
        partOf: l?.part_of ?? [],
        tasks: step.refs.filter((r) => r.kind === "task").map((r) => r.id),
        prs: step.refs.filter((r) => r.kind === "pr").map((r) => r.id),
      };
    });
    return { row, milestones, plan: row.plan ?? null, counts: alignCounts(history, days, lanes.get(row.short_id)?.counts) };
  });
}

// ── Layout ───────────────────────────────────────────────────────────────

export type ListLayout = "phone" | "wide";

/**
 * Under a coarse pointer (a phone, Daylight), a press area at least 44px each
 * way centred on a small control, drawn as its ::after: the look is the same
 * at every pointer. The control is the area's containing block, and nothing
 * between it and its line may clip it.
 */
export const TOUCH_AREA = "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:top-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:bottom-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:left-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:right-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:content-['']";

/** A button 44px tall under a coarse pointer, its look kept on a mouse (the Modern style sizes buttons itself, so it is named too). */
export const COARSE_TALL = "[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:modern:h-11";

/**
 * The desktop grid for a list at least 520px wide, or on a touch screen at
 * least 900px wide (Daylight, 947), however narrow its sidebars leave the
 * list; a phone-sized list (~370px at 402) folds into the phone layout.
 */
const WIDE_MIN_LIST_WIDTH = 520;
export const TABLET_QUERY = "(pointer: coarse) and (min-width: 900px)";
export const layoutForWidth = (width: number, tablet = false): ListLayout => (tablet || width >= WIDE_MIN_LIST_WIDTH ? "wide" : "phone");

/** A deploy a milestone reached, as its row draws it (Connected, with components/priorities/parts DeployMark). */
export type DeployInfo = { id: string; short_id: string; target: string; status: string; at: number };
