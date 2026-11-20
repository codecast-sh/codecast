// A role's charter is its doc's text (lib/roleCharter): what a test reads and
// sets on a role goes through the doc, never a field on the row.

/** The role's charter text, or undefined when it has no charter doc. */
export async function charterText(db: any, roleOrId: any): Promise<string | undefined> {
  const role = typeof roleOrId === "string" ? await db.get(roleOrId) : roleOrId;
  const doc = role?.charter_doc_id ? await db.get(role.charter_doc_id) : null;
  return doc ? doc.content : undefined;
}

/** Set the role's charter text, making its doc when it has none. */
export async function giveCharter(db: any, roleId: string, content: string): Promise<void> {
  const role = await db.get(roleId);
  if (role.charter_doc_id) { await db.patch(role.charter_doc_id, { content }); return; }
  const docId = await db.insert("docs", { user_id: role.host_user_id, team_id: role.team_id, title: `Charter: ${role.name}`, content, doc_type: "charter", source: "human", created_at: 1, updated_at: 1 });
  await db.patch(roleId, { charter_doc_id: docId });
}
