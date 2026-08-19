import { describe, expect, test } from "bun:test";
import { buildSettlePrompt, parseSettleReply, parseSettleVerdict, shapeFinalMessage, shapeSettleTail, SETTLE_FINAL_HEAD_CHARS, SETTLE_FINAL_TAIL_CHARS, SETTLE_CONTEXT_CHARS } from "./idleSummary";

// The settle classifier's pure half. What the model is asked, and how its
// answer is read, must be stable — scripts/settle-eval.ts grades the live model
// against the same builder.
describe("shapeSettleTail", () => {
  const rows = (turns: Array<[string, string]>) => turns.map(([role, content]) => ({ role, content })).reverse();

  test("marks the last assistant message as FINAL and keeps its END", () => {
    const long = "opening. " + "middle filler. ".repeat(600) + "So the standup question is: ship B alone or B+A?";
    const out = shapeSettleTail(rows([["user", "explain"], ["assistant", long]]));
    const fin = out.find((m) => m.isFinal)!;
    expect(fin.content.endsWith("ship B alone or B+A?")).toBe(true);
    expect(fin.content.startsWith("opening.")).toBe(true);
    expect(fin.content).toContain("chars omitted");
    expect(fin.content.length).toBeLessThanOrEqual(SETTLE_FINAL_HEAD_CHARS + SETTLE_FINAL_TAIL_CHARS + 60);
  });

  test("earlier messages are context-trimmed; a trailing user message does not steal FINAL", () => {
    const out = shapeSettleTail(rows([["assistant", "a".repeat(2000)], ["user", "<session-message>ok</session-message>"]]));
    expect(out[0].isFinal).toBe(true);
    expect(out[0].content.length).toBeLessThanOrEqual(SETTLE_FINAL_HEAD_CHARS + SETTLE_FINAL_TAIL_CHARS);
    expect(out[1].isFinal).toBe(false);
    // Only the final assistant message keeps its length; a non-final one is trimmed.
    const two = shapeSettleTail(rows([["assistant", "b".repeat(2000)], ["assistant", "final"]]));
    expect(two[0].content.length).toBe(SETTLE_CONTEXT_CHARS);
    expect(two[1].isFinal).toBe(true);
  });

  test("bulky blocks collapse to markers", () => {
    expect(shapeFinalMessage("Report:\n```cast-canvas\n<div>" + "x".repeat(5000) + "</div>\n```\nDone.")).toBe("Report:\n[canvas report]\nDone.");
  });

  test("a halted tool call after the final text adds the mid-work note — but not after a wrap-up or an external message", () => {
    const halted = shapeSettleTail([
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "user", content: "", tool_results: [{}] },
      { role: "assistant", content: "OTA is live. Now the native build:" },
    ]);
    expect(halted.some((m) => m.role === "note")).toBe(true);
    // Ended on a RESULT (cast state as the last action): settled on purpose.
    const wrapped = shapeSettleTail([
      { role: "user", content: "", tool_results: [{}] },
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "assistant", content: "Shipped it." },
    ]);
    expect(wrapped.some((m) => m.role === "note")).toBe(false);
    // A teammate shutdown arrived after the report; the halted call answered it.
    const shutdown = shapeSettleTail([
      { role: "assistant", content: "", tool_calls: [{}] },
      { role: "user", content: "<teammate-message>shutdown_request</teammate-message>" },
      { role: "assistant", content: "Report sent." },
    ]);
    expect(shutdown.some((m) => m.role === "note")).toBe(false);
  });

  test("tool-result carriers and low-signal prompts drop out", () => {
    const out = shapeSettleTail([
      { role: "user", content: "", tool_results: [{}] },
      { role: "assistant", content: "shipped it" },
    ]);
    expect(out.map((m) => m.content)).toEqual(["shipped it"]);
  });
});

describe("buildSettlePrompt / parseSettleReply", () => {
  test("labels the final message and offers only done | needs_input", () => {
    const p = buildSettlePrompt(shapeSettleTail([{ role: "assistant", content: "ok" }]));
    expect(p).toContain("[FINAL MESSAGE — the settle]: ok");
    expect(p).toContain("VERDICT: <needs_input | done>");
    expect(p).not.toMatch(/\bdormant\b/);
  });

  test("parses the two-line reply and ignores anything but the two verdicts", () => {
    expect(parseSettleReply("VERDICT: done\nSUMMARY: Shipped the fix")).toEqual({ verdict: "done", summary: "Shipped the fix" });
    expect(parseSettleReply("VERDICT: needs input\nSUMMARY: Choose an option")).toEqual({ verdict: "needs_input", summary: "Choose an option" });
    // A stale "dormant" (older prompt) is not a verdict — the row keeps its needs-input default.
    expect(parseSettleReply("VERDICT: dormant\nSUMMARY: Waiting on CI").verdict).toBeNull();
    expect(parseSettleVerdict("DONE")).toBe("done");
    // No VERDICT line: whole text is the summary, verdict null.
    expect(parseSettleReply("Deployed and verified")).toEqual({ verdict: null, summary: "Deployed and verified" });
  });
});
