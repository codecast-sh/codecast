import { describe, expect, it } from "bun:test";
import { mentionWakeLine, typedHandles } from "../chatMentionWakes";

const roles = new Set(["infra-lead", "growth"]);

describe("mentionWakeLine", () => {
  it("names the role and the session the line woke", () => {
    expect(
      mentionWakeLine("@infra-lead please look, cc @jx7c6zk", { roles: 1, sessions: 1, folded: 0, skipped: [] }, roles),
    ).toBe("woke @infra-lead · delivered to jx7c6zk");
  });

  it("never names a skipped target as woken, and says why a role is holding", () => {
    expect(
      mentionWakeLine("@infra-lead @growth", { roles: 1, sessions: 0, folded: 0, skipped: ["role_has_no_session:growth"] }, roles),
    ).toBe("woke @infra-lead · @growth has no agent yet: bring it online from its page");
    // A paused role woke nothing, and the sender still hears what became of the line.
    expect(
      mentionWakeLine("@infra-lead status?", { roles: 0, sessions: 0, folded: 0, skipped: ["role_paused:infra-lead"] }, roles),
    ).toBe("@infra-lead is paused: your line waits until someone resumes it");
    // A skip that is the system working (a relay, a loop rule) stays silent.
    expect(
      mentionWakeLine("@infra-lead", { roles: 0, sessions: 0, folded: 0, skipped: ["relayed:infra-lead"] }, roles),
    ).toBeNull();
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
