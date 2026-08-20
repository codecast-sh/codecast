import { describe, expect, it } from "bun:test";
import { isThreadsPin, readPins } from "../sidebarPins";

// The Threads page pins as a view. Before it left chat it pinned as a channel
// with the literal id "threads" — persisted arrays still carry that form, and
// both must resolve to the page without rewriting what is stored.
describe("isThreadsPin", () => {
  it("accepts the view form and the legacy channel form", () => {
    expect(isThreadsPin({ kind: "view", id: "threads" })).toBe(true);
    expect(isThreadsPin({ kind: "channel", id: "threads" })).toBe(true);
  });

  it("rejects other pins", () => {
    expect(isThreadsPin({ kind: "project", id: "threads" })).toBe(false);
    expect(isThreadsPin({ kind: "channel", id: "chan1234567890123456789012345678" })).toBe(false);
    expect(isThreadsPin({ kind: "view", id: "v1" })).toBe(false);
  });

  it("readPins hands back the stored array unchanged (stable ref, no rewrite)", () => {
    const pins = [{ kind: "channel", id: "threads", label: "Threads" }];
    const state = { clientState: { ui: { sidebar_pins: pins } } };
    expect(readPins(state)).toBe(pins as any);
    expect(readPins({ clientState: { ui: {} } })).toBe(readPins({}));
  });
});
