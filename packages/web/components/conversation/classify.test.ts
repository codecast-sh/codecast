import { describe, expect, test } from "bun:test";
import { classifyUserMessage, cleanStickyContent } from "./classify";
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
