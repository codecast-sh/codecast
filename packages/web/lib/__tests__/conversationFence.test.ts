import { describe, expect, test } from "bun:test";
import { markPhrases, readConversationFence } from "../conversationFence";

describe("conversation fence", () => {
  test("reads the thread, places the agent's messages, and drops emphasis markers", () => {
    const read = readConversationFence(JSON.stringify({
      agent: "Broker",
      thread: [{ from: "Mira", text: "Hi", at: "Oct 1" }, { from: "Broker", text: "See [the page](https://x.y) for **Dana**" }, { from: "Mira", text: "" }],
      before: "Old **reply**", after: "New reply", mark: { after: ["New"] },
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.thread).toEqual([
      { from: "Mira", text: "Hi", at: "Oct 1", agent: false },
      { from: "Broker", text: "See the page for Dana", at: null, agent: true },
    ]);
    expect(read.spec.before).toBe("Old reply");
    expect(read.spec.mark).toEqual({ before: [], after: ["New"] });
  });

  test("refuses a block that is not JSON or carries no reply", () => {
    expect(readConversationFence("Mira: hi").ok).toBe(false);
    expect(readConversationFence(JSON.stringify({ thread: [] })).ok).toBe(false);
  });

  test("marks each phrase across whitespace and case, leaving the rest", () => {
    expect(markPhrases("Hi.\nShe hasn't  been asked. Bye", ["she hasn't been asked."])).toEqual([
      { text: "Hi.\n", marked: false },
      { text: "She hasn't  been asked.", marked: true },
      { text: " Bye", marked: false },
    ]);
    expect(markPhrases("Nothing here", ["absent"])).toEqual([{ text: "Nothing here", marked: false }]);
  });
});
