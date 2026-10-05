// The hosted transcript writer under convex-test: a hosted message's thinking
// signature goes to message_thinking (never onto the row clients read) and
// follows the thinking it signs, and its tool calls' raw arguments go to
// message_tool_inputs while the row keeps them redacted, so an approved call
// runs with the arguments the person saw and no client ever reads a secret.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { allModules as modules } from "../testModules.testkit";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { withHostedReplay } from "../hostedReplay";

setDefaultTimeout(60_000);


async function hostedConversation() {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", {}));
  const started = await t.withIdentity({ subject: user }).mutation(api.assistant.entry.startConversation, {});
  const write = (message: Record<string, unknown>) =>
    t.mutation(internal.messages.writeHostedMessages, {
      conversation_id: started.conversation_id as Id<"conversations">,
      messages: [{ role: "assistant", message_uuid: "turn-1", timestamp: Date.now(), ...message } as any],
    });
  const read = () =>
    t.run(async (ctx) => ({
      rows: await ctx.db.query("messages").collect(),
      signatures: await ctx.db.query("message_thinking").collect(),
    }));
  const replay = () => t.run(async (ctx) => withHostedReplay(ctx, await ctx.db.query("messages").collect()));
  return { write, read, replay };
}

describe("writeHostedMessages", () => {
  test("keeps the thinking signature off the row, and clears it when the thinking changes unsigned", async () => {
    const { write, read } = await hostedConversation();
    await write({ thinking: "Check the calendar first.", thinking_signature: "sig-1", content: "Looking." });
    let { rows, signatures } = await read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("thinking_signature");
    expect(signatures).toMatchObject([{ message_id: rows[0]._id, signature: "sig-1" }]);

    await write({ thinking: "Check the inbox instead.", content: "Looking." });
    ({ rows, signatures } = await read());
    expect(rows[0].thinking).toBe("Check the inbox instead.");
    expect(signatures).toEqual([]);
  });

  test("keeps tool call arguments redacted on the row and raw for the turn engine", async () => {
    const { write, read, replay } = await hostedConversation();
    const input = JSON.stringify({ to: "dana@example.com", body: "Your token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });
    await write({ tool_calls: [{ id: "call_s", name: "send_email", input }] });
    const { rows } = await read();
    expect(rows[0].tool_calls?.[0].input).not.toContain("sk-ant-api03");
    const replayed = await replay();
    expect(replayed[0].tool_calls?.[0].input).toBe(input);
  });
});
