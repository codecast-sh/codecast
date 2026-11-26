import { countStates, type OrgTree } from "../components/org/orgTypes";

/** A roles-only payload (org.roles) carries the org without anything a
 *  session touches: members as identity only (no presence, no sessions), no
 *  per role counts or sessions, no live state on a standing session or an
 *  anchor. Both org.roles and org.tree feed this
 *  one slot, so fill those fields from the tree already held for the same
 *  workspace, matched by id; a surface that draws them mounts org.tree, which
 *  replaces them on its next push. With no tree for this workspace they start
 *  empty, which is what a roles-only surface reads anyway. */
export function fillRolesOnlyTree(incoming: any, current: OrgTree | null | undefined): OrgTree {
  const { roles_only: _r, ...rest } = incoming;
  const held = current && current.workspace?.id === incoming.workspace?.id ? current : null;
  const heldRole = new Map((held?.roles ?? []).map((r) => [r._id, r]));
  const heldAnchor = new Map((held?.anchors ?? []).map((a) => [String(a.anchor_id), a]));
  const heldPerson = new Map((held?.people ?? []).map((p) => [String(p.user_id), p]));
  return {
    ...rest,
    people: (rest.people ?? []).map((person: any) => {
      const was = heldPerson.get(String(person.user_id));
      return { ...person, presence: was?.presence ?? "offline", counts: was?.counts ?? countStates([]), sessions: was?.sessions ?? [], total: was?.total ?? 0 };
    }),
    truncated: held?.truncated,
    roles: rest.roles.map((role: any) => {
      const was = heldRole.get(role._id);
      const standing = role.standing
        ? (was?.standing && was.standing.conversation_id === role.standing.conversation_id ? was.standing : role.standing)
        : null;
      return { ...role, counts: was?.counts ?? countStates([]), sessions: was?.sessions ?? [], total: was?.total ?? 0, standing };
    }),
    anchors: rest.anchors.map((anchor: any) => {
      const was = heldAnchor.get(String(anchor.anchor_id));
      if (!was || was.conversation_id !== anchor.conversation_id) return anchor;
      return { ...anchor, short_id: was.short_id, state: was.state, state_line: was.state_line, state_status: was.state_status, state_at: was.state_at };
    }),
  } as OrgTree;
}
