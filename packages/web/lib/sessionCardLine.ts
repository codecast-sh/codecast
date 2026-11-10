// The Modern session card's second line, decided once (components/inbox/
// ModernSessionCard): the state's word, the reason behind it when the state
// has one worth naming ("Usage limit", "Waiting for your OK", "Until Fri
// 9:00"), then one line about the work. The Classic card stacked a pinned-state
// line, a summary, a prompt, a draft, a snooze line and a rest line; this picks
// the one that says the most and leaves the rest to the line's tooltip.

import type { NoticeKind } from "@codecast/shared/contracts/assistant";
import { NOTICE_ROW_WORD } from "./hostedNotice";
import { sessionStartupState } from "./sessionLifecycle";
import { statusFailure, type SessionStatus, type StatusLive, type StatusRow } from "./sessionStatus";

export type CardLineRow = StatusRow & {
  user_rest?: string | null;
  _hasDraft?: boolean;
  subagent_slot?: string | null;
  merge_back?: { state: string } | null;
  implementation_session?: unknown;
};

export type CardLineInput = {
  row: CardLineRow;
  status: SessionStatus;
  now: number;
  live?: StatusLive & {
    /** A kill and restart is in flight. */
    restarting?: boolean;
    /** A hosted turn waits on the person's OK. */
    asksOk?: boolean;
    /** The stop notice a hosted turn ended on. */
    stoppedKind?: NoticeKind | null;
  };
  /** The agent's pinned line (lib/threadState cardLine), when fresh. */
  stateLine?: string | null;
  /** The generated summary (lib/sessionSummary). */
  summary?: string | null;
  /** What the person last sent, cleaned. */
  prompt?: string | null;
  /** The kept compose draft's text. */
  draft?: string | null;
  hosted?: boolean;
  /** Stashed and hidden: trigger wakes do not bring it back. */
  stashHidden?: boolean;
};

export type CardLine = {
  /** Said right after the word, in the word's weight. */
  reason: string | null;
  /** The reason in full, for its tooltip. */
  reasonTitle?: string;
  /** One line about the work. */
  text: string;
  /** The text is what the person last sent (drawn behind a ">"). */
  prompt: boolean;
  /** Everything the line left out, for its tooltip. */
  rest: string[];
};

const MERGE_WORDS: Record<string, string> = {
  pending: "Merging back",
  merged: "Merged back",
  empty: "Nothing to merge",
  conflict: "Merge conflict",
  kept: "Changes kept",
  failed: "Merge failed",
};

/** "Sep 30, 6:00 PM": the snooze's end, as the Classic card said it. */
export function snoozeUntilWords(until: number): string {
  return new Date(until).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function reasonOf(input: CardLineInput): { reason: string | null; reasonTitle?: string } {
  const { row, status, now } = input;
  const live = input.live ?? {};
  // The person's own move in flight outranks whatever the row last said: the
  // section re-files it the moment the agent confirms.
  if (status !== "stashed" && status !== "killed") {
    if (live.restarting) return { reason: "Restarting", reasonTitle: "Kill and restart in flight" };
    if (live.pendingSend && !input.hosted) return { reason: "Sending", reasonTitle: "Sent; waiting for the agent to confirm delivery" };
    if (row.subagent_slot === "queued") return { reason: "Queued", reasonTitle: "Waiting for a subagent slot" };
  }
  switch (status) {
    case "error": {
      if (live.stoppedKind) return { reason: NOTICE_ROW_WORD[live.stoppedKind], reasonTitle: "The assistant stopped before answering. Open it to try again." };
      const failure = statusFailure(row, now, live);
      return failure ? { reason: failure.label, reasonTitle: failure.title } : { reason: null };
    }
    case "needs_you":
      if (live.asksOk) return { reason: "Waiting for your OK", reasonTitle: "Your assistant is waiting for your OK. Open it to answer." };
      if (row.agent_status === "permission_blocked") return { reason: "Permission" };
      if (row.awaiting_input) return { reason: "Question" };
      if (live.asking) return { reason: "Decision" };
      if (row.user_rest === "needs_input") return { reason: "Filed by you", reasonTitle: "Filed under Needs You until the next wake" };
      return { reason: null };
    case "working":
      return { reason: null };
    case "starting":
      if (input.hosted) return { reason: "Getting started" };
      if (!row.is_connected && !live.pendingSend) return { reason: "Connecting" };
      return { reason: null };
    case "idle":
      if ((row.message_count ?? 0) > 0) return { reason: null };
      if (row._hasDraft) return { reason: "Draft" };
      return sessionStartupState({ isConnected: !!row.is_connected, ageMs: now - (row.started_at || row.updated_at || now) }) === "stalled"
        ? { reason: "Waiting for connection" }
        : { reason: "Ready" };
    case "dormant":
      if (row.inbox_snoozed_until && row.inbox_snoozed_until > now) return { reason: `Until ${snoozeUntilWords(row.inbox_snoozed_until)}`, reasonTitle: "Snoozed; it comes back on its own" };
      if (row.user_rest === "dormant") return { reason: "Parked by you", reasonTitle: "Parked; returns on the next wake" };
      return { reason: null };
    case "done":
      if (row.merge_back) return { reason: MERGE_WORDS[row.merge_back.state] ?? null };
      if (row.user_rest === "done") return { reason: "Filed by you", reasonTitle: "Filed as done until the next wake" };
      return { reason: null };
    case "stashed":
      return input.stashHidden ? { reason: "Hidden", reasonTitle: "Stashed and hidden: trigger wakes don't bring it back; only an ask does" } : { reason: null };
    case "killed":
      return { reason: null };
  }
}

/** The card's second line. */
export function sessionCardLine(input: CardLineInput): CardLine {
  const { reason, reasonTitle } = reasonOf(input);
  const prompt = input.prompt?.trim() || "";
  const draft = input.row._hasDraft ? (input.draft?.trim() || "") : "";
  // A session handing its plan to an implementation session says so with a
  // link on the third line; its own summary would describe the plan.
  const about = input.row.implementation_session ? "" : (input.stateLine?.trim() || input.summary?.trim() || "");
  const text = draft || about || prompt;
  const rest: string[] = [];
  if (input.stateLine && input.summary && text !== input.summary) rest.push(input.summary.trim());
  if (prompt && text !== prompt) rest.push(`> ${prompt}`);
  return { reason, reasonTitle, text, prompt: !draft && !about && !!prompt, rest };
}
