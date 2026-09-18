import { describe, expect, test } from "bun:test";
import { bootstrapCut, isBootstrapMessage, windowConversationSince } from "../anchorWindow";

const boot = { timestamp: 100, role: "user", content: "You are **Chief of Staff**, the standing agent for the **Chief of Staff** role (@chief-of-staff) in the Union workspace. You report to Ashot." };
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

  test("the cut is the first message after the last prompt in the window", () => {
    expect(bootstrapCut({ messages: [boot, reply, later] })).toBe(200);
    // Seated on an existing agent: the prompt sits mid-history and the thread as this role starts there.
    const before = { timestamp: 50, role: "assistant", content: "the old anchor's words" };
    expect(bootstrapCut({ messages: [before, boot, reply], loaded_start_index: 40 })).toBe(200);
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
