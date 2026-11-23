// A message a person types at the terminal reaches the server only through
// message sync, never through a codecast send. A pin it was written after
// answers that pin, so it comes down the way a send takes it down. A pin
// written after the message is the agent's answer to it and stands: the
// daemon can sync the person's message after the agent already pinned.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { PIN_TURN_SLACK_MS, rowPinPredatesTurn } from "@codecast/shared/contracts";

setDefaultTimeout(120_000);

const PINNED_AT = 1_000;

async function setup() {
  const t = convexTest(schema, allModules);
  const { user, conversation } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ada", email: "ada@line.dev" } as any);
    const conversation = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: crypto.randomUUID(), owner_device_id: "laptop",
      started_at: 1, updated_at: 1, message_count: 4, status: "active", skip_title_generation: true,
      thread_state: "Waiting on the nightly", thread_state_at: PINNED_AT, thread_state_msg_count: 4, thread_state_status: "dormant",
    } as any);
    return { user, conversation };
  });
  const as = t.withIdentity({ subject: `${user}|session` });
  const row = () => t.run(async (ctx) => ctx.db.get(conversation as Id<"conversations">));
  return { as, conversation, row };
}

describe("a person's terminal turn and the pin", () => {
  test("a turn typed after the pin takes it down (one message)", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessage, { conversation_id: conversation, role: "user", content: "why is this still failing?", timestamp: PINNED_AT + 60_000 });
    const r = await row();
    expect(r?.last_turn_origin).toBe("person");
    expect([r?.thread_state, r?.thread_state_at, r?.thread_state_msg_count, r?.thread_state_status]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("a turn typed after the pin takes it down (batch)", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessages, {
      conversation_id: conversation,
      messages: [
        { role: "user", content: "why is this still failing?", timestamp: PINNED_AT + 60_000 },
        { role: "assistant", content: "Do you want me to rerun it?", timestamp: PINNED_AT + 9_000 },
      ],
    });
    expect((await row())?.thread_state_status).toBeUndefined();
  });

  test("a person's message older than the pin leaves it standing, in either path", async () => {
    const single = await setup();
    await single.as.mutation(api.messages.addMessage, { conversation_id: single.conversation, role: "user", content: "yes, start a fix session", timestamp: PINNED_AT - 5_000 });
    expect(await single.row()).toMatchObject({ last_turn_origin: "person", thread_state_status: "dormant", thread_state_at: PINNED_AT });

    const batch = await setup();
    await batch.as.mutation(api.messages.addMessages, {
      conversation_id: batch.conversation,
      messages: [
        { role: "user", content: "yes, start a fix session", timestamp: PINNED_AT - 5_000 },
        { role: "assistant", content: "Started it.", timestamp: PINNED_AT - 1_000 },
      ],
    });
    expect(await batch.row()).toMatchObject({ thread_state_status: "dormant", thread_state_at: PINNED_AT });
  });

  test("a machine-delivered turn after the pin leaves it standing", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessage, {
      conversation_id: conversation, role: "user",
      content: '<session-message from="jx7abcd">CI is green</session-message>', timestamp: PINNED_AT + 60_000,
    });
    expect(await row()).toMatchObject({ last_turn_origin: "machine", thread_state_status: "dormant", last_turn_at: PINNED_AT + 60_000 });
    // The pin stands, but it is older than the turn: the inbox does not park on it.
    expect(rowPinPredatesTurn((await row()) as any)).toBe(true);
  });

  // A bare nudge, a slash command or an interrupt opens no turn for words or
  // origin (turnOpener), but the agent works again after it, so it moves the
  // turn stamp and, typed by a person after the pin, takes the pin down.
  test.each(["yes", "ok", "go ahead", "continue", "do it", "/review", "[Request interrupted by user]"])("%s after the pin moves the turn and takes the pin down", async (content) => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessages, { conversation_id: conversation, messages: [{ role: "user", content, timestamp: PINNED_AT + 60_000 }] });
    expect([(await row())?.last_turn_at, (await row())?.thread_state_status]).toEqual([PINNED_AT + 60_000, undefined]);
    const single = await setup();
    await single.as.mutation(api.messages.addMessage, { conversation_id: single.conversation, role: "user", content, timestamp: PINNED_AT + 60_000 });
    expect([(await single.row())?.last_turn_at, (await single.row())?.thread_state_status]).toEqual([PINNED_AT + 60_000, undefined]);
  });

  // A /compact after a pin is a session boundary, not a turn (ct-49533): the
  // command line, the compaction summary and its local output leave the turn
  // stamp and the pin alone, so a done or dormant pin keeps its verdict.
  test("a /compact after the pin leaves the turn stamp and the pin alone", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessages, {
      conversation_id: conversation,
      messages: [
        { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>", timestamp: PINNED_AT + 60_000 },
        { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>", timestamp: PINNED_AT + 61_000 },
        { role: "user", content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.", timestamp: PINNED_AT + 62_000 },
      ],
    });
    const r = await row();
    expect([r?.thread_state_status, r?.last_turn_at]).toEqual(["dormant", undefined]);
  });

  // Local slash commands, their output and bash mode run no agent turn, in
  // either ingest path.
  test.each([
    ["/context", "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>"],
    ["/usage output", "<local-command-stdout>Current session: 12% used</local-command-stdout>"],
    ["bash mode", "<bash-input>git status</bash-input>"],
    ["the model picker", "/model opus"],
    ["an import note", "[Codecast import] This conversation was trimmed to fit."],
  ])("%s after the pin is no turn", async (_name, content) => {
    const single = await setup();
    await single.as.mutation(api.messages.addMessage, { conversation_id: single.conversation, role: "user", content, timestamp: PINNED_AT + 60_000 });
    expect([(await single.row())?.thread_state_status, (await single.row())?.last_turn_at]).toEqual(["dormant", undefined]);
    const batch = await setup();
    await batch.as.mutation(api.messages.addMessages, { conversation_id: batch.conversation, messages: [{ role: "user", content, timestamp: PINNED_AT + 60_000 }] });
    expect([(await batch.row())?.thread_state_status, (await batch.row())?.last_turn_at]).toEqual(["dormant", undefined]);
  });

  // The session-move notice asks the agent to reorient, so it opens a machine
  // turn: the pin stays on the row but no longer speaks for that turn.
  test("a session-move notice after the pin is a machine turn", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessage, {
      conversation_id: conversation, role: "user",
      content: "[codecast] This session just moved to a different machine. It now runs on mac-mini in /Users/a/code.", timestamp: PINNED_AT + 60_000,
    });
    const r = await row();
    expect([r?.thread_state_status, r?.last_turn_at]).toEqual(["dormant", PINNED_AT + 60_000]);
    expect(rowPinPredatesTurn(r as any)).toBe(true);
  });

  test("a person's message within the clock slack of the pin leaves it on the row, but not trusted", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessage, { conversation_id: conversation, role: "user", content: "why is this still failing?", timestamp: PINNED_AT + PIN_TURN_SLACK_MS });
    expect(await row()).toMatchObject({ thread_state_status: "dormant", last_turn_at: PINNED_AT + PIN_TURN_SLACK_MS });
    expect(rowPinPredatesTurn((await row()) as any)).toBe(true);
  });

  test("the batch path stamps the newest turn opener's time, and an older resync leaves it", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessages, {
      conversation_id: conversation,
      messages: [
        { role: "user", content: '<session-message from="jx7abcd">CI is green</session-message>', timestamp: PINNED_AT + 5_000 },
        { role: "assistant", content: "Merging.", timestamp: PINNED_AT + 6_000 },
        { role: "user", content: '<session-message from="jx7abcd">Deployed</session-message>', timestamp: PINNED_AT + 8_000 },
      ],
    });
    expect((await row())?.last_turn_at).toBe(PINNED_AT + 8_000);
    await as.mutation(api.messages.addMessages, {
      conversation_id: conversation,
      messages: [{ role: "user", content: '<session-message from="jx7abcd">older</session-message>', timestamp: PINNED_AT + 2_000 }],
    });
    expect((await row())?.last_turn_at).toBe(PINNED_AT + 8_000);
  });
});
