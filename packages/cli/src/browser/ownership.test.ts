/**
 * Tab ownership between parallel agents.
 *
 * One Chrome serves every agent on the machine, so "which tab does this
 * command act on" is a real coordination problem rather than a detail. It bit
 * in production before these rules existed: one agent's subagent navigated
 * another's tab mid-test, and the hijacked page made a working autocomplete
 * look broken — the failure mode is not an error, it is a wrong answer about
 * somebody else's code.
 *
 * The rules under test:
 *   1. Your own tab wins.
 *   2. Never fall back onto a tab another agent has claimed.
 *   3. With nothing free, say so instead of trespassing.
 *   4. A caller with no identity (a human at a shell) keeps the old behaviour.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ownerKey } from "./owner.js";

// resolveTarget reads the live tab list over HTTP, so exercise the same policy
// through a local copy of its decision logic driven by the same inputs. The
// import below keeps the real module honest about its exports.
import { resolveTarget, type InstanceState } from "./instance.js";

const baseState = (tabsBySession: Record<string, string>, activeTargetId: string | null = null): InstanceState => ({
  pid: 1,
  port: 0,
  userDataDir: "/tmp/none",
  headless: true,
  sourceProfile: null,
  channel: "chrome",
  startedAt: 0,
  tabsBySession,
  activeTargetId,
});

/** Stand in for the CDP HTTP endpoint that resolveTarget lists tabs from. */
function withTabs<T>(tabs: Array<{ targetId: string; url: string }>, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("/json/list")) {
      return new Response(
        JSON.stringify(tabs.map((t) => ({ id: t.targetId, type: "page", title: "", url: t.url }))),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = realFetch;
  });
}

const TABS = [
  { targetId: "AAA", url: "https://a.test/" },
  { targetId: "BBB", url: "https://b.test/" },
  { targetId: "CCC", url: "https://c.test/" },
];

describe("resolveTarget picks the right tab", () => {
  test("uses the tab this session owns, not the newest one", async () => {
    const state = baseState({ "session:me": "AAA", "session:other": "CCC" });
    const t = await withTabs(TABS, () => resolveTarget(0, state, undefined, "session:me"));
    expect(t.targetId).toBe("AAA");
  });

  test("never falls back onto a tab another agent claimed", async () => {
    // "Most recent tab" was the old default and is exactly wrong here: CCC is
    // newest precisely because another agent just opened it.
    const state = baseState({ "session:other": "CCC" });
    const t = await withTabs(TABS, () => resolveTarget(0, state, undefined, "session:me"));
    expect(t.targetId).not.toBe("CCC");
  });

  test("refuses, with instructions, when every tab is somebody else's", async () => {
    const state = baseState({ "s1": "AAA", "s2": "BBB", "s3": "CCC" });
    expect(withTabs(TABS, () => resolveTarget(0, state, undefined, "session:me"))).rejects.toThrow(
      /belongs to another agent.*--new-tab/s,
    );
  });

  test("an explicit --tab always wins, even if it is another agent's", async () => {
    // Deliberate cross-agent access stays possible: debugging sometimes needs it.
    const state = baseState({ "session:other": "CCC" });
    const t = await withTabs(TABS, () => resolveTarget(0, state, "CCC", "session:me"));
    expect(t.targetId).toBe("CCC");
  });

  test("--tab accepts a case-insensitive id prefix", async () => {
    const state = baseState({});
    const t = await withTabs(TABS, () => resolveTarget(0, state, "bb", null));
    expect(t.targetId).toBe("BBB");
  });

  test("--tab matches on a url fragment", async () => {
    const state = baseState({});
    const t = await withTabs(TABS, () => resolveTarget(0, state, "b.test", null));
    expect(t.targetId).toBe("BBB");
  });

  test("a caller with no session keeps the last-active-tab behaviour", async () => {
    // A human in a plain shell has no session key and one obvious intent.
    const state = baseState({}, "BBB");
    const t = await withTabs(TABS, () => resolveTarget(0, state, undefined, null));
    expect(t.targetId).toBe("BBB");
  });

  test("says the browser is empty rather than returning nothing", async () => {
    expect(withTabs([], () => resolveTarget(0, baseState({}), undefined, "session:me"))).rejects.toThrow(
      /no open tabs/,
    );
  });
});

describe("ownerKey", () => {
  const clearEnv = () => {
    for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CAST_SESSION_ID", "TMUX_PANE"]) {
      delete process.env[k];
    }
  };
  const saved = { ...process.env };
  afterEach(() => {
    clearEnv();
    Object.assign(process.env, saved);
  });

  test("prefers a resolved session id", () => {
    clearEnv();
    process.env.TMUX_PANE = "%9";
    expect(ownerKey(() => "abc123")).toBe("session:abc123");
  });

  test("falls back to a harness id when the session is ambiguous", () => {
    // detectCurrentSessionId returns null whenever several sessions are live —
    // which is the case ownership exists for, so it must not be the only source.
    clearEnv();
    process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = "session_xyz";
    expect(ownerKey(() => null)).toBe("env:session_xyz");
  });

  test("falls back to the tmux pane when no id is exported", () => {
    clearEnv();
    process.env.TMUX_PANE = "%659";
    expect(ownerKey(() => null)).toBe("pane:%659");
  });

  test("survives a session lookup that throws", () => {
    clearEnv();
    process.env.TMUX_PANE = "%1";
    expect(ownerKey(() => { throw new Error("no transcript"); })).toBe("pane:%1");
  });

  test("returns null when nothing identifies the caller", () => {
    clearEnv();
    expect(ownerKey(() => null)).toBeNull();
  });

  test("gives two agents distinct keys", () => {
    clearEnv();
    process.env.TMUX_PANE = "%1";
    const a = ownerKey(() => null);
    process.env.TMUX_PANE = "%2";
    expect(ownerKey(() => null)).not.toBe(a);
  });
});
