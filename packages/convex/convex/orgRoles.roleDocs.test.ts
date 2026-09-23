import { describe, expect, test } from "bun:test";
import { afterRoleDocWrite } from "./orgRoles";

// One after-write hook for a role's documents, whichever path saved them
// (docs.update, the collab editor's snapshot, cast brief edit): a brief
// mirrors its first line into the standing session's state, a charter wakes
// the role. The fake db holds one role with both docs, its anchor and the
// standing conversation, and records every write.

function fakeCtx() {
  const role = { _id: "role1", team_id: "team1", status: "active", anchor_id: "anchor1", brief_doc_id: "brief1", charter_doc_id: "charter1", name: "Infra lead", handle: "infra" };
  const anchor = { _id: "anchor1", conversation_id: "conv1" };
  const conv = { _id: "conv1", user_id: "u1", standing_role_id: "role1", thread_state: null };
  const rows: Record<string, any> = { role1: role, anchor1: anchor, conv1: conv, team1: { _id: "team1", features: { org: true } } };
  const patches: Array<{ id: string; patch: any }> = [];
  const inserts: Array<{ table: string; row: any }> = [];
  const scheduled: any[] = [];
  const query = (table: string) => ({
    withIndex: () => ({
      collect: async () => (table === "org_roles" ? [role] : []),
      order: () => ({ first: async () => null, take: async () => [] }),
      first: async () => null,
      take: async () => [],
    }),
  });
  const ctx = {
    db: {
      get: async (id: string) => rows[id] ?? null,
      patch: async (id: string, patch: any) => { patches.push({ id, patch }); Object.assign(rows[id], patch); },
      insert: async (table: string, row: any) => { inserts.push({ table, row }); return `${table}-${inserts.length}`; },
      query,
    },
    scheduler: { runAfter: async (...args: any[]) => { scheduled.push(args); }, runAt: async (...args: any[]) => { scheduled.push(args); } },
  };
  return { ctx, patches, inserts, scheduled, conv };
}

describe("afterRoleDocWrite", () => {
  test("a brief's first line lands on the standing session's state", async () => {
    const { ctx, patches } = fakeCtx();
    await afterRoleDocWrite(ctx, { _id: "brief1", doc_type: "brief", team_id: "team1" }, "Infra lead standing by\nStatus: dormant waiting on CI\nNext: read the frame\n\nMore prose.");
    const conv = patches.find((p) => p.id === "conv1");
    expect(conv).toBeDefined();
    expect(String(conv!.patch.thread_state)).toMatch(/^Infra lead standing by/);
    expect(String(conv!.patch.thread_state)).toContain("Next: read the frame");
    expect(String(conv!.patch.thread_state)).not.toContain("More prose");
    expect(conv!.patch.thread_state_status).toBe("dormant");
  });

  test("a charter edit queues an immediate wake for its role", async () => {
    const { ctx, inserts, patches } = fakeCtx();
    await afterRoleDocWrite(ctx, { _id: "charter1", doc_type: "charter", team_id: "team1" }, "# Charter\nnew rules");
    const wake = inserts.find((i) => i.table === "role_wake_outbox");
    expect(wake).toBeDefined();
    expect(wake!.row.role_id).toBe("role1");
    expect(wake!.row.kind).toBe("immediate");
    expect(patches.find((p) => p.id === "conv1")).toBeUndefined();
  });

  test("any other document is left alone", async () => {
    const { ctx, inserts, patches } = fakeCtx();
    await afterRoleDocWrite(ctx, { _id: "note1", doc_type: "note", team_id: "team1" }, "hello");
    expect(inserts).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });
});
