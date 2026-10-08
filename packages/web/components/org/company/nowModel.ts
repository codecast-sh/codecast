// What a sheet's Now reads (cohesive build spec §5.1, D8), worked out without
// React: the live sessions in words, the open proposal cards about the
// object, and the decisions and stuck role it stands for.
import { storeHoldsObject } from "../useNeedsYou";
import { decisionSubject, type NeedsYouItem } from "../staffingModel";
import { proposalSubjects, type SubjectCard, type SubjectLive } from "../proposalSubjects";
import type { OrgProposalRow } from "../orgStaffingTypes";
import { countStates, type OrgRole, type OrgSession } from "../orgTypes";

/** What the block is about, in the forms each source names it by. */
export type NowSubject = {
  /** The proposal subject keys that are this object ("goal:<id>", "project:<id>", "role:<handle>"). */
  keys: string[];
  /** A decision is about this object when it cites one of these refs, or (for a role) was asked in its thread. */
  refs: string[];
  /** The role itself, for a role sheet: a stuck role and the decisions in its threads. */
  role?: OrgRole | null;
  /** People the object is: a change that names one of them as owner or as whom a role reports to touches it. */
  users?: string[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 sessions at work, 1 waiting on input", from the live states only. */
export function sessionsLine(sessions: readonly OrgSession[]): { line: string; counts: ReturnType<typeof countStates> } | null {
  const counts = countStates([...sessions]);
  const working = counts.working ?? 0;
  const waiting = counts.needs_input ?? 0;
  if (!working && !waiting) return null;
  const parts = [working ? `${plural(working, "session", "sessions")} at work` : null, waiting ? `${waiting} waiting on input` : null].filter(Boolean);
  return { line: parts.join(", "), counts };
}

/** True when a change names one of `users` as an owner or as whom a role reports to. */
function namesUser(change: unknown, users: ReadonlySet<string>): boolean {
  const c = change as Record<string, unknown>;
  return ["owner", "reports_to"].some((k) => {
    const ref = c[k] as { kind?: string; user_id?: string } | null | undefined;
    return ref?.kind === "user" && !!ref.user_id && users.has(ref.user_id);
  });
}

/** The open proposal cards whose subject is this object, or that name one of
 *  its people, still waiting on an answer. */
export function proposalLinesFor(open: readonly OrgProposalRow[], live: SubjectLive, keys: readonly string[], users: readonly string[] = []): { proposal: OrgProposalRow; card: SubjectCard }[] {
  if (keys.length === 0 && users.length === 0) return [];
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const people = new Set(users);
  return open.flatMap((proposal) => proposalSubjects(proposal.changes, live)
    .filter((card) => card.waiting > 0 && (wanted.has(card.key.toLowerCase()) || (people.size > 0 && card.changes.some((c) => namesUser(c.change, people)))))
    .map((card) => ({ proposal, card })));
}

/** The decisions and the stuck role this object stands for. */
export function asksFor(asks: readonly NeedsYouItem[], subject: NowSubject): NeedsYouItem[] {
  const refs = new Set(subject.refs.map((r) => r.toLowerCase()));
  return asks.filter((a) => {
    if (a.kind === "blocked") return !!subject.role && a.role._id === subject.role._id;
    if (a.kind !== "decision") return false;
    const about = decisionSubject(a.item, a.role, storeHoldsObject);
    return !!about && refs.has(about.ref.toLowerCase());
  });
}

