import { describe, expect, test } from "bun:test";
import { sessionAccountLabel, sessionAccountLine } from "../sessionAccountLabel";

const claude = {
  activeEmail: "ada@x.com",
  profiles: [
    { name: "ada", email: "ada@x.com" },
    { name: "grace", email: "grace@y.com" },
  ],
};

describe("sessionAccountLabel", () => {
  test("a pinned Claude session shows that profile's email", () => {
    const account = sessionAccountLabel({ agentType: "claude_code", ccAccount: "grace", claude });
    expect(account).toEqual({
      provider: "claude",
      label: "grace@y.com",
      title: "This session runs on the Claude account grace@y.com",
    });
    expect(sessionAccountLine(account!)).toBe("Claude · grace@y.com");
  });

  test("a Claude session with no pin shows the machine's login", () => {
    const account = sessionAccountLabel({ agentType: "claude_code", ccAccount: null, claude });
    expect(account?.label).toBe("ada@x.com");
    expect(account?.title).toContain("machine's Claude login");
  });

  test("a token switch's launch profile is the machine login, not the keychain email", () => {
    const account = sessionAccountLabel({
      agentType: "claude_code",
      claude: { ...claude, launchProfile: "grace" },
    });
    expect(account?.label).toBe("grace@y.com");
  });

  test("a pin the profile list has not loaded yet shows the pin name", () => {
    expect(sessionAccountLabel({ agentType: "claude_code", ccAccount: "grace" })?.label).toBe("grace");
  });

  test("a recorded Codex account is the process login", () => {
    const account = sessionAccountLabel({
      agentType: "codex",
      codexAccount: "work",
      codex: { activeEmail: "other@z.com", profiles: [{ name: "work", email: "work@z.com" }] },
    });
    expect(account).toMatchObject({ provider: "codex", label: "work@z.com" });
    expect(account?.title).toContain("Codex process is signed in as");
  });

  test("a Codex session that recorded nothing shows the machine login and says so", () => {
    const account = sessionAccountLabel({
      agentType: "codex_cli",
      codex: { activeEmail: "other@z.com", profiles: [{ name: "other", email: "other@z.com" }] },
    });
    expect(account?.label).toBe("other@z.com");
    expect(account?.title).toContain("did not record");
  });

  test("an API-billed cloud session and a session with no login name nothing", () => {
    expect(sessionAccountLabel({ agentType: "codex", sessionId: "sess_abc", codexAccount: "work" })).toBeNull();
    expect(sessionAccountLabel({ agentType: "claude_code" })).toBeNull();
    expect(sessionAccountLabel({ agentType: "grok" })).toBeNull();
  });
});
