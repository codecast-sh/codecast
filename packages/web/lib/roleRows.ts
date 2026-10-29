// Where a face reads a role from (lib/sessionIdentity RoleRows): the role's
// face and name fields from `viewerRoles` (roleIcons.viewerRoles, every role
// the viewer can see across their personal workspace and teams), and which
// bot user sits in which role from the seats the store holds (the anchors
// collection, every workspace; the org tree's seats, the active one). The org
// tree is the org page's structure; its roles stand in only while viewerRoles
// is empty (a cold cache). Pure over the state, so the store, a replica and a
// test build the same rows.
import type { RoleIcon } from "@codecast/shared/contracts/roleIcon";
import { roleIconSig, type RoleRows } from "./sessionIdentity";

type ViewerRoleRow = RoleRows["roles"][number];

/** An open role edit (store/orgSlice roleFields intent): its face fields
 *  show on every face until the server echoes them or refuses. */
type RoleFieldsIntent = { kind: string; role_id?: string; fields?: { name?: string; avatar?: string } };

type RoleRowsSource = {
  viewerRoles?: Record<string, ViewerRoleRow> | null;
  orgIntents?: readonly RoleFieldsIntent[] | null;
  orgTree?: { roles?: readonly ViewerRoleRow[]; anchors: readonly { bot_user_id: string; org_role_id?: string | null }[] } | null;
  anchors?: Record<string, { bot_user_id?: string | null; status?: string; role?: { _id: string } | null }> | null;
};

let memo: { roles: unknown; anchors: unknown; tree: unknown; intents: unknown; rows: RoleRows } | null = null;

/** The role rows, rebuilt only when one of the sources changes ref. */
export function roleRowsOf(s: RoleRowsSource): RoleRows {
  const treeAnchors = s.orgTree?.anchors;
  if (memo && memo.roles === s.viewerRoles && memo.anchors === s.anchors && memo.tree === s.orgTree && memo.intents === s.orgIntents) return memo.rows;
  const seats: { bot_user_id: string; org_role_id: string }[] = [];
  for (const a of treeAnchors ?? []) if (a.org_role_id) seats.push({ bot_user_id: a.bot_user_id, org_role_id: a.org_role_id });
  for (const id in s.anchors ?? {}) {
    const a = s.anchors![id];
    if (a?.bot_user_id && a.role?._id && a.status !== "decommissioned") seats.push({ bot_user_id: String(a.bot_user_id), org_role_id: String(a.role._id) });
  }
  // A cold cache (viewerRoles not yet fed, or its query failed) reads the
  // active workspace's tree instead, so a first load is no worse than before
  // the home existed. Only while the home is empty: never merged into it.
  const home = Object.values(s.viewerRoles ?? {});
  const rows: RoleRows = { roles: withOpenEdits(home.length ? home : s.orgTree?.roles ?? [], s.orgIntents), anchors: seats };
  memo = { roles: s.viewerRoles, anchors: s.anchors, tree: s.orgTree, intents: s.orgIntents, rows };
  return rows;
}

/** The rows with each open role edit's name and face laid over its row, so
 *  a rename or a new face paints at once; the intent journal (orgSlice) is
 *  what holds it over a stale push and drops it on the echo or a refusal. */
function withOpenEdits(roles: readonly ViewerRoleRow[], intents: readonly RoleFieldsIntent[] | null | undefined): readonly ViewerRoleRow[] {
  const edits = (intents ?? []).filter((i) => i.kind === "roleFields" && (i.fields?.name !== undefined || i.fields?.avatar !== undefined));
  if (edits.length === 0) return roles;
  return roles.map((r) => {
    let out = r;
    for (const i of edits) {
      if (i.role_id !== r._id) continue;
      out = { ...out, ...(i.fields!.name !== undefined ? { name: i.fields!.name } : {}), ...(i.fields!.avatar !== undefined ? { avatar: i.fields!.avatar } : {}) };
    }
    return out;
  });
}

/** A wake signature of what a face reads from the role rows: each role's face
 *  and name fields and each seat. Changes on a rename, a new face or icon, or
 *  a reseat; never on a heartbeat. */
let sigMemo: { rows: RoleRows; sig: string } | null = null;
export function roleRowsSig(s: RoleRowsSource): string {
  const rows = roleRowsOf(s);
  if (sigMemo?.rows === rows) return sigMemo.sig;
  let sig = "";
  for (const r of rows.roles) sig += `${r._id}|${r.short_id}|${r.handle}|${r.name}|${r.given_name ?? ""}|${r.avatar ?? ""}|${r.status}|${roleIconSig(r.icon as RoleIcon | null | undefined)}\n`;
  for (const a of rows.anchors) sig += `@${a.bot_user_id}:${a.org_role_id ?? ""}\n`;
  // A digest, never the text: a subscription compares it on every write.
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h * 33) ^ sig.charCodeAt(i)) >>> 0;
  sigMemo = { rows, sig: `${rows.roles.length}:${h.toString(36)}` };
  return sigMemo.sig;
}
