/**
 * Automatic screenshots: which verbs fire one, and when dedupe suppresses it.
 *
 * The classification matters because a wrong "mutating" verdict spams the
 * thread with identical pictures, and a wrong "read-only" verdict loses the
 * one capture that documented a page change. The dedupe store matters because
 * every `cast` invocation is a fresh process — it only works if it survives on
 * disk.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autoShotsEnabled, clearAutoShots, isMutatingStep, maybeAutoShot, pruneHashes, recordIfChanged, setAutoShots } from "./autoShot.js";
import { readSharedConfig } from "../config/sharedConfig.js";
import { runBatch, type BatchContext } from "./batch.js";
import type { PageSession } from "./instance.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoshot-test-"));

describe("isMutatingStep", () => {
  test("navigation and input verbs fire a shot", () => {
    for (const v of ["open", "goto", "back", "forward", "reload", "click", "click-at", "press", "select", "upload"]) {
      expect(isMutatingStep(v)).toBe(true);
    }
  });

  test("read-only verbs never fire", () => {
    for (const v of ["snapshot", "snap", "text", "find", "console", "network", "tabs", "eval", "shot", "screenshot", "wait", "hover", "focus", "scroll", "viewport", "dialogs", "status"]) {
      expect(isMutatingStep(v)).toBe(false);
    }
  });

  test("type fires only when it submits", () => {
    // Keystrokes are mid-flow; the page that matters is the one submit produces.
    expect(isMutatingStep("type", ["type", "#e7", "hello"])).toBe(false);
    expect(isMutatingStep("type", ["type", "#e7", "hello", "--submit"])).toBe(true);
  });
});

describe("recordIfChanged", () => {
  test("first capture of a tab always emits", () => {
    expect(recordIfChanged("tab1", "aaa", tmp())).toBe(true);
  });

  test("an unchanged page is suppressed, a changed one emits again", () => {
    const dir = tmp();
    expect(recordIfChanged("tab1", "aaa", dir)).toBe(true);
    expect(recordIfChanged("tab1", "aaa", dir)).toBe(false);
    expect(recordIfChanged("tab1", "bbb", dir)).toBe(true);
    // Going back to a previously seen state is still a visible change.
    expect(recordIfChanged("tab1", "aaa", dir)).toBe(true);
  });

  test("tabs dedupe independently", () => {
    const dir = tmp();
    expect(recordIfChanged("tab1", "aaa", dir)).toBe(true);
    expect(recordIfChanged("tab2", "aaa", dir)).toBe(true);
  });

  test("the store survives across processes", () => {
    // Simulated by hitting the same directory twice — each CLI invocation
    // reads the file cold exactly like this.
    const dir = tmp();
    recordIfChanged("tab1", "aaa", dir);
    expect(recordIfChanged("tab1", "aaa", dir)).toBe(false);
  });

  test("a corrupt store is treated as empty, not an error", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "auto-shots.json"), "{nope");
    expect(recordIfChanged("tab1", "aaa", dir)).toBe(true);
  });

  test("pruneHashes drops closed tabs and keeps live ones", () => {
    const dir = tmp();
    recordIfChanged("live", "aaa", dir);
    recordIfChanged("gone", "bbb", dir);
    pruneHashes(new Set(["live"]), dir);
    expect(recordIfChanged("live", "aaa", dir)).toBe(false);
    expect(recordIfChanged("gone", "bbb", dir)).toBe(true);
  });
});

describe("auto-shots setting", () => {
  test("unset defaults by audience: on at a terminal, off for agent sessions", () => {
    expect(autoShotsEnabled(tmp(), false)).toBe(true);
    expect(autoShotsEnabled(tmp(), true)).toBe(false);
  });

  test("explicit config overrides the audience default in both directions", () => {
    const dir = tmp();
    setAutoShots(false, dir);
    expect(autoShotsEnabled(dir, false)).toBe(false);
    setAutoShots(true, dir);
    expect(autoShotsEnabled(dir, true)).toBe(true);
  });

  test("clearing the override returns to the audience default", () => {
    const dir = tmp();
    setAutoShots(true, dir);
    clearAutoShots(dir);
    expect(autoShotsEnabled(dir, true)).toBe(false);
    expect(autoShotsEnabled(dir, false)).toBe(true);
  });

  test("toggling preserves every other field of the shared config", () => {
    // config.json has many writers; this one owns exactly browser.auto_shots.
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ auth_token: "enc:secret", vaults: [{ id: "v" }] }),
    );
    setAutoShots(false, dir);
    const after = readSharedConfig(dir) as any;
    expect(after.auth_token).toBe("enc:secret");
    expect(after.vaults).toEqual([{ id: "v" }]);
    expect(after.browser.auto_shots).toBe(false);
  });
});

describe("maybeAutoShot (engine-agnostic seam)", () => {
  // The seam is bytes + a tab key, nothing CDP-specific: any browser engine
  // that can hand back a small JPEG gets identical dedupe and opt-out policy.
  const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, n)]);

  test("writes a file on the first capture and suppresses an identical one", async () => {
    // Pin the setting on: the test process runs under an agent env, where the
    // audience default is off (autoShotsEnabled).
    process.env.CODECAST_DIR = tmp();
    setAutoShots(true, process.env.CODECAST_DIR);
    const src = { tabKey: `engine-tab-${Date.now()}`, capture: async () => jpeg(1) };
    const first = await maybeAutoShot(src);
    expect(first && fs.existsSync(first)).toBe(true);
    expect(await maybeAutoShot(src)).toBeNull();
    expect(await maybeAutoShot({ ...src, capture: async () => jpeg(2) })).not.toBeNull();
    delete process.env.CODECAST_DIR;
  });

  test("--no-shot short-circuits before capture", async () => {
    let captured = false;
    const out = await maybeAutoShot({ tabKey: "t", capture: async () => { captured = true; return jpeg(1); } }, false);
    expect(out).toBeNull();
    expect(captured).toBe(false);
  });

  test("a failing capture is silent, never a thrown error", async () => {
    process.env.CODECAST_DIR = tmp();
    setAutoShots(true, process.env.CODECAST_DIR);
    const out = await maybeAutoShot({ tabKey: "t", capture: async () => { throw new Error("engine gone"); } });
    expect(out).toBeNull();
    delete process.env.CODECAST_DIR;
  });
});

describe("auto shots in a batch", () => {
  function ctx(overrides: Partial<BatchContext> = {}): BatchContext {
    const page = {
      sessionId: "s",
      targetId: "t",
      conn: { send: async () => ({ result: { value: JSON.stringify(["complete", 0]) } }) },
    } as unknown as PageSession;
    return { page, shots: [], capture: async () => "/tmp/shot.png", navigate: async (u) => `went to ${u}`, ...overrides };
  }

  test("fires after page-changing steps, not after reads", async () => {
    let fired = 0;
    const c = ctx({ autoShot: async () => void fired++ });
    await runBatch(c, ["open a.test", "text", "open b.test"]);
    expect(fired).toBe(2);
  });

  test("does not fire after a failed step", async () => {
    // The page a failed click left behind is not the page the step promised.
    let fired = 0;
    const c = ctx({ autoShot: async () => void fired++ });
    await runBatch(c, ['click "not a ref"']);
    expect(fired).toBe(0);
  });

  test("absent hook means no auto shots and no errors", async () => {
    const r = await runBatch(ctx(), ["open a.test"]);
    expect(r[0].ok).toBe(true);
  });
});
