import { describe, expect, test } from "bun:test";
import { compactionProgressMessage, parseCompactionProgress } from "./compactionProgress";

const SCREEN = [
  "❯ continue",
  "",
  "• Compacting conversation... (33s)",
  "████████████░░░░░░░░░░░░░░░░░░░░░░░░ 31%",
  "└ Tip: Run /ultrareview for a cloud-based multi-agent review that finds and verifies bugs in your branch – 3 free reviews left",
].join("\n");

describe("parseCompactionProgress", () => {
  test("reads Claude's compaction screen: elapsed, percent, tip", () => {
    expect(parseCompactionProgress(SCREEN)).toEqual({
      elapsed: "33s",
      percent: 31,
      tip: "Run /ultrareview for a cloud-based multi-agent review that finds and verifies bugs in your branch – 3 free reviews left",
    });
  });

  test("reads a one-period header and a braille spinner", () => {
    const text = "⠧ Compacting conversation. (12s)\n██████░░░░░░░░░░░░░░░░░░░░░░░░ 18%";
    expect(parseCompactionProgress(text)).toEqual({ elapsed: "12s", percent: 18, tip: null });
  });

  test("reads Codex's status line and drops the interrupt hint from the clock", () => {
    expect(parseCompactionProgress("• Compacting conversation (2m 10s • esc to interrupt)")).toEqual({
      elapsed: "2m 10s",
      percent: null,
      tip: null,
    });
  });

  test("ignores a sentence that only mentions the words", () => {
    expect(parseCompactionProgress("We should compact the conversation before the next turn.")).toBeNull();
  });

  test("ignores a percent line that is not a bar", () => {
    expect(parseCompactionProgress("Compacting conversation... (4s)\nabout 31% done")).toEqual({
      elapsed: "4s",
      percent: null,
      tip: null,
    });
  });
});

describe("compactionProgressMessage", () => {
  test("a message that is only the screen becomes the progress", () => {
    const only = [
      "• Compacting conversation... (33s)",
      "████████████░░░░░░░░░░░░░░░░░░░░░░░░ 31%",
      "└ Tip: Run /ultrareview for a cloud-based review",
    ].join("\n");
    expect(compactionProgressMessage(only)?.percent).toBe(31);
  });

  test("a transcript that continues after the screen stays a transcript", () => {
    const mixed = `${SCREEN}\n\nI'll pick up once the context is shorter.`;
    expect(compactionProgressMessage(mixed)).toBeNull();
    expect(parseCompactionProgress(mixed)?.percent).toBe(31);
  });
});
