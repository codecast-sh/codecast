import { describe, expect, test } from "bun:test";
import {
  accountChipProvider,
  claudeChipLabel,
  pickAccountChipDevice,
  resolveAccountChip,
  type AccountChipDevice,
} from "./accountUsageChip";

const claude = (over: Partial<AccountChipDevice> = {}): AccountChipDevice => ({
  is_remote: false,
  online: true,
  active_email: "ashot@x.com",
  profiles: [{ name: "ashot", email: "ashot@x.com" }],
  ...over,
});

describe("pickAccountChipDevice", () => {
  test("prefers an online primary over an offline one", () => {
    const offline = claude({ active_email: "old@x.com", online: false, profiles: [{ name: "old", email: "old@x.com" }] });
    const live = claude();
    expect(pickAccountChipDevice([offline, live])).toBe(live);
  });

  test("keeps the last-known primary when every daemon is quiet", () => {
    const primary = claude({ online: false });
    const remote = claude({ is_remote: true, online: true, active_email: "box@x.com" });
    expect(pickAccountChipDevice([remote, primary])).toBe(primary);
  });

  test("never picks a remote, even if it is the only online row", () => {
    expect(pickAccountChipDevice([claude({ is_remote: true, online: true })])).toBeUndefined();
  });
});

describe("resolveAccountChip", () => {
  test("stays visible for an offline primary with saved accounts", () => {
    const resolved = resolveAccountChip({
      devices: [claude({ online: false })],
      currentAgentType: "claude_code",
      lastShown: null,
    });
    expect(resolved?.shown).toBe("claude");
    expect(resolved?.claudeLabel).toBe("ashot");
    expect(resolved?.device.online).toBe(false);
  });

  test("stays visible when the current login is not a saved profile", () => {
    const resolved = resolveAccountChip({
      devices: [
        claude({
          active_email: "other@x.com",
          profiles: [{ name: "ashot", email: "ashot@x.com" }],
        }),
      ],
      currentAgentType: "claude_code",
      lastShown: null,
    });
    expect(resolved?.active).toBeUndefined();
    expect(resolved?.shown).toBe("claude");
    expect(resolved?.claudeLabel).toBe("other");
  });

  test("follows a Claude session even without an email match", () => {
    const resolved = resolveAccountChip({
      devices: [
        claude({
          active_email: undefined,
          profiles: [{ name: "ashot" }],
          codex_accounts: { profiles: [{ name: "codex" }] },
        }),
      ],
      currentAgentType: "claude_code",
      lastShown: "codex",
    });
    expect(resolved?.shown).toBe("claude");
    expect(resolved?.claudeLabel).toBe("ashot");
  });

  test("hides only when there is no primary with any account", () => {
    expect(
      resolveAccountChip({
        devices: [claude({ is_remote: true, profiles: [{ name: "box" }] })],
        currentAgentType: null,
        lastShown: null,
      }),
    ).toBeNull();
    expect(
      resolveAccountChip({
        devices: [claude({ profiles: [], active_email: undefined, codex_accounts: undefined })],
        currentAgentType: null,
        lastShown: null,
      }),
    ).toBeNull();
  });
});

describe("accountChipProvider", () => {
  test("session provider wins when that side has an account", () => {
    expect(
      accountChipProvider({
        currentAgentType: "codex",
        lastShown: "claude",
        hasClaude: true,
        hasCodex: true,
      }),
    ).toBe("codex");
  });

  test("falls back to the other provider rather than hiding", () => {
    expect(
      accountChipProvider({
        currentAgentType: "claude_code",
        lastShown: null,
        hasClaude: false,
        hasCodex: true,
      }),
    ).toBe("codex");
  });
});

describe("claudeChipLabel", () => {
  test("uses the email local part when the current login is unsaved", () => {
    expect(claudeChipLabel(undefined, "ashot@x.com", [{ name: "work" }])).toBe("ashot");
  });
});
