import { describe, expect, test } from "bun:test";
import { addMessage, addMessages, deriveActivity } from "./messages";
import { makeFakeDb } from "./testDb";

// The activity line is stamped at message ingest from the newest assistant
// tool call in a batch (addMessage / addMessages, the same transaction as
// recent_files). These pin what the ingest writes and, as importantly, when
// it leaves the row alone.

const NOW = 1_700_000_000_000;
const call = (name: string, input: unknown) => ({ id: "t1", name, input: JSON.stringify(input) });
const assistant = (timestamp: number, ...tool_calls: Array<ReturnType<typeof call>>) => ({ role: "assistant", timestamp, tool_calls });
const user = (timestamp: number) => ({ role: "user", timestamp, content: "hi" });

describe("deriveActivity", () => {
  test("stamps the newest assistant tool call of the batch, present tense, subject first", () => {
    const next = deriveActivity(
      [assistant(NOW - 5000, call("Read", { file_path: "/Users/me/src/app/daemon.ts" })), user(NOW - 4000), assistant(NOW - 1000, call("Edit", { file_path: "/Users/me/src/app/chat.ts" }))],
      undefined,
      NOW,
    );
    expect(next).toEqual({ text: "editing app/chat.ts", tool: "Edit", at: NOW - 1000 });
  });

  test("the last call of a multi call message wins", () => {
    const next = deriveActivity(
      [assistant(NOW, call("Read", { file_path: "/x/a.ts" }), call("Bash", { command: "cd repo && npx tsc --noEmit" }))],
      undefined,
      NOW,
    );
    expect(next).toEqual({ text: "running npx tsc", tool: "Bash", at: NOW });
  });

  test("a batch with no tool call leaves the field untouched", () => {
    expect(deriveActivity([user(NOW), { role: "assistant", timestamp: NOW, content: "done" } as any], { text: "editing a.ts", tool: "Edit", at: NOW - 10 }, NOW)).toBeNull();
    expect(deriveActivity([], undefined, NOW)).toBeNull();
  });

  test("a call with no phrase leaves the field untouched", () => {
    expect(deriveActivity([assistant(NOW, { id: "t", name: "Bash", input: "{bad" })], undefined, NOW)).toBeNull();
  });

  test("an older batch never overwrites a fresher stamp (historical backfill after live traffic)", () => {
    const live = { text: "running bun test", tool: "Bash", at: NOW };
    expect(deriveActivity([assistant(NOW - 60_000, call("Read", { file_path: "/x/old.ts" }))], live, NOW)).toBeNull();
  });

  test("the same stamp again is a no-op (re-sync of the same rows)", () => {
    const same = { text: "reading x/a.ts", tool: "Read", at: NOW };
    expect(deriveActivity([assistant(NOW, call("Read", { file_path: "/x/a.ts" }))], same, NOW)).toBeNull();
  });

  test("a message without a timestamp stamps the ingest clock", () => {
    const next = deriveActivity([{ role: "assistant", tool_calls: [call("Grep", { pattern: "wakeSig" })] }], undefined, NOW);
    expect(next).toEqual({ text: "searching for wakeSig", tool: "Grep", at: NOW });
  });

  test("newlines never reach the row and secrets in a command are scrubbed", () => {
    const heredoc = deriveActivity([assistant(NOW, call("Bash", { command: "cat > /tmp/x <<'EOF'\nline\nEOF" }))], undefined, NOW);
    expect(heredoc?.text).toBe("running cat");
    expect(heredoc?.text).not.toMatch(/\n/);
    // A shell subject is the program and its subcommand, never the argv, so a
    // token on the command line cannot leak through the phrase.
    const leaky = deriveActivity([assistant(NOW, call("Bash", { command: "curl -H 'Authorization: Bearer abc123def456ghi789jkl012' https://api.example.com" }))], undefined, NOW);
    expect(leaky?.text).toBe("running curl");
    // A subject that carries a secret verbatim (a grep for a key) is redacted.
    const grep = deriveActivity([assistant(NOW, call("Grep", { pattern: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }))], undefined, NOW);
    expect(grep?.text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(grep?.text).toMatch(/^searching for /);
  });

  test("the text is capped", () => {
    const long = deriveActivity([assistant(NOW, call("WebSearch", { query: "x".repeat(300) }))], undefined, NOW);
    expect(long!.text.length).toBeLessThanOrEqual(80);
  });
});

// The ingest endpoints themselves, driven with the in-memory db (the
// messages.fileChanges.test.ts pattern): the stamp lands on the conversation
// row in the same write as the message, on both the single and the batch path.
describe("message ingest stamps conversations.activity", () => {
  function setup() {
    const db = makeFakeDb({
      conversations: [{ _id: "conversation", user_id: "owner", is_private: true }],
      messages: [],
      file_changes: [],
    });
    return { db, auth: { getUserIdentity: async () => ({ subject: "owner|session" }) }, scheduler: { runAfter: async () => {} } } as any;
  }
  const conv = (ctx: any) => ctx.db._tables.conversations[0];

  test("addMessages stamps the newest tool call of the batch", async () => {
    const ctx = setup();
    await (addMessages as any)._handler(ctx, {
      conversation_id: "conversation",
      messages: [
        { message_uuid: "m1", role: "assistant", timestamp: NOW - 2000, tool_calls: [call("Read", { file_path: "/x/a.ts" })] },
        { message_uuid: "m2", role: "assistant", timestamp: NOW - 1000, tool_calls: [call("Bash", { command: "cd repo && npx tsc --noEmit" })] },
      ],
    });
    expect(conv(ctx).activity).toEqual({ text: "running npx tsc", tool: "Bash", at: NOW - 1000 });
  });

  test("addMessage stamps a single tool call message and a plain reply leaves the stamp alone", async () => {
    const ctx = setup();
    await (addMessage as any)._handler(ctx, {
      conversation_id: "conversation", message_uuid: "m1", role: "assistant", timestamp: NOW,
      tool_calls: [call("Edit", { file_path: "/Users/me/src/app/chat.ts" })],
    });
    expect(conv(ctx).activity).toEqual({ text: "editing app/chat.ts", tool: "Edit", at: NOW });
    await (addMessage as any)._handler(ctx, {
      conversation_id: "conversation", message_uuid: "m2", role: "assistant", timestamp: NOW + 1000, content: "done",
    });
    expect(conv(ctx).activity).toEqual({ text: "editing app/chat.ts", tool: "Edit", at: NOW });
  });
});
