import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { makeFakeDb } from "../../convex/convex/testDb";
import { performSessionSend, claimPendingMessageForDaemon, markPendingDelivered } from "../../convex/convex/pendingMessages";
import { registerSessionSendCommand } from "./sessionSendCommand";
import { sessionIdFromEnv } from "./sessionIdentity";
import { expandCommandStdinDashes } from "./sendBody";

function setup(env: NodeJS.ProcessEnv, alias = false) {
  const db = makeFakeDb({
    users: [{ _id: "owner" }],
    conversations: [
      { _id: "source", short_id: "jxsrc01", session_id: alias ? "old-thread" : "native-thread", user_id: "owner", is_private: true },
      { _id: "target", short_id: "jxdst01", session_id: "target-thread", user_id: "owner", is_private: true, owner_device_id: "device" },
    ],
    managed_sessions: alias ? [{ _id: "alias", session_id: "native-thread", conversation_id: "source", user_id: "owner" }] : [],
    pending_messages: [],
  });
  const program = new Command();
  registerSessionSendCommand(program, {
    currentSession: () => sessionIdFromEnv(env),
    post: (path, args) => {
      expect(path).toBe("/cli/messages/send");
      return performSessionSend({ db }, "owner" as any, args as { to: string; from?: string; body: string });
    },
    print: () => {},
  });
  return { db, program, run: (...args: string[]) => program.parseAsync(["send", "jxdst01", ...args], { from: "user" }) };
}

describe("sender provenance through CLI, enqueue, claim and acknowledgment", () => {
  for (const alias of [false, true]) {
    test(`native Codex ${alias ? "managed alias" : "thread"} resolves to the sender session`, async () => {
      const { db, program, run } = setup({ CODEX_THREAD_ID: "native-thread" }, alias);
      const body = "Line one\n\nLiteral `code` and $(text).";
      program.hook("preAction", (_, command) => expandCommandStdinDashes(command, () => body + "\n"));
      await run("-");
      const row = db._tables.pending_messages[0];
      expect(row.content).toBe(`<session-message from="jxsrc01">\n${body}\n</session-message>`);
      expect(row.from_user_id).toBe("owner");
      const claimed = await claimPendingMessageForDaemon({ db }, row._id, "owner" as any, "device");
      expect(claimed).not.toBeNull();
      await markPendingDelivered({ db } as any, await db.get(row._id));
      expect((await db.get(row._id)).status).toBe("delivered");
      expect((await db.get(row._id)).content).toBe(row.content);
    });
  }

  test("missing identity cannot create a pending row; an explicit sender repairs the detached path", async () => {
    const { db, run } = setup({});
    await expect(run("update")).rejects.toThrow("Nothing was sent");
    expect(db._tables.pending_messages).toEqual([]);
    await run("update", "--from", "jxsrc01");
    expect(db._tables.pending_messages[0].content).toContain('<session-message from="jxsrc01">');
  });

  test("a native identity unknown to the server cannot enqueue an unknown sender", async () => {
    const { db, run } = setup({ CODEX_THREAD_ID: "unregistered-native-thread" });
    await expect(run("update")).rejects.toThrow(/not found/);
    expect(db._tables.pending_messages).toEqual([]);
  });
});
