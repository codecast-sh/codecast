// The triage model's look: the status mark, colour and word for each lane,
// ask and reason, in the status vocabulary's own marks (lib/sessionStatus), so
// a triaged row looks like every other session row in the app.
import { TRIAGE_ASK_WORDS, TRIAGE_LANE_WORDS, type Triage, type TriageAsk, type TriageLane } from "@codecast/shared/contracts/triage";
import type { SessionStatus } from "../sessionStatus";

/** The status mark a triaged row wears. */
export function statusOfTriage(t: Triage): SessionStatus {
  if (t.shelf === "retired") return "killed";
  switch (t.lane) {
    case "you": return t.ask === "fix" ? "error" : t.ask === "review" ? "done" : "needs_you";
    case "agent": return t.reason === "starting" ? "starting" : "working";
    case "parked": return "dormant";
    case "settled": return "idle";
  }
}

export const LANE_TEXT: Record<TriageLane, string> = {
  you: "text-sol-yellow",
  agent: "text-sol-green",
  parked: "text-[color:color-mix(in_srgb,var(--sol-blue)_60%,var(--sol-text-dim))]",
  settled: "text-sol-text-dim",
};

export const ASK_TEXT: Record<TriageAsk, string> = {
  answer: "text-sol-yellow",
  fix: "text-sol-red",
  review: "text-sol-cyan",
};

export const LANE_STATUS: Record<TriageLane, SessionStatus> = { you: "needs_you", agent: "working", parked: "dormant", settled: "idle" };
export const ASK_STATUS: Record<TriageAsk, SessionStatus> = { answer: "needs_you", fix: "error", review: "done" };

export function textOfTriage(t: Triage): string {
  return t.ask ? ASK_TEXT[t.ask] : LANE_TEXT[t.lane];
}

/** "in 25m", "3h ago": a short distance from now. */
export function shortDistance(ts: number, now: number): string {
  const d = ts - now;
  const abs = Math.abs(d);
  const unit = abs < 60_000 ? `${Math.max(1, Math.round(abs / 1000))}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function laneWord(lane: TriageLane): string {
  return TRIAGE_LANE_WORDS[lane];
}

export function askWord(ask: TriageAsk): string {
  return TRIAGE_ASK_WORDS[ask];
}

