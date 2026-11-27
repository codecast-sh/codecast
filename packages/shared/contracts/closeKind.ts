// What a Close does to one session, and the words that say so. One decision
// for every surface that names a Close: the card's tooltip and the phone's
// menu line (web lib/sessionClose gathers the facts from the row) and close
// advice (convex closeAdvice gathers them from the database), so no surface
// promises what the gesture does not do. Close is dormancy, not retirement:
// in-flight work is set aside to finish, and a closed session's machine wakes
// (a trigger, a park, another session's message) run it out of sight until it
// pins blocked, or done when it is an ordinary session (closedSession).
import { closeReturnsOnDone, type InFlightReason } from "./closedSession";
import { rowParkedWakeLive } from "./inboxPlacement";

/** A member of its nested group in flight: "nested_awaiting" when one waits
 *  on the person (a question or permission prompt), "nested" otherwise. */
export type NestedInFlight = "nested" | "nested_awaiting" | null;

export type CloseFacts = {
  /** Why it is in flight, itself or through its nested group, or null. */
  inFlight: InFlightReason | NestedInFlight;
  /** A role's own session or a standing anchor. */
  role: boolean;
  /** A closed session stays out through machine wakes and comes back when its
   *  agent pins blocked (Needs you); an ordinary one also when it pins done
   *  (closedSession closeReturnsOnDone), a role, an anchor or a standing trigger's home not. */
  returnsOnDone: boolean;
  /** Armed triggers that inject into it. */
  triggers: number;
  /** A park the server still stands behind (inboxPlacement rowParkedWakeLive). */
  parkedWake: "blocker" | "wait" | "run" | null;
  /** A codecast flow run it started, with station sessions of its own, that
   *  has not reported yet. */
  waitingOnRun: boolean;
  /** Agents under it a stop takes down with it (closeCascade
   *  cascadeTakesDownRow): its Task subagents and teammates. */
  takesDown: number;
};

/** The row fields the facts read the same way on every side. */
export type CloseFactsRow = {
  persistent?: boolean | null;
  standing_role_id?: unknown;
  armed_trigger_kind?: string | null;
  parked_wake_kind?: string | null;
  updated_at?: number | null;
};

/** What each side gathers its own way: the web from the rows it holds, the
 *  server from its database. */
export type GatheredCloseFacts = {
  inFlight: CloseFacts["inFlight"];
  /** Armed triggers injecting into it (contracts/armedTrigger). */
  armedTriggers: number;
  lastHeartbeat: number | null;
  /** The codecast flow run it started (not one it is a station of) is running or pending. */
  runLive: boolean;
  /** That run executes inside its own agent process (a Workflow-tool run). */
  inProcessRun: boolean;
  /** Members of its nested group a close takes down (closeCascade cascadeTakesDownRow). */
  takesDown: number;
};

/** One session's Close facts: the shared rules over the row and what each side gathered. */
export function closeFactsFrom(row: CloseFactsRow, g: GatheredCloseFacts, now: number): CloseFacts {
  const parked = rowParkedWakeLive({ parked_wake_kind: row.parked_wake_kind, updated_at: row.updated_at ?? 0, last_heartbeat: g.lastHeartbeat }, now);
  return {
    inFlight: g.inFlight,
    role: !!row.persistent || !!row.standing_role_id,
    returnsOnDone: closeReturnsOnDone(row),
    // The row says a trigger is armed before the roster or the scan has seen it.
    triggers: Math.max(g.armedTriggers, (row.armed_trigger_kind ?? "none") !== "none" ? 1 : 0),
    parkedWake: parked ? (row.parked_wake_kind as CloseFacts["parkedWake"]) : null,
    waitingOnRun: g.runLive && !g.inProcessRun,
    takesDown: g.takesDown,
  };
}

/** The inFlight fact from the session's own reason and its group's: waiting
 *  on the person anywhere in the group outranks everything else in flight. */
export function closeInFlightOf(own: InFlightReason | null, nested: NestedInFlight): CloseFacts["inFlight"] {
  if (own === "awaiting") return own;
  if (nested === "nested_awaiting") return nested;
  return own ?? nested;
}

/** What one member's own reason makes of its lead's group. */
export const nestedInFlightFrom = (member: InFlightReason | null): NestedInFlight =>
  member === "awaiting" ? "nested_awaiting" : member ? "nested" : null;

export type SessionCloseKind = "aside" | "awaiting" | "keeps_background" | "keeps_loop" | "keeps_limit" | "keeps_triggers" | "waits_on_park" | "waits_on_run" | "clears";

export function closeKindOf(f: CloseFacts): SessionCloseKind {
  if (f.inFlight === "awaiting" || f.inFlight === "nested_awaiting") return "awaiting";
  if (f.inFlight === "background") return "keeps_background";
  if (f.inFlight === "loop") return "keeps_loop";
  if (f.inFlight === "limit") return "keeps_limit";
  if (f.inFlight) return "aside";
  if (f.triggers > 0) return "keeps_triggers";
  if (f.parkedWake) return "waits_on_park";
  if (f.role) return "keeps_triggers";
  if (f.waitingOnRun) return "waits_on_run";
  return "clears";
}

