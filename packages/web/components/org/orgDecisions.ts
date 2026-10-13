// The decisions an org conversation asked the viewer (org-staffing.md): an
// open item in the viewer's decision queue that came from a role's standing
// session or a session filed under a role. Pure; useNeedsYou.ts feeds it from
// the store.
import type { QueueItem } from "../../lib/decisionQueue";
import type { OrgRole, OrgTree } from "./orgTypes";

/** The largest option set answered in place; more opens the card. */
const IN_PLACE_OPTIONS = 4;

/** Every conversation the org owns, to the role that owns it: each live
 *  role's standing session and the sessions filed under it. */
function orgConversationOwners(tree: OrgTree | null): Map<string, OrgRole> {
  const out = new Map<string, OrgRole>();
  for (const r of tree?.roles ?? []) {
    if (r.status === "retired") continue;
    if (r.standing?.conversation_id) out.set(r.standing.conversation_id, r);
    for (const s of r.sessions) out.set(s._id, r);
  }
  return out;
}

/** The queue items an org conversation asked the viewer, oldest first, each
 *  with its role. A row a role holds under a grant is the role's to clear.
 *  The asking session's own `org_role_id` (the live store row) names its role
 *  too, so a session filed since the tree last listed sessions still counts,
 *  and a roles-only tree (org.roles, fed on every page) is enough. */
export function orgDecisions(tree: OrgTree | null, queue: readonly QueueItem[]): { item: QueueItem; role: OrgRole }[] {
  const owners = orgConversationOwners(tree);
  const live = new Map((tree?.roles ?? []).filter((r) => r.status !== "retired").map((r) => [r._id, r]));
  const out: { item: QueueItem; role: OrgRole }[] = [];
  for (const item of [...queue].sort((a, b) => a.createdAt - b.createdAt)) {
    if (item.heldByRole) continue;
    const filed = item.session?.org_role_id;
    const role = owners.get(item.conversationId) ?? (filed ? live.get(filed) : undefined);
    if (role) out.push({ item, role });
  }
  return out;
}

/** A single-choice `cast decide` with a few options answers in place;
 *  anything else opens its conversation. */
export function canAnswerInPlace(item: QueueItem): boolean {
  const single = !item.kind || item.kind === "single";
  return item.source === "decide" && single && !!item.decisionId && item.options.length > 0 && item.options.length <= IN_PLACE_OPTIONS;
}
