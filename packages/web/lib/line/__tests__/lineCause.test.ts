// The one shape of a cause against the line (line-map.md LX6): the subject a
// node is named by, and the title and words the composer and "Send through
// the line" file.
import { describe, expect, test } from "bun:test";
import { causeTitle, lineCauseFields, lineSubject, profileSubject } from "../lineCause";

describe("lineSubject", () => {
  test("stations, finders, profile values and intake nodes each have their subject", () => {
    expect(lineSubject({ id: "prove", kind: "station" })).toBe("line:station:prove");
    expect(lineSubject({ id: "decide", kind: "decide" })).toBe("line:station:decide");
    expect(lineSubject({ id: "src:AgentWatch", kind: "source", source: "AgentWatch" })).toBe("line:finder:agentwatch");
    expect(lineSubject({ id: "signals", kind: "signals" })).toBe("line:signals");
    expect(profileSubject("watch_days")).toBe("line:profile:watch_days");
  });
});

describe("lineCauseFields", () => {
  test("the person's words: the first line is the title, the whole text the signal", () => {
    const f = lineCauseFields({ subject: "line:station:prove", label: "Prove", words: "  Prove picks old moments.\nIt should pick this week's.  " })!;
    expect(f).toEqual({ subject: "line:station:prove", title: "Prove picks old moments.", detail_md: "Prove picks old moments.\nIt should pick this week's." });
  });

  test("a draft rides under the words, exact, in a fence longer than any it holds", () => {
    const text = "Use ```bash``` blocks.";
    const f = lineCauseFields({ subject: "line:station:implement", label: "Implement", words: "", draft: { field: "prompt", text } })!;
    expect(f.title).toBe("Change the Implement station's prompt");
    expect(f.detail_md).toContain(`\`\`\`\`\n${text}\n\`\`\`\``);
  });

  test("nothing written is no filing", () => {
    expect(lineCauseFields({ subject: "line:signals", label: "Signals", words: "  " })).toBeNull();
    expect(lineCauseFields({ subject: "line:station:x", label: "X", words: "", draft: { field: "prompt", text: " " } })).toBeNull();
  });

  test("a long first line is cut at a word", () => {
    const t = causeTitle(`${"word ".repeat(40)}end`, "fallback");
    expect(t.length).toBeLessThanOrEqual(123);
    expect(t.endsWith("...")).toBe(true);
    expect(causeTitle("", "fallback")).toBe("fallback");
  });
});
