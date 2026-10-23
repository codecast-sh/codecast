// /cli/spawn lost write races at volume (2026-10-23: 34 of ~850 spawns): every
// station's transcript sync patched its role's token counter, and every start
// on a cloud host read every conversation the host ran. These pin the two
// reads and writes that were in the way.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { rollUpUsage } from "./messages";
import { roleTokensToday } from "./lib/orgCaps";
import { findSharedCheckoutOccupant } from "./cloudPlacement";

const NOW = Date.now();
const ROLE = "org_roles_q";

describe("a session's tokens", () => {
  test("land on the session's own row for the day and never write the role", async () => {
    const role = { _id: ROLE, handle: "q", counters: { day: new Date(NOW).toISOString().slice(0, 10), hands: 3, wakes: 1, tokens: 0 } };
    const conv = (id: string) => ({ _id: id, user_id: "users_u", org_role_id: ROLE, _creationTime: NOW - 1000 });
    const db = makeFakeDb({ org_roles: [role], org_role_tokens: [], usage_pending: [], conversations: [conv("conversations_a"), conv("conversations_b")] });
    const ctx = { db, scheduler: { runAfter: async () => {} } } as any;
    const turn = (id: string, input: number, output: number) => ({ usage: { input_tokens: input, output_tokens: output }, api_message_id: id, inserted: true, timestamp: NOW });
    await rollUpUsage(ctx, conv("conversations_a"), [turn("m1", 100, 10)], {}, NOW);
    await rollUpUsage(ctx, { ...conv("conversations_a"), usage_totals: { input: 100, output: 10, cache_read: 0, cache_write: 0, updated_at: NOW, last_api_message_id: "m1" } }, [turn("m2", 50, 5)], {}, NOW);
    await rollUpUsage(ctx, conv("conversations_b"), [turn("m3", 7, 3)], {}, NOW);
    const rows = (db as any)._tables.org_role_tokens;
    expect(rows.map((r: any) => [r.conversation_id, r.tokens]).sort()).toEqual([["conversations_a", 165], ["conversations_b", 10]]);
    expect(await roleTokensToday(ctx, ROLE, NOW)).toBe(175);
    expect((db as any)._tables.org_roles[0]).toEqual(role);
  });
});

describe("a start on a host", () => {
  test("reads only the host's shared rows when it merges, and still finds the shared occupant", async () => {
    const row = (id: string, over: Record<string, any> = {}) => ({ _id: id, user_id: "users_u", owner_device_id: "host", status: "active", project_path: "/home/u/repo", ...over });
    const db = makeFakeDb({ conversations: [row("conversations_station1"), row("conversations_station2"), row("conversations_shared", { cloud_workspace: "shared", cloud_checkout_path: "/home/u/repo" })] });
    const indexes: string[] = [];
    const query = db.query.bind(db);
    (db as any).query = (table: string) => {
      const q = query(table);
      const withIndex = q.withIndex.bind(q);
      q.withIndex = (name: string, f: any) => { indexes.push(name); return withIndex(name, f); };
      return q;
    };
    const occupant = await findSharedCheckoutOccupant({ db } as any, "users_u" as any, "host", { projectPath: "/home/u/repo", merging: true });
    expect(occupant?.conversation_id).toBe("conversations_shared");
    expect(indexes).toEqual(["by_owner_device_workspace"]);
    // Without merging, a plain row in the same folder still counts, so every row is read.
    const plain = await findSharedCheckoutOccupant({ db } as any, "users_u" as any, "host", { projectPath: "/home/u/repo", excludeId: "conversations_shared" });
    expect(plain?.conversation_id).toBe("conversations_station1");
    expect(indexes.at(-1)).toBe("by_owner_device");
  });
});
