import { describe, expect, test } from "bun:test";
import { CLIENT_SYNC_REGISTRY } from "../clientSyncRegistry";
import { applySyncTable } from "../syncProtocol";

// A priority row joins objects (steps, sessions, links, a teammate's
// mapped_links, plan). A push that changes only one of them must land, or a
// teammate's milestone marks stay as they were when the row first arrived.
describe("priorities sync", () => {
  const opts = (CLIENT_SYNC_REGISTRY.priorities as any).sync;
  const row = (state: string, extra: Record<string, unknown> = {}) => ({
    _id: "p1", short_id: "pri-1", title: "T", status: "active", rank: 1, last_active_at: 1, owner: "Sam", owner_image: null, mine: false,
    steps: [{ key: "s1", title: "One", tier: "critical", refs: [], done: false }], counts: { critical_done: 0, critical_total: 1 }, sessions: [],
    mapped_links: [{ key: "s1", sessions: [{ conversation_id: "c1", state }], sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false }],
    ...extra,
  });

  test("a push that changes only a teammate's mapped_links reaches the cached row", () => {
    const first = applySyncTable("priorities", [row("working") as any], {}, {}, opts).table;
    const second = applySyncTable("priorities", [row("needs_you") as any], {}, first, opts).table;
    expect((second as any).p1.mapped_links[0].sessions[0].state).toBe("needs_you");
  });

  test("a push that changes only the owner's face reaches the cached row", () => {
    const first = applySyncTable("priorities", [row("working") as any], {}, {}, opts).table;
    const second = applySyncTable("priorities", [row("working", { owner_image: "https://faces.test/sam.png" }) as any], {}, first, opts).table;
    expect((second as any).p1.owner_image).toBe("https://faces.test/sam.png");
  });

  test("every object a row joins is a deep field", () => {
    const objects = Object.entries(row("working", { links: [], plan: { short_id: "pl-1", title: "P", done: 0, total: 1, size: 1 } }))
      .filter(([, v]) => v !== null && typeof v === "object").map(([k]) => k).sort();
    expect([...opts.deepFields].sort()).toEqual(expect.arrayContaining(objects));
  });
});
