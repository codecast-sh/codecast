// What a permission prompt card says, shared by web's card
// (components/PermissionCard) and the phone's (mobile components/PermissionCard),
// so the two renderers cannot drift. Each draws it in its own palette.

/** The card's copy. */
export const PERMISSION_CARD_COPY = {
  approve: "Approve",
  deny: "Deny",
  argsMaxLines: 3,
} as const;

/** Who is asking, as the card's tags: a subagent (by type) rather than the
 *  session's own agent, and Claude Code's built-in safety check, which still
 *  asks in bypass mode (an rm whose target it cannot resolve). */
export function permissionSourceTags(p: { subagent_type?: string; safety_check?: boolean }): { kind: "subagent" | "safety"; label: string }[] {
  const tags: { kind: "subagent" | "safety"; label: string }[] = [];
  if (p.subagent_type) tags.push({ kind: "subagent", label: p.subagent_type === "subagent" ? "subagent" : `${p.subagent_type} subagent` });
  if (p.safety_check) tags.push({ kind: "safety", label: "Claude Code safety check" });
  return tags;
}

/** One rm target on a card, as removalPreview resolved it. */
export type PermissionRemoval = { target: string; files?: number; dirs?: number; note?: string };

/** What an rm target would delete, at a glance: "79 files", "2 files · 3
 *  folders", "nothing there", or why it could not be counted. */
export function removalCountLabel(r: PermissionRemoval): string {
  if (r.note) return r.note;
  const parts: string[] = [];
  if (r.files) parts.push(`${r.files.toLocaleString("en-US")} file${r.files === 1 ? "" : "s"}`);
  if (r.dirs) parts.push(`${r.dirs.toLocaleString("en-US")} folder${r.dirs === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "nothing there";
}
