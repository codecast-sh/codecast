/**
 * The half of `cast computer` that only a granted Mac can prove (A7, ct-49523).
 *
 * Everything here needs Accessibility, and Screen Recording for the capture, on
 * the helper bundle at its FIXED path — the grant is keyed to that path, so this
 * suite deliberately does not isolate `CODECAST_DIR` the way the other e2e
 * suites do. A copy of the bundle somewhere else is a different app to TCC.
 *
 * It self-skips, in three steps, and says which one stopped it:
 *   not macOS -> no helper at the fixed path -> Accessibility not granted.
 *
 * To make it run:
 *   bun scripts/computer-verify.ts build --out /tmp/helper.tar
 *   bun scripts/computer-verify.ts install /tmp/helper.tar
 *   # grant Accessibility and Screen Recording to `codecast computer`
 *   bun test src/computer/granted.e2e.test.ts
 *
 * The target is TextEdit, opened with `open -g` so it never takes the front.
 * That is not incidental: design 11.2 says no verb raises a window except
 * `--restore-window`, and a background window is the only way to prove it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { ComputerClient } from "./client.js";
import { helperExecutablePath, helperAppPath } from "./helperApp.js";
import { rewriteScreenshotForJson } from "./screenshotFile.js";
import { readInstance } from "./instance.js";
import { readState } from "../browser/instance.js";
import { disclaimedHelperLaunch, probeHelperPermissions } from "../test-helpers/computerPermissionProbe.js";
import type { ComputerActionResult, ComputerSnapshotResult } from "./types.js";

const TEXTEDIT = "com.apple.TextEdit";

function helperIsInstalled(): boolean {
  try {
    return process.platform === "darwin" && fs.statSync(helperExecutablePath()).isFile();
  } catch {
    return false;
  }
}

/**
 * Ask before the suite is built, so `test.skip` can carry the real reason.
 *
 * Top-level await rather than `beforeAll`: bun decides at collection time
 * whether a test runs, and a skip that reports "not granted" when the helper is
 * simply missing sends whoever reads it to the wrong place.
 */
const reason = await (async (): Promise<string | null> => {
  if (process.platform !== "darwin") return "not macOS";
  if (!helperIsInstalled()) return `no helper at ${helperAppPath()} — run \`bun scripts/computer-verify.ts install <helper.tar>\``;
  // Not `getPermissionStatus`: from a test its disclaimed spawn cannot even
  // start (ct-49674) and its 5-second poll is shorter than the helper's own
  // answer time (ct-49671), so it reports "not granted" on a granted machine.
  const status = await probeHelperPermissions();
  if (status.accessibility === "no-answer") return "the helper never answered the permission probe";
  if (status.accessibility !== "granted") return "Accessibility is not granted to `codecast computer`";
  return null;
})();

const granted = reason === null ? test : test.skip;
let screenshotsGranted = false;

/**
 * The client, launched the way the CLI launches it but pointed straight at the
 * installed bundle. `defaultHelperLaunch` cannot be used: it insists on the
 * payload EMBEDDED in the running CLI, which a from-source run does not carry,
 * even when a valid helper is installed (ct-49672).
 */
function makeClient(): ComputerClient {
  return new ComputerClient({
    helperLaunch: (socketPath, tokenPath) =>
      disclaimedHelperLaunch(helperExecutablePath(), ["--agent", socketPath, "--token-file", tokenPath]),
  });
}

let client: ComputerClient;
let scratch: string;

/** The frontmost app's bundle id, which is what the focus proof compares. */
function frontApp(): string {
  const asn = spawnSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" }).stdout?.trim() ?? "";
  const info = spawnSync("/usr/bin/lsappinfo", ["info", "-only", "bundleid", asn], { encoding: "utf8" }).stdout ?? "";
  return info.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] ?? asn;
}

/** One element index out of the rendered tree. Lines read `<index> <role> …`,
 *  indented by depth (design 7). */
