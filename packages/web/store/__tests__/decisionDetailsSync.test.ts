import { describe, expect, test } from "bun:test";
import { CLIENT_SYNC_REGISTRY } from "../clientSyncRegistry";
import { applySyncTable } from "../syncProtocol";

// The decision page's detail row is all objects under one id. A push that
// moves only nested facts (who holds it, who was asked) must land, or the page
// keeps saying it waits on whoever held it when the page was first opened.
describe("decisionDetails sync", () => {
  const opts = (CLIENT_SYNC_REGISTRY.decisionDetails as any).sync;
  const row = (holder: string) => ({
    _id: "d1",
    decision: { _id: "d1", status: "pending", holder: { kind: "user", id: holder }, asked_user_ids: [holder] },
    doc: null,
    task: null,
    stack: null,
    ladder: [],
    asked_users: [{ _id: holder, name: holder }],
    holder_role: null,
    grant_offer: null,
    grant: null,
  });

  test("an escalation that moves the holder reaches the cached row", () => {
    const prev = { d1: row("tess") as any };
    const { table } = applySyncTable("decisionDetails", [row("ashot") as any], {}, prev, opts);
    expect(table.d1.decision.holder.id).toBe("ashot");
    expect(table.d1.asked_users[0]._id).toBe("ashot");
  });

  test("an unchanged push keeps the row's identity", () => {
    const prev = { d1: row("tess") as any };
    const { table } = applySyncTable("decisionDetails", [row("tess") as any], {}, prev, opts);
    expect(table.d1).toBe(prev.d1);
  });
});
