import { beforeEach, describe, expect, test } from "bun:test";
import {
  closeSyntheticPrompt,
  nextSyntheticPromptUuid,
  syntheticPromptTestSeam,
} from "./daemon.js";

// Regression coverage for the eternal open question (2026-08-21, "Product
// aggregation super page"): a scraped TUI menu (a /model confirmation) has no
// JSONL counterpart, so nothing ever wrote a tool_result for its synthetic
// AskUserQuestion card. The card stayed an open, answerable question in the
// conversation forever, and clicking it fired keys into whatever the pane
// showed by then. The daemon now retires its own card: a tool_result message
// is synced when the answer flows through delivery or when the heartbeat sees
// the menu gone.

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000";
const CONV = "jx7test0000000000000000000000000";
const UUID = `interactive-prompt-${SID}-abcdef0123456789`;

type Added = { conversationId: string; messages: any[] };

function stubSync(calls: Added[]) {
  return { addMessages: async (params: Added) => { calls.push(params); } } as any;
}

beforeEach(() => {
  syntheticPromptTestSeam.lastEmittedSyntheticPrompt.clear();
  syntheticPromptTestSeam.closedSyntheticPrompts.clear();
});

describe("closeSyntheticPrompt", () => {
  test("syncs a tool_result for the emitted card and clears the re-emit record", async () => {
    syntheticPromptTestSeam.lastEmittedSyntheticPrompt.set(SID, UUID);
    const calls: Added[] = [];
    await closeSyntheticPrompt(SID, CONV, stubSync(calls), "Dismissed in the terminal");

    expect(calls.length).toBe(1);
    const msg = calls[0].messages[0];
    expect(calls[0].conversationId).toBe(CONV);
    expect(msg.messageUuid).toBe(`${UUID}-closed`);
    expect(msg.toolResults).toEqual([{ toolUseId: UUID, content: "Dismissed in the terminal" }]);
    expect(syntheticPromptTestSeam.lastEmittedSyntheticPrompt.has(SID)).toBe(false);
    expect(syntheticPromptTestSeam.closedSyntheticPrompts.get(UUID)).toBe(1);
  });

  test("is a no-op with nothing synthetic on record", async () => {
    const calls: Added[] = [];
    await closeSyntheticPrompt(SID, CONV, stubSync(calls), "whatever");
    expect(calls.length).toBe(0);
  });

  test("never closes a limit banner (no tool_use to resolve)", async () => {
    syntheticPromptTestSeam.lastEmittedSyntheticPrompt.set(SID, `limit-dialog-${SID}-abc-123`);
    const calls: Added[] = [];
    await closeSyntheticPrompt(SID, CONV, stubSync(calls), "whatever");
    expect(calls.length).toBe(0);
    // The record survives so the limit banner's own re-emit suppression keeps working.
    expect(syntheticPromptTestSeam.lastEmittedSyntheticPrompt.has(SID)).toBe(true);
  });

  test("closing a suffixed re-emit counts against the base uuid", async () => {
    syntheticPromptTestSeam.closedSyntheticPrompts.set(UUID, 1);
    syntheticPromptTestSeam.lastEmittedSyntheticPrompt.set(SID, `${UUID}-r1`);
    const calls: Added[] = [];
    await closeSyntheticPrompt(SID, CONV, stubSync(calls), "Answered from the app: Yes");
    expect(calls[0].messages[0].toolResults[0].toolUseId).toBe(`${UUID}-r1`);
    expect(syntheticPromptTestSeam.closedSyntheticPrompts.get(UUID)).toBe(2);
  });

  test("a failed sync does not throw out of the caller", async () => {
    syntheticPromptTestSeam.lastEmittedSyntheticPrompt.set(SID, UUID);
    const failing = { addMessages: async () => { throw new Error("offline"); } } as any;
    await closeSyntheticPrompt(SID, CONV, failing, "Dismissed in the terminal");
  });
});

describe("nextSyntheticPromptUuid", () => {
  test("first emit uses the content-deterministic id unchanged", () => {
    expect(nextSyntheticPromptUuid(UUID)).toBe(UUID);
  });

  test("re-detecting a menu closed before mints a fresh id, so the new card is not born answered", () => {
    syntheticPromptTestSeam.closedSyntheticPrompts.set(UUID, 1);
    expect(nextSyntheticPromptUuid(UUID)).toBe(`${UUID}-r1`);
    syntheticPromptTestSeam.closedSyntheticPrompts.set(UUID, 2);
    expect(nextSyntheticPromptUuid(UUID)).toBe(`${UUID}-r2`);
  });
});
