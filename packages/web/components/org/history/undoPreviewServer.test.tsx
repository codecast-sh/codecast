// The undo preview's "Removes owners …" line, drawn from the server's own
// answer: a role with live hands is retired, its release batch gives each hand
// a person, and planUndo's preview (what orgChanges.previewUndo returns) is
// handed to OrgUndoPreviewCard with the entry orgChanges.get returns, as the
// page would hand them.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { makeFakeDb } from "@codecast/convex/convex/testDb";
import { giveReleasedRuns, performCreateRole, performProvisionRole, performRetireRole } from "@codecast/convex/convex/orgRoles";
import { getEntry, planUndo } from "@codecast/convex/convex/orgChanges";
import { OrgUndoPreviewCard } from "./OrgHistoryView";

const ME = "u".repeat(31) + "m";
const POOL = "u".repeat(31) + "b";
const TEAM = "teams_acme" as any;
const NOW = Date.now();
const session = (id: string, over: Record<string, any> = {}) => ({
  _id: id, user_id: ME, session_id: `s-${id}`, short_id: `jx${id}`.slice(0, 7), status: "active", agent_type: "claude_code",
  updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo", ...over,
});

async function retiredWithHands(live: number) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Mia Park", email: "mia@x.ai" }, { _id: POOL, name: "Pool box", is_bot: true }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m3", user_id: POOL, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], org_role_history: [], org_changes: [], org_proposals: [], org_proposal_changes: [],
    anchors: [], anchor_channels: [], session_commands: [], agent_tasks: [], pending_messages: [], managed_sessions: [],
    session_owners: [], messages: [], user_presence: [], devices: [], docs: [], projects: [], plans: [], tasks: [],
    session_decisions: [], decision_inbox: [], decision_grants: [],
    conversations: [session("seat")],
  };
  const db = makeFakeDb(tables);
  const scheduled: any[] = [];
  const ctx: any = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { scheduled.push(args); } } };
  const role = await performCreateRole(ctx, ME as any, { name: "Growth lead", handle: "growth", team_id: TEAM });
  await performProvisionRole(ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "seat" });
  for (let i = 0; i < live; i++) tables.conversations.push(session(`live${i}`, { user_id: POOL, org_role_id: role._id, role_started: true }));
  await performRetireRole(ctx, ME as any, { role_id: String(role._id), handoff: "skip" });
  for (const batch of scheduled.filter((a) => a?.conversation_ids)) await (giveReleasedRuns as any)._handler(ctx, batch);
  const retire = tables.org_changes.find((r: any) => r.kind === "retire");
  const { preview } = await planUndo(ctx, ME as any, String(retire.batch));
  const nameOf = (id: string) => tables.users.find((u) => u._id === id)?.name ?? "a teammate";
  const { entry } = await getEntry(ctx, ME as any, String(retire.batch));
  return { preview, nameOf, entry };
}

const releasedLine = (html: string) => html.match(/data-undo-released[^>]*>([^<]*)</)?.[1] ?? null;

describe("a retire's undo preview, from the server", () => {
  test("names the person its release gave the live hands, past the first batch", async () => {
    const { preview, nameOf, entry } = await retiredWithHands(101);
    expect(preview.refused).toBeUndefined();
    expect(preview.released_owners).toHaveLength(101);
    const html = renderToStaticMarkup(<OrgUndoPreviewCard entry={entry as any} redo={false} preview={preview} nameOf={nameOf} onConfirm={() => {}} onCancel={() => {}} />);
    expect(releasedLine(html)).toBe("Removes owner Mia Park from 101 hands.");
  });
});
