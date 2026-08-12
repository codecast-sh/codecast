/**
 * Profile discovery and cloning.
 *
 * The clone is the part with real consequences: it decides whether the agent's
 * browser is logged in, how long the copy takes, and whether live session
 * cookies end up somewhere readable. Each is checked here against a fixture
 * tree rather than the machine's real Chrome.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloneProfile, formatBytes, parseLocalState } from "./profile.js";

const temps: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cast-profile-test-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A user-data root shaped like Chrome's, with the files a clone looks for. */
function fixtureRoot(opts: { cookiesIn?: "profile" | "network" | "none"; withSidecars?: boolean } = {}): string {
  const root = tempDir();
  const profile = path.join(root, "Default");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(root, "Local State"),
    JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Work" } } } }),
  );
  fs.writeFileSync(path.join(profile, "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed" } }));
  fs.writeFileSync(path.join(profile, "Web Data"), "webdata");
  fs.writeFileSync(path.join(profile, "Login Data"), "logins");
  fs.mkdirSync(path.join(profile, "Local Storage", "leveldb"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Local Storage", "leveldb", "000003.log"), "session-token");

  const where = opts.cookiesIn ?? "profile";
  if (where === "profile") {
    fs.writeFileSync(path.join(profile, "Cookies"), "cookie-db");
    if (opts.withSidecars) {
      fs.writeFileSync(path.join(profile, "Cookies-wal"), "uncommitted-tail");
      fs.writeFileSync(path.join(profile, "Cookies-shm"), "shared-mem");
    }
  } else if (where === "network") {
    fs.mkdirSync(path.join(profile, "Network"), { recursive: true });
    fs.writeFileSync(path.join(profile, "Network", "Cookies"), "cookie-db");
  }
  return root;
}

describe("parseLocalState", () => {
  test("names each profile the way the human named it", () => {
    const profiles = parseLocalState(
      JSON.stringify({
        profile: {
          last_used: "Profile 3",
          info_cache: {
            Default: { name: "Personal", user_name: "me@example.com" },
            "Profile 3": { name: "Work", user_name: "work@example.com" },
          },
        },
      }),
    );
    expect(profiles).toEqual([
      { dir: "Profile 3", name: "Work", email: "work@example.com", lastUsed: true },
      { dir: "Default", name: "Personal", email: "me@example.com", lastUsed: false },
    ]);
  });

  test("puts the last used profile first, since it is the one to clone", () => {
    const profiles = parseLocalState(
      JSON.stringify({ profile: { last_used: "Profile 9", info_cache: { Default: {}, "Profile 9": {} } } }),
    );
    expect(profiles[0].dir).toBe("Profile 9");
  });

  test("falls back to the directory name when there is no friendly one", () => {
    const profiles = parseLocalState(JSON.stringify({ profile: { info_cache: { "Profile 2": {} } } }));
    expect(profiles[0]).toEqual({ dir: "Profile 2", name: "Profile 2", email: null, lastUsed: false });
  });

  test("returns nothing rather than throwing on unreadable state", () => {
    expect(parseLocalState("not json")).toEqual([]);
    expect(parseLocalState("{}")).toEqual([]);
  });
});

describe("cloneProfile", () => {
  test("copies the identity files and reports finding cookies", () => {
    const root = fixtureRoot();
    const dest = path.join(tempDir(), "clone");
    const res = cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });

    expect(res.cookiesFound).toBe(true);
    expect(fs.readFileSync(path.join(dest, "Default", "Cookies"), "utf-8")).toBe("cookie-db");
    expect(fs.existsSync(path.join(dest, "Local State"))).toBe(true);
    expect(fs.readFileSync(path.join(dest, "Default", "Local Storage", "leveldb", "000003.log"), "utf-8")).toBe(
      "session-token",
    );
  });

  test("finds cookies in the Network subdirectory too", () => {
    // Chrome has moved this file between versions; missing it means a clone
    // that launches perfectly and is logged out of everything.
    const root = fixtureRoot({ cookiesIn: "network" });
    const dest = path.join(tempDir(), "clone");
    const res = cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });
    expect(res.cookiesFound).toBe(true);
  });

  test("says so when there were no cookies to copy", () => {
    // Silence here would be a browser that starts logged out for no stated
    // reason, which is the confusing failure this flag exists to prevent.
    const root = fixtureRoot({ cookiesIn: "none" });
    const dest = path.join(tempDir(), "clone");
    const res = cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });
    expect(res.cookiesFound).toBe(false);
    expect(res.missing).toContain("Cookies");
  });

  test("brings the SQLite sidecars along with the database", () => {
    // The -wal file holds transactions not yet folded into the main database,
    // which on a running Chrome is where the newest logins live.
    const root = fixtureRoot({ withSidecars: true });
    const dest = path.join(tempDir(), "clone");
    cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });
    expect(fs.readFileSync(path.join(dest, "Default", "Cookies-wal"), "utf-8")).toBe("uncommitted-tail");
    expect(fs.existsSync(path.join(dest, "Default", "Cookies-shm"))).toBe(true);
  });

  test("leaves no IndexedDB behind it", () => {
    // Deliberately excluded: it dominates the copy time and size.
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, "Default", "IndexedDB"), { recursive: true });
    fs.writeFileSync(path.join(root, "Default", "IndexedDB", "huge.blob"), "x".repeat(1000));
    const dest = path.join(tempDir(), "clone");
    cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });
    expect(fs.existsSync(path.join(dest, "Default", "IndexedDB"))).toBe(false);
  });

  test("writes the clone as Default whatever the source was called", () => {
    // So the launch never needs --profile-directory, one less thing to desync.
    const root = fixtureRoot();
    fs.cpSync(path.join(root, "Default"), path.join(root, "Profile 7"), { recursive: true });
    const dest = path.join(tempDir(), "clone");
    cloneProfile({ sourceDir: "Profile 7", destRoot: dest, sourceRoot: root });
    expect(fs.existsSync(path.join(dest, "Default", "Cookies"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "Profile 7"))).toBe(false);
  });

  test("clears the crash flag so no restore bubble covers the page", () => {
    // That bubble sits over the top-left of the window and eats the first click.
    const root = fixtureRoot();
    const dest = path.join(tempDir(), "clone");
    cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });
    const prefs = JSON.parse(fs.readFileSync(path.join(dest, "Default", "Preferences"), "utf-8"));
    expect(prefs.profile.exit_type).toBe("Normal");
    expect(prefs.profile.exited_cleanly).toBe(true);
  });

  test("keeps the clone directory private to the user", () => {
    // It holds live session cookies for every site the human is signed in to.
    const root = fixtureRoot();
    const dest = path.join(tempDir(), "clone");
    cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });
    expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
  });

  test("replaces an earlier clone rather than merging into it", () => {
    // A stale cookie database left behind would silently outrank the new one.
    const root = fixtureRoot();
    const dest = path.join(tempDir(), "clone");
    fs.mkdirSync(path.join(dest, "Default"), { recursive: true });
    fs.writeFileSync(path.join(dest, "Default", "stale-file"), "old");
    cloneProfile({ sourceDir: "Default", destRoot: dest, sourceRoot: root });
    expect(fs.existsSync(path.join(dest, "Default", "stale-file"))).toBe(false);
  });

  test("names the profile it could not find", () => {
    const root = fixtureRoot();
    expect(() => cloneProfile({ sourceDir: "Profile 404", destRoot: tempDir(), sourceRoot: root })).toThrow(
      /Profile 404/,
    );
  });
});

describe("formatBytes", () => {
  test("scales to a readable unit", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2K");
    expect(formatBytes(68 * 1024 * 1024)).toBe("68M");
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.2G");
  });
});
