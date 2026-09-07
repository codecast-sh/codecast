import { describe, expect, test } from "bun:test";
import { resolveSpawnParentId } from "./conversations";

// A fake db that records whether the message-uuid lookup ran and answers it.
function fakeCtx(parentMsg: { conversation_id: string } | null) {
  const calls: string[] = [];
  const ctx = {
    db: {
      query: (table: string) => {
        calls.push(table);
        return { withIndex: () => ({ first: async () => parentMsg }) };
      },
    },
  } as any;
  return { ctx, calls };
}

describe("resolveSpawnParentId", () => {
  test("stored parent wins without a lookup", async () => {
    const { ctx, calls } = fakeCtx({ conversation_id: "other" });
    expect(await resolveSpawnParentId(ctx, { parent_conversation_id: "stored" as any })).toBe("stored");
    expect(calls).toEqual([]);
  });

  test("a subagent that only knows its spawning message resolves through it", async () => {
    const { ctx, calls } = fakeCtx({ conversation_id: "spawner" });
    expect(await resolveSpawnParentId(ctx, { parent_message_uuid: "u1" })).toBe("spawner");
    expect(calls).toEqual(["messages"]);
  });

  test("a fork is not a spawned session: its fork point never resolves to a parent", async () => {
    // Regression: forks carry parent_message_uuid (the fork point), and the
    // lookup used to dress them as subagents — a "Spawned from parent session"
    // banner and the fork point rendered as a message FROM the parent.
    const { ctx, calls } = fakeCtx({ conversation_id: "origin" });
    expect(
      await resolveSpawnParentId(ctx, { parent_message_uuid: "fork-point", forked_from: "origin" as any }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test("nothing to go on resolves to null", async () => {
    const { ctx } = fakeCtx(null);
    expect(await resolveSpawnParentId(ctx, {})).toBeNull();
  });
});
