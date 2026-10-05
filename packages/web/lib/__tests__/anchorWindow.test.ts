import { describe, expect, test } from "bun:test";
import { bootstrapCut, isBootstrapMessage, windowConversationSince } from "../anchorWindow";

const boot = { timestamp: 100, role: "user", content: "You are **Head of People**, the standing agent for the **Head of People** role (@head-of-people) in the Union workspace. You report to Ashot." };
const anchorBoot = { timestamp: 100, role: "user", content: [{ type: "text", text: "You are **Anchor**, the **team** anchor for Union — every member can reach you" }] };
const reply = { timestamp: 200, role: "assistant", content: "Here is what I look after." };
const later = { timestamp: 300, role: "user", content: "You are **not** a bootstrap: this is a person talking." };

describe("the seat's provisioning prompt folds away (F4.1)", () => {
  test("the prompt is known by its own first line, for a role and for an anchor", () => {
    expect(isBootstrapMessage(boot)).toBe(true);
    expect(isBootstrapMessage(anchorBoot)).toBe(true);
    expect(isBootstrapMessage(later)).toBe(false);
    expect(isBootstrapMessage({ ...boot, role: "assistant" })).toBe(false);
    expect(isBootstrapMessage(undefined)).toBe(false);
  });

  test("the cut is the first message after the first prompt, once the window reaches the start", () => {
    expect(bootstrapCut({ messages: [boot, reply, later] })).toBe(200);
    // Seated on an existing agent: the prompt sits mid-history and the thread as this role starts there.
    const before = { timestamp: 50, role: "assistant", content: "the old anchor's words" };
    expect(bootstrapCut({ messages: [before, boot, reply], loaded_start_index: 0 })).toBe(200);
    // A re-brief later in the role's own thread never cuts it (jx7d538 carried
    // three, and cutting at the last hid 395 messages of the role's own work).
    const rebrief = { timestamp: 400, role: "user", content: "You are the **Calling lead** (@calling) in Union." };
    const work = { timestamp: 300, role: "assistant", content: "the role's own work" };
    expect(bootstrapCut({ messages: [boot, reply, work, rebrief, { timestamp: 500, role: "assistant", content: "after" }] })).toBe(200);
    // Older pages unloaded: the first prompt in the window may be a re-brief, so nothing is cut yet.
    expect(bootstrapCut({ messages: [work, rebrief, reply], loaded_start_index: 395 })).toBeUndefined();
    // The prompt alone cuts itself, so the page opens on the lead.
    expect(bootstrapCut({ messages: [before, boot] })).toBe(101);
    expect(bootstrapCut({ messages: [reply, later] })).toBeUndefined();
    expect(bootstrapCut(null)).toBeUndefined();
  });

  test("windowing at the cut drops the prompt and stops paging older", () => {
    const conv = { messages: [boot, reply, later], loaded_start_index: 0 };
    const w = windowConversationSince(conv, bootstrapCut(conv))!;
    expect(w.conversation.messages.map((m) => m.timestamp)).toEqual([200, 300]);
    expect(w.conversation.loaded_start_index).toBe(1);
    expect(w.reachedStart).toBe(true);
    expect(windowConversationSince(conv, undefined)!.conversation).toBe(conv);
  });
});
