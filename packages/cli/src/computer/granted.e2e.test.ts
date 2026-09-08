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
import { acquireFileLock } from "../lockFile.js";
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
/**
 * Whether the capture assertions can run. Set by the SAME probe that decides
 * `reason`: the probe costs about four seconds, which is most of a hook's
 * budget, and asking twice for one answer is what made `beforeAll` time out.
 */
let screenshotsGranted = false;

const reason = await (async (): Promise<string | null> => {
  if (process.platform !== "darwin") return "not macOS";
  if (!helperIsInstalled()) return `no helper at ${helperAppPath()} — run \`bun scripts/computer-verify.ts install <helper.tar>\``;
  // Not `getPermissionStatus`: from a test its disclaimed spawn cannot even
  // start (ct-49674) and its 5-second poll is shorter than the helper's own
  // answer time (ct-49671), so it reports "not granted" on a granted machine.
  const status = await probeHelperPermissions();
  screenshotsGranted = status.screenshots === "granted";
  if (status.accessibility === "no-answer") return "the helper never answered the permission probe";
  if (status.accessibility !== "granted") return "Accessibility is not granted to `codecast computer`";
  return null;
})();

/**
 * Every case here is several round trips to a real helper driving a real app,
 * and one snapshot alone runs to a second or two. bun's default per-test budget
 * is 5s, which these outgrow — and a case cut off mid-request leaves the helper
 * killed as a dangling process, so the FIRST timeout turns every later case
 * into `permission_denied` from a reconnect that never re-handshakes. One
 * honest budget at the wrapper keeps that cascade from starting.
 */
const CASE_TIMEOUT_MS = 60_000;
const runCase = reason === null ? test : test.skip;
const granted = (name: string, fn: () => Promise<void>): void => {
  runCase(name, fn, CASE_TIMEOUT_MS);
};

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

/**
 * One TextEdit, one Mac. This suite drives a shared application BY NAME and its
 * teardown kills it the same way, so two runs on one machine wreck each other:
 * the second run's `pkill` takes the first run's target away mid-case, and the
 * first then reports `window_not_found` and `app_not_found` against a product
 * that is working. That is not hypothetical — a sibling worktree running these
 * same tests produced exactly that, and it is why the failing set kept moving
 * between runs. Runs therefore queue rather than race.
 *
 * The lock sits in the machine's temp dir, not under the checkout: the thing
 * being shared is the Mac, and the racing runs live in different worktrees.
 */
const RUN_LOCK = path.join(os.tmpdir(), "cast-computer-granted-e2e.lock");
let releaseRunLock: (() => void) | null = null;

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

const windowIds = async (): Promise<Set<number>> =>
  new Set((await client.listWindows({ app: TEXTEDIT })).windows.flatMap((w) => (typeof w.id === "number" ? [w.id] : [])));

/** Poll TextEdit's window list until `want` says yes, or give up loudly. */
async function untilWindows(want: (ids: Set<number>) => boolean, what: string): Promise<Set<number>> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const ids = await windowIds();
    if (want(ids)) return ids;
    await Bun.sleep(250);
  }
  throw new Error(`TextEdit never ${what}`);
}

beforeAll(async () => {
  if (reason) {
    console.log(`cast computer granted e2e skipped: ${reason}`);
    return;
  }
  screenshotsGranted = (await probeHelperPermissions()).screenshots === "granted";
  releaseRunLock = await acquireFileLock(RUN_LOCK, {
    waitMs: 240_000,
    staleMs: 300_000,
    describe: "the cast computer granted e2e",
    onWait: (holder) => console.log(`granted e2e: another run holds the Mac (pid ${holder}) — queueing behind it`),
  });
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
  // The budget covers queueing for the run lock above (up to 240s) plus a cold
  // TextEdit; bun's default hook timeout is 5s, which neither fits in.
}, 300_000);

