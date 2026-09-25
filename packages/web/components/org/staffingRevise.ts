import { isOrgQuietChange } from "@codecast/shared/contracts/orgProposal";
// The conversation is part of the proposal (docs/architecture/org-staffing.md
// S18): the pane reads the author's thread off the proposal, and reads what
// the author's revise did to each change so the list shows it under the
// reader. Pure helpers; the pane and ProposalThread render what they return.
import { changeFields } from "./staffingModel";
import type { OrgRole, OrgTree } from "./orgTypes";
import type { OrgChangeRevision, OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";

export type ProposalThreadRef = {
  conversationId: string;
  shortId?: string;
  /** Who answers there: the role's name, or "the agent that wrote this"
   *  when a session posted it (a session's title is not a name). */
  name: string;
  /** True when `name` is a proper name (a role), false for the agent phrase. */
  named: boolean;
  /** The role behind the thread, when a role wrote the proposal (its paused
   *  state is said above the composer). */
  role: OrgRole | null;
};

/**
 * The thread bound to a proposal: the server's pointer when it carries one
 * (`thread`), else derived from the author (a session author's id is its
 * conversation; a role author answers from its standing session). Null when
 * a person posted the proposal: there is no agent to talk to about it.
 */
export function proposalThread(p: Pick<OrgProposalRow, "author" | "thread">, tree: OrgTree | null): ProposalThreadRef | null {
  if (p.thread === null) return null;
  const role = p.author.kind === "role" ? tree?.roles.find((r) => r._id === p.author.id) ?? null : null;
  const roleName = role?.name ?? (p.author.kind === "role" ? p.author.name : undefined);
  const name = roleName ?? "the agent that wrote this";
  const named = !!roleName;
  if (p.thread?.conversation_id) return { conversationId: p.thread.conversation_id, shortId: p.thread.short_id, name, named, role };
  if (p.author.kind === "session") return { conversationId: p.author.id, shortId: p.author.short_id, name, named, role };
  if (role?.standing?.conversation_id) return { conversationId: role.standing.conversation_id, shortId: role.standing.short_id, name, named, role };
  return null;
}

/** One field the amend moved: its label, what it was, what it is now,
 *  both formatted for reading ("600,000"). */
export type FieldMove = { key: string; label: string; from: string | null; to: string | null };

/** A field's key as a reader says it: the last path segment, underscores
 *  as spaces, "per day" as "a day", the container ("caps") dropped. */
export function moveLabel(key: string): string {
  const last = key.split(".").pop() ?? key;
  return MOVE_WORDS[last] ?? last.replace(/_/g, " ").replace(/\bper day\b/, "a day");
}
/** Keys whose raw name is not a word the reader was taught: the row's own
 *  words for a scope or a move change, and a reporting line. */
const MOVE_WORDS: Record<string, string> = {
  add: "also looks after",
  scope_add: "also looks after",
  remove: "stops looking after",
  scope_remove: "stops looking after",
  reports_to: "reports to",
  every: "runs every",
};
const formatMoveValue = (v: string, kind: string): string => {
  if (kind !== "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : v;
};

/** What an amend changed, field by field, from `revision.before` to the
 *  change as it reads now. Empty when the row carries no before (a removed
 *  or added row), or when nothing readable moved (a rationale-only amend). */
export function amendedMoves(c: Pick<OrgProposalChange, "change" | "revision">): FieldMove[] {
  const before = c.revision?.kind === "amended" ? c.revision.before : undefined;
  if (!before) return [];
  const was = new Map(changeFields(before).map((f) => [f.key, f]));
  const now = new Map(changeFields(c.change).map((f) => [f.key, f]));
  const out: FieldMove[] = [];
  for (const [key, f] of now) {
    const w = was.get(key);
    if (!w) out.push({ key, label: moveLabel(key), from: null, to: formatMoveValue(f.value, f.kind) });
    else if (w.value !== f.value) out.push({ key, label: moveLabel(key), from: formatMoveValue(w.value, w.kind), to: formatMoveValue(f.value, f.kind) });
  }
  for (const [key, w] of was) if (!now.has(key)) out.push({ key, label: moveLabel(key), from: formatMoveValue(w.value, w.kind), to: null });
  return out;
}

/** The revise, in the reader's words: what happened and what the author said. */
export function revisionWord(r: OrgChangeRevision): string {
  return r.kind === "removed" ? "Removed" : r.kind === "amended" ? "Changed" : "New";
}

/** Changes the author revised after `since`: what landed under the reader
 *  since they last looked, newest first. */
export function revisedSince(changes: OrgProposalChange[], since: number): OrgProposalChange[] {
  // A quiet kind (a limit, S23.2) is never read, revised or not; the seen
  // stamp still carries its revision (latestOrgRevisionAt reads every row).
  return changes.filter((c) => c.revision && c.revision.at > since && !isOrgQuietChange(c.change)).sort((a, b) => b.revision!.at - a.revision!.at);
}

/** "Chief of Staff removed 1, changed 2 and added 1 since you last looked."
 *  `who` may be the agent phrase, so the line capitalises its first letter. */
export function revisedLine(rows: OrgProposalChange[], who: string): string {
  const n = { removed: 0, amended: 0, added: 0 };
  for (const r of rows) if (r.revision) n[r.revision.kind] += 1;
  const parts: string[] = [];
  if (n.removed) parts.push(`removed ${n.removed}`);
  if (n.amended) parts.push(`changed ${n.amended}`);
  if (n.added) parts.push(`added ${n.added}`);
  if (parts.length === 0) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${who.charAt(0).toUpperCase()}${who.slice(1)} ${list} since you last looked.`;
}
