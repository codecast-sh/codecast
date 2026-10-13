// Resolve a `cast org` target reference against the org tree the server
// returned: a role by short id (or-N), id, or @handle; else a person by id,
// name, or "me". The server validators want real ids, so a short id must
// resolve here rather than travel on the wire.
export type OrgTarget = { kind: "user"; user_id: string } | { kind: "role"; role_id: string };

export function matchOrgTarget(
  tree: { roles?: Array<{ _id: string; short_id?: string; handle?: string }>; people?: Array<{ user_id: string; name?: string; is_me?: boolean }> } | null,
  ref: string,
): OrgTarget | null {
  const handle = ref.replace(/^@/, "").toLowerCase();
  const role = (tree?.roles ?? []).find((r) => r._id === ref || r.short_id === ref || r.handle === handle);
  if (role) return { kind: "role", role_id: role._id };
  const needle = ref.toLowerCase();
  const person = (tree?.people ?? []).find((p) => p.user_id === ref || (p.name || "").toLowerCase() === needle || (needle === "me" && p.is_me));
  return person ? { kind: "user", user_id: person.user_id } : null;
}
