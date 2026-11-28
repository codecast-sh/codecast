import { describe, expect, test } from "bun:test";
import { formatNotifyList, parseNotifyLevel } from "./notifyCommand";

describe("cast notify", () => {
  test("each level has a word, and a stray word names none", () => {
    expect(parseNotifyLevel("all")).toBe("all");
    expect(parseNotifyLevel("needs-input")).toBe("needs_input");
    expect(parseNotifyLevel("Mute")).toBe("muted");
    expect(parseNotifyLevel("default")).toBe("default");
    expect(parseNotifyLevel("unmute")).toBe("default");
    expect(parseNotifyLevel("loud")).toBeNull();
  });

  test("the list is newest first, one line per session", () => {
    const lines = formatNotifyList(
      [
        { conversation_id: "jx7aaaa0000", level: "muted", updated_at: 1 },
        { conversation_id: "jx7bbbb0000", level: "all", updated_at: 2 },
      ],
      (id) => (id.startsWith("jx7b") ? "Fix billing" : "Old run"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("jx7bbbb  every message");
    expect(lines[0]).toEndWith("Fix billing");
    expect(lines[1]).toStartWith("jx7aaaa  muted");
    expect(formatNotifyList([], () => "")).toHaveLength(1);
  });
});
