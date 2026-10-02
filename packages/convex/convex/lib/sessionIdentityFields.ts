import { avatarOf } from "@codecast/shared/contracts/orgAvatars";

/**
 * The identity a row resolves to (docs/architecture/session-characters.md
 * S1): its chosen character parts, its org pointers, and for a role's rows a
 * snapshot of the role so the web can draw the role's face and name without
 * loading the org tree. Only rows with a pointer pay the extra read. Every
 * payload that names a session (an inbox row, a comment's author) spreads
 * this, so the same session wears the same face everywhere.
 */
export async function identityFieldsOf(conv: any, getDoc: (id: any) => Promise<any>) {
  const roleId = conv.standing_role_id ?? conv.org_role_id ?? null;
  const role = roleId ? await getDoc(roleId).catch(() => null) : null;
  return {
    character_avatar: conv.character_avatar ?? null,
    character_name: conv.character_name ?? null,
    org_role_id: conv.org_role_id?.toString() ?? null,
    standing_role_id: conv.standing_role_id?.toString() ?? null,
    role: role
      ? { _id: role._id.toString(), short_id: role.short_id, name: role.name, handle: role.handle, avatar: avatarOf(role), status: role.status, tenure_kind: role.tenure?.kind ?? "standing" }
      : null,
  };
}