function findElement(tree: string, match: RegExp): number | null {
  for (const line of tree.split("\n")) {
    const parsed = line.match(/^\s*(\d+)\s+(.*)$/);
    if (parsed && match.test(parsed[2])) return Number(parsed[1]);
  }
  return null;
}

function requireElement(result: ComputerSnapshotResult, match: RegExp, what: string): number {
  const index = findElement(result.snapshot.treeText, match);
  if (index === null) throw new Error(`no ${what} in TextEdit's window. Tree was:\n${result.snapshot.treeText}`);
  return index;
}

const snapshot = () => client.getAppState({ app: TEXTEDIT });

beforeAll(async () => {
  if (reason) {
    console.log(`cast computer granted e2e skipped: ${reason}`);
    return;
  }
  screenshotsGranted = (await probeHelperPermissions()).screenshots === "granted";
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-textedit-"));
  const doc = path.join(scratch, "cast-computer.txt");
  fs.writeFileSync(doc, "seed\n");
  // -g: open it WITHOUT bringing TextEdit to the front. The whole focus proof
  // rests on the target window being in the background.
  spawnSync("/usr/bin/open", ["-g", "-a", "TextEdit", doc], { timeout: 30_000 });
  client = makeClient();
  for (let attempt = 0; attempt < 40; attempt++) {
    const windows = await client.listWindows({ app: TEXTEDIT }).catch(() => null);
    if (windows?.windows.length) return;
    await Bun.sleep(250);
  }
  throw new Error("TextEdit did not open a window");
});

