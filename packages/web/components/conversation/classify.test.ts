import { describe, expect, test } from "bun:test";
import { classifyUserMessage, cleanStickyContent, decideOutputId } from "./classify";
import { formatTaskCommentMessage } from "@codecast/shared/contracts";

describe("cleanStickyContent", () => {
  test("keeps an HTML comment the person typed, as the message body does", () => {
    expect(cleanStickyContent('add one line "<!-- codecast spike -->" at the end of README.md')).toBe('add one line "<!-- codecast spike -->" at the end of README.md');
  });

  test("drops system wrappers around the prompt", () => {
    expect(cleanStickyContent("<system-reminder>ignore</system-reminder>fix the bug<bash-input>")).toBe("fix the bug");
  });
});

describe("a person's task comment delivered into the owning session", () => {
  test("reads as their own words under a quote naming the task, the reply note left out", () => {
    const content = formatTaskCommentMessage({ task: "ct-7", title: "Fix checkout", from: "Ada Lovelace", body: "Use the cached cart" });
    const kind = classifyUserMessage({ _id: "m", role: "user", content, timestamp: 1 } as any);
    expect(kind).toEqual({ kind: "direct_user", from: "Ada Lovelace", body: '> About ct-7 ("Fix checkout"):\n\nUse the cached cart' });
  });
});

describe("decideOutputId", () => {
  const ask = "When a call the broker asked for expires undialed, what should happen next?";
  test("reads the Convex id off the ask's id line, else the short id", () => {
    expect(decideOutputId("Decision posted: Q\n  id: sd-614  (k97k8010tt42e5xwgaa6cqktg58g3f74)\n", "ask")).toBe("k97k8010tt42e5xwgaa6cqktg58g3f74");
    expect(decideOutputId("  id: k97k8010tt42e5xwgaa6cqktg58g3f74\n", "ask")).toBe("k97k8010tt42e5xwgaa6cqktg58g3f74");
    expect(decideOutputId("  id: sd-614\n", "ask")).toBe("sd-614");
  });
  test("names an ask whose id line was cut off by the listing line that carries its question", () => {
    const tail = `Blocking: end your turn now.\n● sd-614  ${ask}  (external)\n    still open`;
    expect(decideOutputId(tail, "ask", ask)).toBe("sd-614");
    expect(decideOutputId(`● sd-600  Some other question?\n`, "ask", ask)).toBeNull();
    expect(decideOutputId(tail, "ask")).toBeNull();
  });
  test("keeps a compound command's ids apart by verb", () => {
    const out = "Decision withdrawn: sd-12. It leaves the queue.\nDecision posted: Q\n  id: sd-13  (k97k8010tt42e5xwgaa6cqktg58g3f74)\n";
    expect(decideOutputId(out, "cancel")).toBe("sd-12");
    expect(decideOutputId(out, "ask")).toBe("k97k8010tt42e5xwgaa6cqktg58g3f74");
    expect(decideOutputId("Decision updated: sd-12", "edit")).toBe("sd-12");
  });
});
