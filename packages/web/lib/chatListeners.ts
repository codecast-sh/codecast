// Which org roles listen to a chat channel, and which the viewer may point at
// it (docs/architecture/agent-channels.md C1/C4). Pure, shared by the channel
// header (components/chat/ChannelListeners) and its test.

import type { OrgRole, OrgTree } from "../components/org/orgTypes";

/** The viewer's admin grant, mirrored from convex/orgChannels.ts
 *  (`userCanAdminRole`): the role's host, a team admin or owner, or the owner
 *  of a personal workspace. */
export function viewerAdministersRole(tree: OrgTree | null, viewerId: string, role: OrgRole): boolean {
  const me = tree?.people.find((p) => p.is_me) ?? tree?.people.find((p) => p.user_id === viewerId);
  const isAdmin = me?.role === "admin" || me?.role === "owner" || tree?.workspace.kind === "user";
  return isAdmin || role.host_user_id === (me?.user_id ?? viewerId);
}

/** Roles following this channel, and the ones the viewer may point at it.
 *  Retired roles are neither. */
export function channelListeners(tree: OrgTree | null, channelId: string, viewerId: string) {
  const roles = (tree?.roles ?? []).filter((r) => r.status !== "retired");
  return {
    listening: roles.filter((r) => (r.follow_channel_ids ?? []).includes(channelId)),
    mine: roles.filter((r) => viewerAdministersRole(tree, viewerId, r)),
  };
}

// The wake signature for a surface that branches on roles' identity and follow
// lists and the viewer's grant, and on NOTHING else in the tree. org.tree
// re-executes whenever a session in anyone's working set moves (it carries
// each top session's state and updated_at), and the store hands back a new
// tree ref each time; subscribing to the ref would re-render the chat header
// on every heartbeat across the org (CLAUDE.md, wake signatures). Memoized by
// tree ref, so an unchanged tree costs a Map lookup.
const sigCache = new WeakMap<OrgTree, string>();
export function orgRolesListenSig(tree: OrgTree | null | undefined): string {
  if (!tree) return "";
  const hit = sigCache.get(tree);
  if (hit !== undefined) return hit;
  let out = `${tree.workspace.kind}|`;
  for (const p of tree.people) if (p.is_me) out += `me:${p.user_id}:${p.role}|`;
  for (const r of tree.roles) {
    out += `${r._id}|${r.short_id}|${r.handle}|${r.name}|${r.status}|${r.host_user_id}|${(r.follow_channel_ids ?? []).join(",")};`;
  }
  sigCache.set(tree, out);
  return out;
}