afterAll(async () => {
  if (reason) return;
  // Quit TextEdit without saving, so the run leaves no document and no dialog.
  // `pkill` rather than a Cmd+Q chord: a synthetic quit would need the window
  // focused, which is exactly what this suite spends its time not doing.
  spawnSync("/usr/bin/pkill", ["-x", "TextEdit"], { timeout: 10_000 });
  const state = readInstance();
  await client?.terminate().catch(() => {});
  if (state?.pid) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the observe half", () => {
  granted("get-app-state returns an indexed tree of the background window", async () => {
    const result = await snapshot();
    expect(result.snapshot.app.bundleId).toBe(TEXTEDIT);
    expect(result.snapshot.coordinateSpace).toBe("window");
    expect(result.snapshot.elementCount).toBeGreaterThan(0);
    expect(result.snapshot.treeText.length).toBeGreaterThan(0);
    // Indexes are what every action takes, so the tree has to carry them.
    expect(result.snapshot.treeText).toMatch(/^\s*\d+\s+\S/m);
    expect(result.snapshot.window.width).toBeGreaterThan(0);
  });

  granted("the screenshot lands in a 0600 file, never inline, and its scale maps pixels to points", async () => {
    if (!screenshotsGranted) {
      console.log("granted e2e: Screen Recording is not granted — capture assertions skipped");
      return;
    }
    const raw = await snapshot();
    expect(raw.screenshotStatus.state).toBe("captured");
    const result = rewriteScreenshotForJson(raw);
    const shot = result.screenshot!;

    expect(shot.path).toBeTruthy();
    expect(shot.data).toBeUndefined();
    expect(shot.dataOmitted).toBe(true);
    expect(fs.statSync(shot.path!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(shot.path!)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(shot.path!).size).toBeGreaterThan(0);

    // The formula the snippet teaches: action_x = pixel_x / scale. If it does
    // not hold, every coordinate an agent reads off a screenshot is wrong.
    expect(shot.scale).toBeGreaterThan(0);
    expect(shot.width / shot.scale).toBeCloseTo(result.snapshot.window.width, 0);
    expect(shot.height / shot.scale).toBeCloseTo(result.snapshot.window.height, 0);
  });

  granted("an index from a stale tree is refused rather than acted on", async () => {
    const before = await snapshot();
    const target = requireElement(before, /text/i, "text element");
    // Change the window under the cached snapshot. The next action carrying an
    // index from `before` must be refused, not aimed at whatever now sits there.
    await client.action("setValue", { app: TEXTEDIT, elementIndex: target, value: "changed by the stale-index test" });
    await client.getAppState({ app: TEXTEDIT });

    const stale = before.snapshot.elementCount + 5000;
    await expect(client.action("setValue", { app: TEXTEDIT, elementIndex: stale, value: "should never land" })).rejects.toMatchObject({
      code: "element_not_found",
    });
  });
});

describe("the act half", () => {
  granted("set-value writes a background window and verifies by reading it back", async () => {
    const before = await snapshot();
    const target = requireElement(before, /text/i, "text element");
    const value = `cast computer set-value ${Date.now()}`;

    const result: ComputerActionResult = await client.action("setValue", { app: TEXTEDIT, elementIndex: target, value });
    expect(result.action?.path).toBe("accessibility");
    // The design's whole point about verification: `verified` means the helper
    // read the value back and it matched, not that the write returned.
    expect(result.action?.verification).toMatchObject({ state: "verified", property: "value" });
    expect(result.snapshot.treeText).toContain(value);
  });

  granted("click acts through the accessibility path without asking for focus", async () => {
    const before = await snapshot();
    const target = findElement(before.snapshot.treeText, /Secondary Actions/i) ?? requireElement(before, /text/i, "text element");
    const result = await client.action("click", { app: TEXTEDIT, elementIndex: target });
    expect(result.action?.path).toBe("accessibility");
    expect(result.snapshot.elementCount).toBeGreaterThan(0);
  });

  granted("synthetic input on a background window is refused and names the flag that fixes it", async () => {
    // type-text, press-key and hotkey all need the target window focused
    // (design 11.2 point 1). Refusing is the feature, not a limitation.
    for (const [method, params] of [
      ["typeText", { app: TEXTEDIT, text: "never typed" }],
      ["pressKey", { app: TEXTEDIT, key: "Return" }],
      ["hotkey", { app: TEXTEDIT, key: "CmdOrCtrl+A" }],
    ] as const) {
      const failure = await client.action(method, params).then(
        () => null,
        (err) => err as { code: string; message: string },
      );
      expect(failure, `${method} should refuse a background window`).not.toBeNull();
      expect(failure!.code).toBe("window_not_focused");
      expect(failure!.message).toMatch(/restore-window|restoreWindow/i);
    }
  });
});

describe("focus", () => {
  granted("a whole observe-and-act loop leaves the frontmost app untouched", async () => {
    const before = frontApp();
    expect(before).not.toBe(TEXTEDIT);

    const state = await snapshot();
    const target = requireElement(state, /text/i, "text element");
    await client.action("setValue", { app: TEXTEDIT, elementIndex: target, value: `no raise ${Date.now()}` });
    await client.action("click", { app: TEXTEDIT, elementIndex: target });

    // 400 ms is the helper's own settle after a raise; if a verb raised, the
    // front would have moved by now.
    await Bun.sleep(600);
    expect(frontApp()).toBe(before);
  });

  granted("--restore-window is the one verb that moves the front, and it stamps the sentinel", async () => {
    const before = frontApp();
    const browserStateBefore = readState();

    await client.getAppState({ app: TEXTEDIT, restoreWindow: true });
    await Bun.sleep(600);

    expect(frontApp()).toBe(TEXTEDIT);
    expect(frontApp()).not.toBe(before);

    // The stamp only exists when a managed browser does. With none there is no
    // agent Chrome for the sentinel to bounce, so skipping the write is correct
    // rather than lossy (design 11.2 point 4).
    if (browserStateBefore) {
      const stamp = readState()?.computerRaisedAt ?? 0;
      expect(stamp).toBeGreaterThan(Date.now() - 60_000);
    } else {
      console.log("granted e2e: no browser instance file, so computerRaisedAt is correctly not written");
    }
  });
});