/** Close sets it aside (the agent keeps running) instead of stopping it. */
export const closeSetsAside = (f: CloseFacts) => f.inFlight !== null;

// What its park does while it is closed: the wake runs it out of sight.
const PARK_GOES_ON: Record<NonNullable<CloseFacts["parkedWake"]>, string> = {
  blocker: "wakes when its blocker clears",
  wait: "wakes when its wait ends",
  run: "its run goes on",
};

// What brings a closed session back: its agent pinning done (an ordinary
// session) or blocked (closedSession isClosedHidden, convex
// performSetThreadState), or a person writing to it.
const closedBack = (returnsOnDone: boolean) => (returnsOnDone ? "back when it's done or needs you" : "back when it needs you");

/** The words a closed session a machine woke shows for what brings it back. */
export const closedBackWords = (row: Parameters<typeof closeReturnsOnDone>[0]) => closedBack(closeReturnsOnDone(row));

/** What a Close does, without the "Close: " the tooltip leads with. */
export function closeEffect(f: CloseFacts): string {
  const them = f.takesDown === 0 ? "it" : f.takesDown === 1 ? "it and the agent under it" : `it and the ${f.takesDown} agents under it`;
  const back = closedBack(f.returnsOnDone);
  switch (closeKindOf(f)) {
    case "aside": return `hides it, ${back}`;
    // Its own ask keeps it in view until answered (closedSession closeHeldByAsk).
    case "awaiting": return f.inFlight === "nested_awaiting" ? "hides it; one of its agents still waits on you" : `stays while it waits on you, then hides it, ${back}`;
    case "keeps_background": return `hides it, keeps its background work, ${back}`;
    case "keeps_loop": return `hides it, keeps its loop, ${back}`;
    // Its resume (a "continue" send, when recovery is on) is an ordinary send
    // and shows it; with recovery off, it waits for the person.
    case "keeps_limit": return "hides it, still parked on its limit";
    case "keeps_triggers":
      if (f.triggers === 0) return `stops ${them}, ${back}`;
      return `stops ${them}, runs its ${f.triggers === 1 ? "trigger" : `${f.triggers} triggers`} out of sight, ${back}`;
    case "waits_on_park": return `stops ${them}, ${PARK_GOES_ON[f.parkedWake!]}, ${back}`;
    case "waits_on_run": return `stops ${them}, its run goes on, ${back}`;
    case "clears": return `stops ${them}, clears ${f.takesDown ? "them" : "it"} from the list`;
  }
}

export const closeTooltip = (f: CloseFacts): string => `Close: ${closeEffect(f)}`;

/** The Close facts as a Kill leaves them (convex cleanup.ts): a Kill cuts off
 *  what is in flight and retires the session, canceling its triggers and
 *  queued messages, so neither a park nor a run's report brings it back. A
 *  persistent anchor's Kill is dormancy instead: its triggers and park stay. */
export function killFacts(f: CloseFacts, persistent: boolean): CloseFacts {
  if (persistent) return { ...f, inFlight: null };
  return { ...f, inFlight: null, triggers: 0, parkedWake: null, waitingOnRun: false };
}

// ── Close advice (`cast advise-close`, convex closeAdvice) ──

export type CloseVerdict = "close" | "needs_input";
/** decided_by: what the server verified ("facts"), the agent's own current
 *  pin ("pin"), the settle classifier ("settle"), or a model call ("model"). */
export type CloseAdvice = { verdict: CloseVerdict; reason: string; decided_by: "facts" | "pin" | "settle" | "model" };
/** What the server answers: the advice, why there is none, or that the
 *  feature is off ("team": the session's team lacks it; "personal": none of a
 *  personal session's owner's teams has it), with the shared off wording. */
export type CloseAdviceResult = { short_id: string } & ({ off: "team" | "personal"; message: string } | { advice: CloseAdvice } | { error: string });

// ── After a Close or Kill in the app (convex closeAdvice.adviseAfterClose) ──

/** The gesture advice is asked about: what it is read for is what the
 *  gesture leaves (killFacts), however far its write has landed. */
export type CloseGesture = "close" | "kill";
/** At most this many sessions of one gesture are advised; the rest are "skip". */
export const AFTER_CLOSE_MAX = 20;
/** How long each after-close model call may run. The app takes the verdicts
 *  only until its receipt plus CLOSE_ADVICE_HOLD_MS (11 s from the press; web
 *  lib/closeAdviceBar), and the calls run together, so this stays well under
 *  that: the action answers in time with every verdict that made it. */
export const AFTER_CLOSE_CALL_MS = 7000;
/** One closed session, of those the client did not file under Needs You:
 *  "needs_you" when it asked the person something (`reason` is the action,
 *  starting with a verb); "close" when closing lost nothing, or advice failed;
 *  "skip" when it was not advised (unreadable, the feature off, its waits
 *  answered by an agent owner, or past AFTER_CLOSE_MAX). */
export type AfterCloseResult = { session: string; verdict: "needs_you" | "close" | "skip"; reason?: string };