afterAll(async () => {
  if (reason) {
    releaseRunLock?.();
    releaseRunLock = null;
    return;
  }
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
  releaseRunLock?.();
  releaseRunLock = null;
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

  granted("click presses a control through the accessibility path, with no focus and no coordinates", async () => {
    // The target has to be something that actually presses. This case first
    // aimed at whatever tree line said "Secondary Actions", which in TextEdit
    // is the scroll area ("scroll up, scroll down") — and a scroll area has no
    // AXPress, so `click` fell through to a coordinate click and was correctly
    // refused for want of focus. Measured on a granted Mac; the product was
    // right and the target was wrong.
    //
    // A close button on a document this case opens and never edits is the
    // honest target: it presses, it needs no focus, and the press has a visible
    // result, so "the accessibility path worked" is observed rather than
    // inferred from a returned string. An unmodified document closes without a
    // save sheet, so nothing is left on screen.
    const before = await windowIds();
    const doc = path.join(scratch, "cast-computer-click.txt");
    // Deliberately says nothing about what this case looks for: the rendered
    // tree carries element VALUES as well as roles, so a document whose text
    // named the control would be matched by the matcher below (it was, and the
    // case aimed `click` at the text area instead of the button).
    fs.writeFileSync(doc, "a second document, opened and never edited\n");
    spawnSync("/usr/bin/open", ["-g", "-a", "TextEdit", doc], { timeout: 30_000 });
    const opened = await untilWindows((ids) => [...ids].some((id) => !before.has(id)), "opened a second window");
    const target = [...opened].find((id) => !before.has(id))!;

    const front = frontApp();
    const state = await client.getAppState({ app: TEXTEDIT, windowId: target });
    // Anchored: a role at the START of the rendered line, never a phrase from
    // some element's value further along it.
    const closeButton = requireElement(state, /^close button\b/i, "close button");
    const result = await client.action("click", { app: TEXTEDIT, elementIndex: closeButton, windowId: target });

    expect(result.action?.path).toBe("accessibility");
    expect(result.action?.actionName).toBe("AXPress");
    // Pressing a control is not a reason to raise anything (design 11.2).
    expect(frontApp()).toBe(front);
    await untilWindows((ids) => !ids.has(target), "closed the window whose close button was pressed");
  });

  granted("synthetic input is refused on a background window, and the accessibility route is taken where one exists", async () => {
    // The rule in design 11.2 point 1 is about SYNTHETIC input, and the design's
    // own verification table says two of these three verbs have an accessibility
    // route: text replacement is `verified` with `focusedText`, and a select all
    // chord is `verified` with `selection`. Measured on a granted Mac, that is
    // exactly what the helper does, so asserting that all three are refused
    // asserted a contract the design never had.
    //
    // press-key is the one with no accessibility route, so it is what proves
    // the refusal — and the refusal is the safety property: a keystroke with no
    // named recipient must never be delivered blind to whatever holds focus.
    // Observe first. The case before this one closes a window, and the helper
    // answers an index from a superseded tree with `window_stale` rather than
    // acting on whatever now sits there — correctly, but it is not what this
    // case is about. Snapshot-then-act is the model the design teaches anyway.
    await snapshot();
    const refused = await client.action("pressKey", { app: TEXTEDIT, key: "Return" }).then(
      () => null,
      (err) => err as { code: string; message: string },
    );
    expect(refused, "press-key should refuse a background window").not.toBeNull();
    expect(refused!.code).toBe("window_not_focused");
    expect(refused!.message).toMatch(/restore-window|restoreWindow/i);

    // The other two need no focus, because they name the element they act on.
    const typed = await client.action("typeText", { app: TEXTEDIT, text: `typed without focus ${Date.now()}` });
    expect(typed.action?.path).toBe("accessibility");
    expect(typed.action?.actionName).toBe("AXReplaceSelection");
    expect(typed.action?.verification?.state).toBe("verified");

    const selected = await client.action("hotkey", { app: TEXTEDIT, key: "CmdOrCtrl+A" });
    expect(selected.action?.path).toBe("accessibility");
    expect(selected.action?.verification?.state).toBe("verified");
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
    // A second act, through a different verb. Deliberately NOT `click` on the
    // text area — a text area has no AXPress, so that click fell through to a
    // coordinate click and was refused for want of focus, which says nothing
    // about raising. `type-text` takes the accessibility route on a background
    // window (proven in the act half), so it exercises a second verb here
    // without smuggling in a focus requirement this case is not about.
    await client.action("typeText", { app: TEXTEDIT, text: " and still no raise" });

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
