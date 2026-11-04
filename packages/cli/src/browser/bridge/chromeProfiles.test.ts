import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionProfiles, matchProfile, pickBridgeProfile } from "./chromeProfiles";
import { BRIDGE_EXTENSION_ID } from "./protocol";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Ext = "enabled" | "disabled" | "none";

/** A Chrome user-data dir: Local State naming the profiles, and Secure Preferences per profile. */
function chromeRoot(profiles: Record<string, { name: string; email?: string; ext: Ext }>, lastUsed: string): string {
  const root = mkdtempSync(join(tmpdir(), "cast-chrome-profiles-"));
  roots.push(root);
  const info_cache: Record<string, unknown> = {};
  for (const [dir, p] of Object.entries(profiles)) {
    info_cache[dir] = { name: p.name, user_name: p.email ?? "" };
    mkdirSync(join(root, dir));
    const settings = p.ext === "none" ? {} : { [BRIDGE_EXTENSION_ID]: { location: 7, disable_reasons: p.ext === "disabled" ? [1] : [] } };
    writeFileSync(join(root, dir, "Secure Preferences"), JSON.stringify({ extensions: { settings } }));
  }
  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache, last_used: lastUsed } }));
  return root;
}

describe("the Chrome profile the bridge uses", () => {
  // Alex's case (2026-10-29): Chrome's last-used profile has no extension,
  // so a pairing page opened without a profile became chrome-extension://invalid.
  test("skips a last-used profile without the extension", () => {
    const found = extensionProfiles(chromeRoot({
      Default: { name: "Personal", ext: "none" },
      "Profile 2": { name: "Work", email: "a@work.com", ext: "enabled" },
    }, "Default"));
    expect(found.known).toBe(true);
    expect(found.withExtension.map((p) => p.dir)).toEqual(["Profile 2"]);
    expect(pickBridgeProfile(found)?.dir).toBe("Profile 2");
  });

  test("a disabled extension does not count", () => {
    const found = extensionProfiles(chromeRoot({
      Default: { name: "Personal", ext: "disabled" },
      "Profile 1": { name: "Work", ext: "none" },
    }, "Default"));
    expect(found.withExtension).toEqual([]);
    expect(pickBridgeProfile(found)).toBeNull();
  });

  test("several profiles: pinned first, then last used, then directory order", () => {
    const root = chromeRoot({
      Default: { name: "Personal", ext: "enabled" },
      "Profile 2": { name: "Work", ext: "enabled" },
      "Profile 10": { name: "Side", ext: "enabled" },
    }, "Profile 10");
    const found = extensionProfiles(root);
    expect(pickBridgeProfile(found, "Profile 2")?.dir).toBe("Profile 2");
    expect(pickBridgeProfile(found)?.dir).toBe("Profile 10");
    // A pin to a profile that lost the extension falls through.
    expect(pickBridgeProfile(found, "Profile 7")?.dir).toBe("Profile 10");
    const noLastUsed = { ...found, withExtension: found.withExtension.filter((p) => !p.lastUsed) };
    expect(pickBridgeProfile(noLastUsed)?.dir).toBe("Default");
  });

  test("no readable profile list is unknown, not empty", () => {
    expect(extensionProfiles(null).known).toBe(false);
    expect(extensionProfiles(join(tmpdir(), "no-such-chrome-root")).known).toBe(false);
  });

  test("--profile matches a name, an email or a directory", () => {
    const found = extensionProfiles(chromeRoot({
      Default: { name: "Personal", ext: "none" },
      "Profile 2": { name: "Work", email: "a@work.com", ext: "enabled" },
    }, "Default"));
    expect(matchProfile(found.all, "work")?.dir).toBe("Profile 2");
    expect(matchProfile(found.all, "A@WORK.COM")?.dir).toBe("Profile 2");
    expect(matchProfile(found.all, "profile 2")?.dir).toBe("Profile 2");
    expect(matchProfile(found.all, "nope")).toBeNull();
  });
});
