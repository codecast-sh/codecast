/**
 * The mobile permission card's look, as plain values: the React Native card
 * (mobile/components/PermissionCard.tsx) feeds it to StyleSheet.create. Keys
 * are limited to ones React Native and React DOM share, so padding is spelled
 * per side and numbers are pixels, and a web renderer can spread it into
 * inline styles. `fontFamily` names the RN face.
 */
export const PERMISSION_CARD_STYLE = {
  container: {
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "rgba(251, 191, 36, 0.5)",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "rgba(251, 191, 36, 0.1)",
    marginBottom: 12,
  },
  content: {
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fbbf24",
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: "#e0e0e0",
  },
  toolName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fbbf24",
    fontFamily: "JetBrainsMono",
    marginBottom: 4,
  },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  subagentTag: {
    fontSize: 11,
    color: "#a78bfa",
    marginBottom: 4,
  },
  safetyTag: {
    fontSize: 11,
    color: "#fb923c",
    marginBottom: 4,
  },
  intent: {
    fontSize: 13,
    color: "#e0e0e0",
    marginBottom: 4,
  },
  removal: {
    fontSize: 11,
    color: "#e0e0e0",
    fontFamily: "JetBrainsMono",
    marginBottom: 2,
  },
  removalVerb: {
    color: "#ff6b6b",
  },
  removalCount: {
    color: "#ff6b6b",
  },
  removalNote: {
    color: "#999",
    fontStyle: "italic",
  },
  argsContainer: {
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 4,
    padding: 8,
    marginTop: 8,
  },
  argsText: {
    fontSize: 11,
    color: "#999",
    fontFamily: "JetBrainsMono",
  },
  buttonContainer: {
    flexDirection: "row",
    gap: 8,
  },
  button: {
    flex: 1,
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: 16,
    paddingRight: 16,
    borderRadius: 6,
    alignItems: "center",
  },
  approveButton: {
    backgroundColor: "#4ade80",
  },
  approveButtonText: {
    color: "#0d1117",
    fontSize: 14,
    fontWeight: "600",
  },
  denyButton: {
    backgroundColor: "#ff6b6b",
  },
  denyButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
} as const;

/** The card's copy, shared so the two renderers cannot drift. */
export const PERMISSION_CARD_COPY = {
  title: "Permission Required",
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
