import { isOrgQuietChange } from "@codecast/shared/contracts/orgProposal";
// The conversation is part of the proposal (docs/architecture/org-staffing.md
// S18): the pane reads the author's thread off the proposal, and reads what
// the author's revise did to each change so the list shows it under the
// reader. Pure helpers; the cards render what they return.
import type { OrgRole, OrgTree } from "./orgTypes";
import type { OrgChangeRevision, OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";

export type ProposalThreadRef = {
  conversationId: string;
  shortId?: string;
  /** Who answers there: the role's name, or "the author of this proposal"
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
  const name = roleName ?? "the author of this proposal";
  const named = !!roleName;
  if (p.thread?.conversation_id) return { conversationId: p.thread.conversation_id, shortId: p.thread.short_id, name, named, role };
  if (p.author.kind === "session") return { conversationId: p.author.id, shortId: p.author.short_id, name, named, role };
  if (role?.standing?.conversation_id) return { conversationId: role.standing.conversation_id, shortId: role.standing.short_id, name, named, role };
  return null;
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

/** "Head of People removed 1, changed 2 and added 1 since you last looked."
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
