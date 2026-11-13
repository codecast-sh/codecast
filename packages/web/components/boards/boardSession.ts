// A board's workshop state, shared by everyone on it: a dot vote and a timer.
// It lives in one element of kind "session" (key SESSION_KEY) that the canvas
// never draws; votes live on the stickies themselves (`votes`: the voters'
// ids, one entry per vote). Everything here is pure; BoardView writes the ops.
import type { ArtifactOp } from "@codecast/shared/artifacts";
import type { BoardEl } from "./boardTypes";

export const SESSION_KEY = "el_session";
export const VOTES_PER_PERSON = 3;

export type Voting = { open: boolean; per: number };
export type Timer = { ends_at: number; ms: number };
export type BoardSession = { voting: Voting | null; timer: Timer | null };

export function readSession(el: BoardEl | undefined): BoardSession {
  const v = el?.voting as Voting | null | undefined;
  const t = el?.timer as Timer | null | undefined;
  return {
    voting: v && typeof v === "object" ? { open: v.open !== false, per: typeof v.per === "number" ? v.per : VOTES_PER_PERSON } : null,
    timer: t && typeof t.ends_at === "number" ? { ends_at: t.ends_at, ms: typeof t.ms === "number" ? t.ms : 0 } : null,
  };
}

export const votesOf = (el: BoardEl): string[] => (Array.isArray(el.votes) ? (el.votes as unknown[]).filter((v): v is string => typeof v === "string") : []);

/** How many of `me`'s votes are placed on the board. */
export function votesUsed(els: Iterable<BoardEl>, me: string): number {
  let n = 0;
  for (const e of els) n += votesOf(e).filter((v) => v === me).length;
  return n;
}

/** A click on a sticky while voting: my vote goes on it, or (when it is already there) comes off. Null when out of votes. */
export function toggleVoteOps(sticky: BoardEl, me: string, used: number, per: number): ArtifactOp[] | null {
  const votes = votesOf(sticky);
  const i = votes.indexOf(me);
  if (i >= 0) return [{ k: sticky.key, set: { votes: [...votes.slice(0, i), ...votes.slice(i + 1)] } }];
  if (used >= per) return null;
  return [{ k: sticky.key, set: { votes: [...votes, me] } }];
}

/** A write to the session element, creating it the first time. */
export function sessionOp(hasSession: boolean, set: Partial<BoardSession>): ArtifactOp {
  return (hasSession ? { k: SESSION_KEY, set } : { k: SESSION_KEY, put: { kind: "session", voting: null, timer: null, ...set } }) as ArtifactOp;
}

const clearVotes = (els: Iterable<BoardEl>) => [...els].filter((e) => votesOf(e).length).map((e) => ({ k: e.key, set: { votes: null } }) as ArtifactOp);

/** Start a vote: the session opens, and votes from a last round come off. */
export function startVotingOps(els: Iterable<BoardEl>, hasSession: boolean, per = VOTES_PER_PERSON): ArtifactOp[] {
  return [sessionOp(hasSession, { voting: { open: true, per } }), ...clearVotes(els)];
}

/** Clear the results: the vote closes and every dot comes off. */
export function clearVotingOps(els: Iterable<BoardEl>): ArtifactOp[] {
  return [sessionOp(true, { voting: null }), ...clearVotes(els)];
}

/** Stickies with votes, most votes first: the results. */
export function voteResults(els: Iterable<BoardEl>): { key: string; count: number }[] {
  return [...els].map((e) => ({ key: e.key, count: votesOf(e).length })).filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
}

/** Time left on a timer, as m:ss. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
