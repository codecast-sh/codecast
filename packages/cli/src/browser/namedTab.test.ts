/**
 * Named tabs (`--tab <name>`): Task and workflow subagents inherit their
 * parent's harness id, so without a name every worker drove the parent's one
 * tab and navigated the others' pages. A name is a tab of its own that still
 * belongs to the same agent.
 */
import { describe, expect, test } from "bun:test";
import {
  BROWSER_TAB_ENV, engineSession, ownerOfSessionKey, paneSessionKey, realSessionKey, requestTabName, tabNameOf, withTabName,
} from "./engine.js";
import { ownerState, type LiveOwners } from "./engineReap.js";
import { tabHolderIsSelf } from "./pinnedTab.js";
import { splitTargetFlags } from "./bridge/real.js";

const UUID = "0b8f8a8e-0e62-7af0-b709-5958e0b50f38";
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ CLAUDE_CODE_SESSION_ID: UUID, ...extra });

describe("engineSession with a tab name", () => {
  test("a subagent naming a tab gets a key of its own; its parent keeps the plain key", () => {
    const parent = engineSession(undefined, env());
    const worker = engineSession(undefined, env({ [BROWSER_TAB_ENV]: "r2land" }));
    expect(parent).toBe(`env-${UUID}`);
    expect(worker).toBe(`env-${UUID}__r2land`);
    expect(tabNameOf(worker)).toBe("r2land");
    expect(tabNameOf(parent)).toBeNull();
  });

  test("the name survives the real and pane suffixes and the length cap", () => {
    const key = withTabName(`env-${UUID}`, "checkout flow / mobile");
    for (const k of [key, realSessionKey(key), paneSessionKey(key)]) {
      expect(k.length).toBeLessThanOrEqual(60);
      expect(tabNameOf(k)).toBe(tabNameOf(key));
      expect(ownerOfSessionKey(k)).toBe(`env-${UUID}`);
    }
    // Two long names that share a prefix stay two tabs.
    expect(withTabName(`env-${UUID}`, "checkout-flow-desktop")).not.toBe(withTabName(`env-${UUID}`, "checkout-flow-mobile"));
  });

  test("a name of only punctuation is no name", () => {
    expect(withTabName("default", "///")).toBe("default");
  });
});

describe("requestTabName", () => {
  test("sets the name for the rest of the process", () => {
    const e: NodeJS.ProcessEnv = {};
    requestTabName("docs", e);
    expect(e[BROWSER_TAB_ENV]).toBe("docs");
  });

  test("refuses an existing tab's id, which the old driver's --tab meant", () => {
    for (const id of ["39A2B0CB", "t2", "4F2F46289BE9FEF4C1DD358BF3A9E7F2"]) {
      expect(() => requestTabName(id, {})).toThrow(/tab switch/);
    }
  });

  test("splitTargetFlags takes --tab and the engine's --session out of a passthrough's arguments", () => {
    const saved = process.env[BROWSER_TAB_ENV];
    try {
      expect(splitTargetFlags(["--tab", "a", "https://x.test"]).args).toEqual(["https://x.test"]);
      expect(process.env[BROWSER_TAB_ENV]).toBe("a");
      expect(splitTargetFlags(["--session=b", "#e1"]).args).toEqual(["#e1"]);
      expect(process.env[BROWSER_TAB_ENV]).toBe("b");
    } finally {
      if (saved === undefined) delete process.env[BROWSER_TAB_ENV];
      else process.env[BROWSER_TAB_ENV] = saved;
    }
  });
});

describe("a named tab's owner", () => {
  const live: LiveOwners = { panes: null, session: (id) => (id === UUID ? "live" : "unverifiable") };

  test("lives as long as its agent, so the reaper keeps it", () => {
    expect(ownerState(realSessionKey(`env-${UUID}__r2land`), live)).toBe("live");
    expect(ownerState(`env-${UUID}__r2land`, live)).toBe("live");
  });

  test("never claims the parent's or a sibling's tab as its own", () => {
    const worker = `env-${UUID}__a-real`;
    expect(tabHolderIsSelf(`env-${UUID}-real`, worker, env())).toBe(false);
    expect(tabHolderIsSelf(`env-${UUID}__b-real`, worker, env())).toBe(false);
    expect(tabHolderIsSelf(`env-${UUID}__a`, worker, env())).toBe(true);
    // The parent does not take a worker's tab either.
    expect(tabHolderIsSelf(worker, `env-${UUID}-real`, env())).toBe(false);
  });
});
