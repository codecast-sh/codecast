import { describe, expect, it } from "bun:test";
import { mentionWakeLine, typedHandles } from "../chatMentionWakes";

const roles = new Set(["infra-lead", "growth"]);

describe("mentionWakeLine", () => {
  it("names the role and the session the line woke", () => {
    expect(
      mentionWakeLine("@infra-lead please look, cc @jx7c6zk", { roles: 1, sessions: 1, folded: 0, skipped: [] }, roles),
    ).toBe("woke @infra-lead · delivered to jx7c6zk");
  });

  it("drops a target the server skipped", () => {
    expect(
      mentionWakeLine("@infra-lead @growth", { roles: 1, sessions: 0, folded: 0, skipped: ["role_has_no_session:growth"] }, roles),
    ).toBe("woke @infra-lead");
  });

  it("falls back to the count when the typed names disagree with it", () => {
    expect(mentionWakeLine("hello @maya", { roles: 1, sessions: 0, folded: 0, skipped: [] }, roles)).toBe("woke 1 role");
  });

  it("reports a fold, and says nothing when nothing happened", () => {
    expect(mentionWakeLine("@growth", { roles: 0, sessions: 0, folded: 1, skipped: [] }, roles)).toBe(
      "1 folded (over the hourly cap)",
    );
    expect(mentionWakeLine("@growth", { roles: 0, sessions: 0, folded: 0, skipped: [] }, roles)).toBeNull();
    expect(mentionWakeLine("plain", undefined, roles)).toBeNull();
  });

  it("reads handles at word boundaries only", () => {
    expect(typedHandles("mail me@x.org, @Growth and (@jx7c6zk)")).toEqual(["growth", "jx7c6zk"]);
  });
});
