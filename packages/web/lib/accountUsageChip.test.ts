import { describe, expect, test } from "bun:test";
import {
  accountChipProvider,
  claudeChipLabel,
  pickAccountChipDevice,
  resolveAccountChip,
  type AccountChipDevice,
} from "./accountUsageChip";

const claude = (over: Partial<AccountChipDevice> = {}): AccountChipDevice => ({
  device_id: "local",
  is_remote: false,
  online: true,
  active_email: "ashot@x.com",
  profiles: [{ name: "ashot", email: "ashot@x.com" }],
  ...over,
});

describe("pickAccountChipDevice", () => {
  test("selects the verified local Mac regardless of row order", () => {
    const elsewhere = claude({ device_id: "elsewhere" });
    const local = claude();
    expect(pickAccountChipDevice([elsewhere, local], "local")).toBe(local);
    expect(pickAccountChipDevice([local, elsewhere], "local")).toBe(local);
  });

  test("retains the local Mac when it is offline and another is online", () => {
    const local = claude({ online: false });
    const elsewhere = claude({ device_id: "elsewhere" });
    expect(pickAccountChipDevice([elsewhere, local], "local")).toBe(local);
  });

  test("never guesses while local discovery is unresolved, even with one Mac", () => {
    expect(pickAccountChipDevice([claude()], null)).toBeUndefined();
  });

  test("never falls back when the local Mac has no account inventory", () => {
    expect(pickAccountChipDevice([claude({ device_id: "elsewhere" })], "local")).toBeUndefined();
    expect(pickAccountChipDevice(undefined, "local")).toBeUndefined();
  });

  test("never picks a cloud device", () => {
    expect(pickAccountChipDevice([claude({ is_remote: true })], "local")).toBeUndefined();
  });
});

describe("resolveAccountChip", () => {
  test("stays visible for an offline local machine with saved accounts", () => {
    const resolved = resolveAccountChip({
      localDeviceId: "local",
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
      localDeviceId: "local",
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

  test("an email-less snapshot whose name is the current login is the active account", () => {
    const profile = { name: "joannagerkin" };
    const resolved = resolveAccountChip({
      localDeviceId: "local",
      devices: [
        claude({
          active_email: "joannagerkin@gmail.com",
          profiles: [profile, { name: "fresh", email: "freshraisin@gmail.com" }],
        }),
      ],
      currentAgentType: "claude_code",
      lastShown: null,
    });
    expect(resolved?.active).toEqual(profile);
    expect(resolved?.claudeLabel).toBe("joannagerkin");
  });

  test("follows a Claude session even without an email match", () => {
    const resolved = resolveAccountChip({
      localDeviceId: "local",
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

  test("has no account to show for a cloud device or empty local inventory", () => {
    expect(
      resolveAccountChip({
        localDeviceId: "local",
        devices: [claude({ is_remote: true, profiles: [{ name: "box" }] })],
        currentAgentType: null,
        lastShown: null,
      }),
    ).toBeNull();
    expect(
      resolveAccountChip({
        localDeviceId: "local",
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
