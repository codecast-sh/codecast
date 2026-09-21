import { useTrackedStore } from "../store/inboxStore";
import { useOrgRoles } from "./useOrgRoles";
import type { OrgProposalAuthor } from "../components/org/orgStaffingTypes";
import { resolveProposalAuthor, type ProposalAuthorView } from "../components/org/staffingModel";

/** The author named from what this window knows. Subscribes to the one
 *  session row's title and short id, never the collection (CLAUDE.md store
 *  rules), and to the roles signature useOrgRoles keeps. */
export function useProposalAuthor(author: OrgProposalAuthor): ProposalAuthorView {
  const sessionId = author.kind === "session" ? author.id : null;
  // The row's short id is read loosely: InboxSession does not type it, the
  // server stamps it (the org page reads it the same way).
  const shortIdOf = (row: unknown) => (row as { short_id?: string } | undefined)?.short_id;
  const s = useTrackedStore([
    (st) => sessionId ? st.sessions[sessionId]?.title : undefined,
    (st) => sessionId ? shortIdOf(st.sessions[sessionId]) : undefined,
  ]);
  // A role is named by the server's enrichment (orgProposals list, get and
  // origin all carry name, handle, short id and avatar), else by the tree's
  // row when this page feeds one. No query of its own: the role brief it used
  // to fall back on computes a whole brief to read four fields.
  const { roles } = useOrgRoles();
  const roleRow = author.kind === "role" ? roles.find((r) => r._id === author.id) : undefined;
  const role = roleRow ? { name: roleRow.name, handle: roleRow.handle, short_id: roleRow.short_id, avatar: (roleRow as { avatar?: string }).avatar } : null;
  const session = sessionId ? s.sessions[sessionId] : undefined;
  return resolveProposalAuthor(author, { session: session ? { title: session.title, short_id: shortIdOf(session) } : null, role });
}
