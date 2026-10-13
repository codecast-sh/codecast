import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveCapabilities } from "@codecast/shared/contracts";
import { applyBuiltins, builtinEntries } from "./builtinDriver.js";
import { reconcileFromHeartbeat } from "./reconcile.js";
import { recordConvergenceSignals, resetConvergenceState, convergenceState } from "./heartbeat.js";

// The builtin driver turns resolved bindings into CLAUDE.md sections using the
// SAME writers cast install/uninstall use. These tests run against a fake HOME
// (getSnippetTargets reads process.env.HOME first) and pin the three things
// the live proof showed: off cuts exactly one section, on installs it, and an
// unchanged steady state writes nothing.

let home: string;
let originalHome: string | undefined;
beforeEach(() => {
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-builtin-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# My notes\n\nkeep me\n");
  process.env.HOME = home;
  resetConvergenceState();
});
afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  resetConvergenceState();
});

const CTX = { userId: "u1", deviceId: "dev1", projectKeys: [], client: "claude" as const };
const bind = (slug: string, enabled: boolean, scopeKind = "user", scopeKey = "") => ({
  id: `${slug}|${scopeKind}`,
  userId: "u1",
  capabilitySlug: slug,
  scopeKind: scopeKind as any,
  scopeKey,
  enabled,
  updatedAt: 1,
});
const claudeMd = () => fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf-8");

describe("applyBuiltins", () => {
  test("ON installs the section; the user's own text survives", () => {
    const state = resolveCapabilities([bind("builtin/visual", true)], CTX);
    const out = applyBuiltins(state);
    expect(out.installed).toEqual(["visual"]);
    expect(claudeMd()).toContain("<!-- /codecast-visual -->");
    expect(claudeMd()).toContain("keep me");
  });

  test("a second apply of the same state writes nothing", () => {
    const state = resolveCapabilities([bind("builtin/visual", true)], CTX);
    applyBuiltins(state);
    const before = fs.statSync(path.join(home, ".claude", "CLAUDE.md")).mtimeMs;
    const again = applyBuiltins(state);
    expect(again.installed).toEqual([]);
    expect(again.refreshed).toEqual([]);
    expect(fs.statSync(path.join(home, ".claude", "CLAUDE.md")).mtimeMs).toBe(before);
  });

  test("OFF cuts exactly that section and leaves neighbours byte-intact", () => {
    applyBuiltins(resolveCapabilities([bind("builtin/visual", true), bind("builtin/memory", true)], CTX));
    const withBoth = claudeMd();
    expect(withBoth).toContain("/codecast-visual");
    expect(withBoth).toContain("/codecast-memory");

    const out = applyBuiltins(resolveCapabilities([bind("builtin/visual", false), bind("builtin/memory", true)], CTX));
    expect(out.removed).toEqual(["visual"]);
    const after = claudeMd();
    expect(after).not.toContain("/codecast-visual");
    expect(after).toContain("/codecast-memory");
    expect(after).toContain("keep me");
  });

  test("a slug with NO binding is left alone — hand installs are not ours", () => {
    applyBuiltins(resolveCapabilities([bind("builtin/visual", true)], CTX));
    // Now resolve a state that says nothing about visual at all.
    const out = applyBuiltins(resolveCapabilities([bind("builtin/memory", true)], CTX));
    expect(out.removed).toEqual([]);
    expect(claudeMd()).toContain("/codecast-visual");
  });

  test("dry run reports and writes nothing", () => {
    const state = resolveCapabilities([bind("builtin/visual", true)], CTX);
    const out = applyBuiltins(state, true);
    expect(out.installed).toEqual(["visual"]);
    expect(claudeMd()).not.toContain("/codecast-visual");
  });

  test("a builtin slug the catalog does not know is reported, not thrown", () => {
    const state = resolveCapabilities([bind("builtin/does-not-exist", true)], CTX);
    expect(builtinEntries(state)).toHaveLength(1);
    const out = applyBuiltins(state);
    expect(out.unknown).toEqual(["does-not-exist"]);
  });

  test("a project-scoped binding for a repo we are not in does not apply here", () => {
    const state = resolveCapabilities(
      [bind("builtin/visual", true, "project", "git:github.com/other/repo")],
      CTX,
    );
    expect(builtinEntries(state)).toHaveLength(0);
  });
});

describe("reconcileFromHeartbeat", () => {
  const stubFetch = (rows: unknown[]) =>
    (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;

  test("mode off never fetches", async () => {
    recordConvergenceSignals({ capabilities_mode: "off", capability_desired_revision: 9 });
    let fetched = false;
    const out = await reconcileFromHeartbeat({
      siteUrl: "http://x", apiToken: "t", userId: "u1", home,
      log: () => {},
      fetchImpl: (async () => { fetched = true; return new Response("[]"); }) as any,
    });
    expect(out.skipped).toBe("mode_off");
    expect(fetched).toBe(false);
  });

  test("on: fetch, resolve, apply, converge — and the next beat is free", async () => {
    recordConvergenceSignals({ capabilities_mode: "on", capability_desired_revision: 3 });
    const rows = [{ capability_slug: "builtin/visual", scope_kind: "user", scope_key: "", enabled: true, updated_at: 1 }];
    const first = await reconcileFromHeartbeat({
      siteUrl: "http://x", apiToken: "t", userId: "u1", home, log: () => {}, fetchImpl: stubFetch(rows),
    });
    expect(first.ran).toBe(true);
    expect(claudeMd()).toContain("/codecast-visual");
    expect(convergenceState().applied).toBe(3);

    let fetchedAgain = false;
    const second = await reconcileFromHeartbeat({
      siteUrl: "http://x", apiToken: "t", userId: "u1", home, log: () => {},
      fetchImpl: (async () => { fetchedAgain = true; return new Response("[]"); }) as any,
    });
    expect(second.skipped).toBe("revision_current");
    expect(fetchedAgain).toBe(false);
  });

  test("dry: plans and reports, writes nothing, does NOT converge the revision", async () => {
    recordConvergenceSignals({ capabilities_mode: "dry", capability_desired_revision: 3 });
    const rows = [{ capability_slug: "builtin/visual", scope_kind: "user", scope_key: "", enabled: true, updated_at: 1 }];
    const out = await reconcileFromHeartbeat({
      siteUrl: "http://x", apiToken: "t", userId: "u1", home, log: () => {}, fetchImpl: stubFetch(rows),
    });
    expect(out.ran).toBe(true);
    expect(out.wrote).toBe(0);
    expect(claudeMd()).not.toContain("/codecast-visual");
    expect(convergenceState().applied).toBe(0);
  });

  test("a fetch failure skips this beat and leaves the revision behind, so it retries", async () => {
    recordConvergenceSignals({ capabilities_mode: "on", capability_desired_revision: 3 });
    const out = await reconcileFromHeartbeat({
      siteUrl: "http://x", apiToken: "t", userId: "u1", home, log: () => {},
      fetchImpl: (async () => { throw new Error("network"); }) as any,
    });
    expect(out.ran).toBe(false);
    expect(convergenceState().applied).toBe(0);
  });
});
